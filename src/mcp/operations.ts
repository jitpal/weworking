/**
 * The six operations, defined once for both front doors.
 *
 * Each `run*` function does exactly three things: translate the `snake_case` request
 * into the service's `camelCase` arguments, call the one service method, and shape the
 * answer into `{ structured, text }` — the `structuredContent` / JSON body, and the
 * one-line human summary MCP puts in `content[0].text`.
 *
 * `src/mcp/tools.ts` wraps these for MCP, `src/http/api.ts` for REST. Because both go
 * through here, a REST response and an MCP `structuredContent` are byte-identical, and
 * the scope checks cannot diverge either.
 *
 * Arrays are wrapped in a named key (`{ locations: [...] }`, `{ results: [...] }`,
 * `{ bookings: [...] }`): MCP requires `structuredContent` to be a JSON *object*, and
 * docs/API.md documents the same wrappers for REST.
 */

import type { BookingServiceImpl, SearchArgs, WhoamiResultWithCaps } from "../core/booking-service";
import { base64UrlDecode } from "../core/quote";
import { isoUtc } from "../core/time";
import type {
  Actor,
  AvailabilityResult,
  Booking,
  CancelBookingResult,
  CapsRemaining,
  CreateBookingResult,
  ListBookingsArgs,
  ListLocationsArgs,
  Location,
  QuotePayload,
  SearchAvailabilityArgs,
} from "../core/types";
import type {
  CancelBookingInput,
  CreateBookingInput,
  ListBookingsInput,
  ListLocationsInput,
  SearchAvailabilityInput,
} from "./schemas";
import { requireScope } from "./scope";

/** What every operation returns: the machine answer and the sentence to read aloud. */
export interface OperationResult<T> {
  /** Goes out as MCP `structuredContent` and as the REST JSON body, unchanged. */
  structured: T;
  /** Goes out as MCP `content[0].text`. Always mentions credits and local times. */
  text: string;
}

/* -------------------------------------------------------------------------- */
/* whoami                                                                      */
/* -------------------------------------------------------------------------- */

export async function runWhoami(
  service: BookingServiceImpl,
  actor: Actor,
): Promise<OperationResult<WhoamiResultWithCaps>> {
  const result = await service.whoami(actor);
  return { structured: result, text: summariseWhoami(result) };
}

function summariseWhoami(result: WhoamiResultWithCaps): string {
  const who =
    result.profile.name || result.profile.email || result.profile.userId || "unknown user";
  const credits = result.credits
    ? `${result.credits.remaining} of ${result.credits.total} credits left (period ends ${result.credits.periodEnd})`
    : "credit balance unavailable";
  const session =
    result.session.state === "valid" || result.session.state === "expiring"
      ? `WeWork session ${result.session.state}`
      : `WeWork session ${result.session.state} — reconnect before booking`;
  const writes = result.writeEnabled
    ? `writes enabled; ${result.capsRemaining.day} booking(s) left today, ${result.capsRemaining.week} this week`
    : "writes disabled on this deployment";
  return `${who}: ${session}. ${credits}. Scopes ${result.actor.scopes.join(", ") || "none"}; ${writes}.`;
}

/* -------------------------------------------------------------------------- */
/* list_locations                                                              */
/* -------------------------------------------------------------------------- */

export async function runListLocations(
  service: BookingServiceImpl,
  input: ListLocationsInput,
): Promise<OperationResult<{ locations: Location[] }>> {
  const args: ListLocationsArgs = {};
  if (input.query !== undefined) args.query = input.query;
  if (input.city !== undefined) args.city = input.city;
  if (input.lat !== undefined) args.lat = input.lat;
  if (input.lng !== undefined) args.lng = input.lng;
  if (input.radius_km !== undefined) args.radiusKm = input.radius_km;
  if (input.limit !== undefined) args.limit = input.limit;

  const locations = await service.listLocations(args);
  const text =
    locations.length === 0
      ? "No WeWork buildings matched."
      : `${locations.length} building(s): ${locations
          .map((location) => `${location.name} (${location.city})`)
          .join("; ")}`;
  return { structured: { locations }, text };
}

/* -------------------------------------------------------------------------- */
/* search_availability                                                         */
/* -------------------------------------------------------------------------- */

export async function runSearchAvailability(
  service: BookingServiceImpl,
  input: SearchAvailabilityInput,
): Promise<OperationResult<{ results: AvailabilityResult[]; quoteExpiresAt?: string }>> {
  const args: SearchArgs = { date: input.date };
  if (input.location_id !== undefined) args.locationId = input.location_id;
  if (input.city !== undefined) args.city = input.city;
  if (input.start_time !== undefined) args.startTime = input.start_time;
  if (input.end_time !== undefined) args.endTime = input.end_time;
  if (input.space_type !== undefined) {
    args.spaceType = input.space_type as SearchAvailabilityArgs["spaceType"];
  }
  if (input.capacity !== undefined) args.capacity = input.capacity;
  if (input.limit !== undefined) args.limit = input.limit;

  const results = await service.searchAvailability(args);
  const quoteExpiresAt = quoteExpiry(results);
  const structured: { results: AvailabilityResult[]; quoteExpiresAt?: string; note?: string } = {
    results,
  };
  if (quoteExpiresAt) structured.quoteExpiresAt = quoteExpiresAt;
  // Live-verified: WeWork answers with an empty list (totalCount 0) for buildings
  // where this membership cannot book a shared desk, not with an error. Say so, or
  // an agent will keep retrying dates.
  const emptyNote = `WeWork listed no bookable shared desks for this account at the requested building(s) on ${input.date}. That usually means the membership cannot book there (pay-as-you-go accounts are often limited to certain regions) rather than that the desks are full. Try a different building or city before trying other dates.`;
  if (results.length === 0) structured.note = emptyNote;

  const text =
    results.length === 0
      ? emptyNote
      : [
          `${results.length} option(s) on ${input.date}; confirm one with the user before booking.`,
          ...results.map((result, index) => `${index + 1}. ${result.summary}`),
          quoteExpiresAt ? `Quotes expire at ${quoteExpiresAt}.` : "",
        ]
          .filter(Boolean)
          .join("\n");
  return { structured, text };
}

/**
 * When the quotes in a result set expire.
 *
 * Read straight out of the first quote's payload: it is our own signed token, the `exp`
 * claim is the authority on the deadline, and every quote in one search shares it.
 * Reading it back (rather than recomputing `now + ttl`) keeps the two in step.
 */
function quoteExpiry(results: AvailabilityResult[]): string | undefined {
  const first = results[0];
  if (!first) return undefined;
  try {
    const payloadB64 = first.quote.split(".")[0];
    if (!payloadB64) return undefined;
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64)),
    ) as QuotePayload;
    return typeof payload.exp === "number" ? isoUtc(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* create_booking                                                              */
/* -------------------------------------------------------------------------- */

export async function runCreateBooking(
  service: BookingServiceImpl,
  input: CreateBookingInput,
  actor: Actor,
): Promise<OperationResult<CreateBookingResult>> {
  requireScope(actor, "write");
  const args = { quote: input.quote } as {
    quote: string;
    idempotencyKey?: string;
    dryRun?: boolean;
    note?: string;
  };
  if (input.idempotency_key !== undefined) args.idempotencyKey = input.idempotency_key;
  if (input.dry_run !== undefined) args.dryRun = input.dry_run;
  if (input.note !== undefined) args.note = input.note;

  const result = await service.createBooking(args, actor);
  return { structured: result, text: `${result.summary} ${capsSentence(result.capsRemaining)}` };
}

function capsSentence(caps: CapsRemaining): string {
  return `Remaining allowance: ${caps.day} today, ${caps.week} this week.`;
}

/* -------------------------------------------------------------------------- */
/* list_bookings                                                               */
/* -------------------------------------------------------------------------- */

export async function runListBookings(
  service: BookingServiceImpl,
  input: ListBookingsInput,
): Promise<OperationResult<{ bookings: Booking[] }>> {
  const args: ListBookingsArgs = {};
  if (input.from !== undefined) args.from = input.from;
  if (input.to !== undefined) args.to = input.to;
  if (input.include_past !== undefined) args.includePast = input.include_past;

  const bookings = await service.listBookings(args);
  const text =
    bookings.length === 0
      ? "No bookings in that range."
      : `${bookings.length} booking(s): ${bookings
          .map(
            (booking) =>
              `${booking.bookingId} — ${booking.locationName} ${booking.date} ${timeOf(booking.startLocal)}-${timeOf(booking.endLocal)} (${booking.timezone}), ${booking.credits} credit(s), ${booking.status}`,
          )
          .join("; ")}`;
  return { structured: { bookings }, text };
}

/** `"2026-09-21T09:00:00"` -> `"09:00"`. Local wall clock, never reparsed as an instant. */
function timeOf(localWallClock: string): string {
  return localWallClock.slice(11, 16);
}

/* -------------------------------------------------------------------------- */
/* cancel_booking                                                              */
/* -------------------------------------------------------------------------- */

export async function runCancelBooking(
  service: BookingServiceImpl,
  input: CancelBookingInput,
  actor: Actor,
): Promise<OperationResult<CancelBookingResult>> {
  requireScope(actor, "write");
  const args = { bookingId: input.booking_id } as {
    bookingId: string;
    idempotencyKey?: string;
    dryRun?: boolean;
  };
  if (input.idempotency_key !== undefined) args.idempotencyKey = input.idempotency_key;
  if (input.dry_run !== undefined) args.dryRun = input.dry_run;

  const result = await service.cancelBooking(args, actor);
  return { structured: result, text: result.summary };
}
