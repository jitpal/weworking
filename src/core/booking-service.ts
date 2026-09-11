/**
 * The booking service — the one place business rules live.
 *
 * Both front doors (MCP tools in `src/mcp/tools.ts`, REST routes in
 * `src/http/api.ts`) are thin: they parse arguments, call one method here, and
 * serialise the result. Everything that makes this safe to hand an LLM is in this
 * file:
 *
 * - **Quotes, not parameters.** A search signs one quote per bookable slot; booking
 *   accepts nothing else. An agent cannot invent a slot, move a window or change a
 *   price (`src/core/quote.ts`).
 * - **Price re-check at booking time.** The authoritative `creditRatio` comes from
 *   `api.quote()` immediately before `api.book()`. If the price moved at all from the
 *   signed quote, the booking is refused rather than silently spending more credits.
 * - **Caps before upstream.** `session.reserveBooking()` takes the day/week slot
 *   *before* the upstream call and `releaseBooking()` gives it back on any failure,
 *   so a crashed booking never burns a cap.
 * - **Idempotency.** A replay with the same key (or the same quote, when the caller
 *   gave no key) returns the stored result instead of booking twice.
 * - **Audit.** Every write attempt is recorded in the Durable Object, outcome and all.
 *
 * Every failure is an {@link ../errors!AppError} with a `hint` written for an agent.
 */

import { AppError, isAppError } from "../errors";
import { sha256Hex, signQuote, verifyQuote } from "./quote";
import {
  addDays,
  assertDate,
  assertTime,
  ceilTo30,
  compareDates,
  floorTo30,
  formatLocalRange,
  isoUtc,
  localToUtcMs,
  localWallClock,
  offsetString,
  todayIn,
  utcToLocal,
} from "./time";
import type {
  Actor,
  AvailabilityResult,
  Booking,
  BookingService,
  CancelBookingArgs,
  CancelBookingResult,
  CapsRemaining,
  Config,
  CreateBookingArgs,
  CreateBookingResult,
  Credits,
  ListBookingsArgs,
  ListLocationsArgs,
  Location,
  Profile,
  QuotePayload,
  SearchAvailabilityArgs,
  SessionInfo,
  SpaceAvailability,
  SpaceType,
  WhoamiResult,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Collaborator contracts                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The upstream surface this service consumes — build spec §11.1, owned by the WeWork
 * engineer (`src/wework/client.ts`).
 *
 * It is declared here rather than imported so the core layer has **no dependency on
 * the transport layer**: `WeWorkClient` satisfies it structurally, and tests pass a
 * plain object. When `src/wework/client.ts` lands, its own `WeWorkApi` is the same
 * shape and assignable to this one; if the two ever drift, the mismatch shows up as a
 * type error at the injection site in `src/index.ts` rather than at runtime.
 */
export interface WeWorkApi {
  listCities(): Promise<string[]>;
  listLocationsByCity(city: string): Promise<Location[]>;
  listLocationsByGeo(args: { lat: number; lng: number; radiusKm?: number }): Promise<Location[]>;
  getProfile(): Promise<Profile>;
  getMonthlyCredits(now?: Date): Promise<Credits | undefined>;
  getSpaces(args: {
    locationIds: string[];
    date: string;
    spaceType?: SpaceType;
    capacity?: number;
  }): Promise<SpaceAvailability[]>;
  resolveBookingSpaceId(space: SpaceAvailability): Promise<string>;
  quote(q: QuotePayload): Promise<{
    credits: number;
    creditRatio: number;
    amount?: number;
    currency?: string;
  }>;
  book(
    q: QuotePayload,
    creditRatio: number,
  ): Promise<{
    reservationId: string;
    status: string;
    raw?: unknown;
  }>;
  listBookings(args: { from?: string; to?: string; includePast?: boolean }): Promise<Booking[]>;
  cancelBooking(booking: Booking): Promise<void>;
}

/** Outcome of `WeWorkSession.reserveBooking` (build spec §11.2). */
export type ReserveResult =
  | { ok: true; capsRemaining: CapsRemaining }
  | { ok: false; code: "CAP_EXCEEDED"; message: string; capsRemaining: CapsRemaining };

/**
 * The `WeWorkSession` RPC methods this service calls — build spec §11.2, owned by the
 * session engineer.
 *
 * Declared structurally for the same reason as {@link WeWorkApi}: a real
 * `DurableObjectStub<WeWorkSession>` satisfies it (RPC methods return promises), and a
 * unit test satisfies it with a plain object, so the service needs no Durable Object.
 */
export interface SessionRpc {
  getSessionInfo(): Promise<SessionInfo>;
  reserveBooking(args: {
    bookingKey: string;
    date: string;
    credits: number;
    actor: string;
    dryRun: boolean;
  }): Promise<ReserveResult>;
  confirmBooking(args: { bookingKey: string; bookingId: string }): Promise<void>;
  releaseBooking(args: { bookingKey: string }): Promise<void>;
  cancelLedger(args: { bookingId: string }): Promise<void>;
  capsRemaining(date: string): Promise<CapsRemaining>;
  idempotencyGet(key: string): Promise<unknown | undefined>;
  idempotencyPut(key: string, value: unknown, ttlSec?: number): Promise<void>;
  audit(entry: {
    actor: string;
    tool: string;
    args: unknown;
    outcome: "ok" | "error" | "denied";
    bookingId?: string;
    credits?: number;
    dryRun?: boolean;
    error?: string;
  }): Promise<void>;
}

/** Injected collaborators — build spec §11.4. */
export interface BookingServiceDeps {
  api: WeWorkApi;
  /** The session Durable Object stub (or any object with the same RPC methods). */
  session: SessionRpc;
  config: Config;
  /** `QUOTE_SIGNING_KEY`. Passed separately from `config` so tests can vary it alone. */
  quoteKey: string;
  /** Injected clock, epoch milliseconds. */
  now?: () => number;
  /** Absolute origin of this deployment, used to make hints actionable. */
  baseUrl: string;
  /**
   * Tenant id baked into every quote and checked on verification. Phase 1 always
   * `"default"`; it must equal the calling `Actor.accountId`.
   */
  accountId?: string;
}

/* -------------------------------------------------------------------------- */
/* Additive result/arg shapes                                                  */
/* -------------------------------------------------------------------------- */

/**
 * {@link ../core/types!SearchAvailabilityArgs} plus the result cap both front doors
 * expose (`limit` in docs/API.md). Additive: the shared type is untouched.
 */
export interface SearchArgs extends SearchAvailabilityArgs {
  /** Maximum results to return. Default 20, hard maximum 100. */
  limit?: number;
}

/**
 * {@link ../core/types!WhoamiResult} plus the remaining caps for today.
 *
 * `caps` in the shared type is the *configured* ceiling; agents also need to know how
 * much of it is left before they offer to book, so `capsRemaining` is added here.
 */
export interface WhoamiResultWithCaps extends WhoamiResult {
  capsRemaining: CapsRemaining;
}

/** The service as constructed here: {@link ../core/types!BookingService} with the additive shapes. */
export interface BookingServiceImpl extends BookingService {
  searchAvailability(args: SearchArgs): Promise<AvailabilityResult[]>;
  whoami(actor: Actor): Promise<WhoamiResultWithCaps>;
}

/** Default and maximum for `limit` on both list-shaped methods. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** A city-wide search fans out across at most this many buildings (one upstream call each). */
const MAX_CITY_LOCATIONS = 10;
/** Credit drift tolerated between the signed quote and the price at booking time. */
const CREDIT_TOLERANCE = 0;
/** How long a stored idempotency result stays replayable. */
const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;
/** The placeholder `bookingId` a dry run reports. */
export const DRY_RUN_BOOKING_ID = "dry-run";

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Builds the service. Pure wiring — no I/O happens until a method is called.
 *
 * @example
 * const service = createBookingService({
 *   api: new WeWorkClient({ fetch, tokens }),
 *   session: getSessionStub(env),
 *   config: parseConfig(env),
 *   quoteKey: config.quoteSigningKey,
 *   baseUrl: baseUrl(config, request),
 * });
 */
export function createBookingService(deps: BookingServiceDeps): BookingServiceImpl {
  const { api, session, config, quoteKey } = deps;
  const now = deps.now ?? (() => Date.now());
  const accountId = deps.accountId ?? "default";

  /* ---------------------------------------------------------------------- */
  /* listLocations                                                           */
  /* ---------------------------------------------------------------------- */

  async function listLocations(args: ListLocationsArgs = {}): Promise<Location[]> {
    const limit = clampLimit(args.limit);
    const query = trimmed(args.query);
    const city = trimmed(args.city);
    const hasLat = typeof args.lat === "number";
    const hasLng = typeof args.lng === "number";

    if (hasLat !== hasLng) {
      throw new AppError("VALIDATION", "lat and lng must be supplied together.", {
        hint: "Pass both lat and lng, or search by city or free-text query instead.",
      });
    }

    if (city) {
      const locations = await api.listLocationsByCity(city);
      return applyTextFilter(locations, query).slice(0, limit);
    }

    if (hasLat && hasLng) {
      const geoArgs: { lat: number; lng: number; radiusKm?: number } = {
        lat: args.lat as number,
        lng: args.lng as number,
      };
      if (typeof args.radiusKm === "number") geoArgs.radiusKm = args.radiusKm;
      const locations = await api.listLocationsByGeo(geoArgs);
      return applyTextFilter(locations, query).slice(0, limit);
    }

    if (!query) {
      throw new AppError(
        "VALIDATION",
        "Provide at least one of query, city, or lat and lng together.",
        { hint: "Try { city: 'London' } or { query: 'Shoreditch' }." },
      );
    }

    // Free text: WeWork indexes buildings by city, so resolve the query to a city
    // first, then filter that city's buildings by name/address.
    const cities = await api.listCities();
    const matchedCity = bestCityMatch(cities, query);
    if (!matchedCity) {
      throw new AppError("NOT_FOUND", `No WeWork city matched "${query}".`, {
        hint: "Pass a city name (list_locations with city), or lat and lng for a geographic search.",
      });
    }
    const locations = await api.listLocationsByCity(matchedCity);
    const filtered = applyTextFilter(locations, query);
    // The query named a city, not a building: every building in it is a hit.
    return (filtered.length > 0 ? filtered : locations).slice(0, limit);
  }

  /* ---------------------------------------------------------------------- */
  /* searchAvailability                                                      */
  /* ---------------------------------------------------------------------- */

  async function searchAvailability(args: SearchArgs): Promise<AvailabilityResult[]> {
    const spaceType: SpaceType = args.spaceType ?? "desk";
    if (spaceType !== "desk") {
      throw new AppError(
        "UNSUPPORTED_SPACE_TYPE",
        `space_type "${spaceType}" is not implemented; this build books hot desks only.`,
        {
          hint: "Tell the user only hot desks (space_type 'desk') can be booked. Contributors can add room support by capturing the upstream calls — see docs/CAPTURE_GUIDE.md.",
        },
      );
    }

    const date = assertDate(args.date, "date");
    const locationId = trimmed(args.locationId);
    const city = trimmed(args.city);
    if (!locationId && !city) {
      throw new AppError("VALIDATION", "Either location_id or city is required.", {
        hint: "Call list_locations first and pass one location_id, or pass a city to search every building in it.",
      });
    }
    if (locationId && city) {
      throw new AppError("VALIDATION", "location_id and city are mutually exclusive.", {
        hint: "Search one building by location_id, or a whole city by city — not both.",
      });
    }

    const startTime = args.startTime
      ? floorTo30(assertTime(args.startTime, "start_time"))
      : undefined;
    const endTime = args.endTime ? ceilTo30(assertTime(args.endTime, "end_time")) : undefined;
    if (startTime && endTime && endTime <= startTime) {
      throw new AppError("VALIDATION", "end_time must be later than start_time.", {
        hint: "Both are local wall-clock times at the building, e.g. start_time 09:00 and end_time 17:00.",
      });
    }

    let locationIds: string[];
    if (locationId) {
      // No cheap way to learn this building's zone before the search, so only the
      // conservative check is possible here; the per-zone check happens below, once
      // the response tells us the zone.
      if (compareDates(date, addDays(todayIn("UTC", now()), -1)) < 0) {
        throw pastDate(date);
      }
      locationIds = [locationId];
    } else {
      const locations = await api.listLocationsByCity(city as string);
      if (locations.length === 0) {
        throw new AppError("NOT_FOUND", `No WeWork buildings found in "${city}".`, {
          hint: "Call list_locations to see which cities and buildings exist.",
        });
      }
      const firstTz = locations[0]?.timezone ?? "UTC";
      if (compareDates(date, todayIn(firstTz, now())) < 0) throw pastDate(date);
      locationIds = locations.slice(0, MAX_CITY_LOCATIONS).map((location) => location.locationId);
    }

    const spacesArgs: {
      locationIds: string[];
      date: string;
      spaceType?: SpaceType;
      capacity?: number;
    } = { locationIds, date, spaceType };
    if (typeof args.capacity === "number") spacesArgs.capacity = args.capacity;
    const spaces = await api.getSpaces(spacesArgs);

    const expSeconds = Math.floor(now() / 1000) + config.quoteTtlSeconds;
    const results: AvailabilityResult[] = [];

    for (const space of spaces) {
      if (space.seatsAvailable <= 0) continue;
      const tz = space.location.timezone || space.timezone || "UTC";
      if (compareDates(date, todayIn(tz, now())) < 0) throw pastDate(date);

      const window = resolveWindow(space, date, tz, startTime, endTime);
      const bookingSpaceId = await api.resolveBookingSpaceId(space);
      const payload: QuotePayload = {
        v: 1,
        accountId,
        locationId: space.location.locationId,
        spaceId: space.spaceId,
        wwSpaceId: space.spaceId,
        bookingSpaceId,
        accountType: space.location.accountType,
        date,
        startUtc: window.startUtc,
        endUtc: window.endUtc,
        // The price shown to the user. `api.quote()` re-checks it at booking time.
        credits: space.credits,
        timezone: tz,
        tzOffset: offsetString(Date.parse(window.startUtc), tz),
        locationName: space.location.name,
        address: space.location.address,
        city: space.location.city,
        country: space.location.country,
        exp: expSeconds,
        quoteSpaceId: space.inventoryUuid ?? space.spaceId,
        spaceName: space.spaceName,
        capacity: space.capacity,
      };

      const quote = await signQuote(payload, quoteKey);
      const summary = summariseSpace(space, date, window, tz);
      results.push({
        ...space,
        date,
        startLocal: window.startLocal,
        endLocal: window.endLocal,
        startUtc: window.startUtc,
        endUtc: window.endUtc,
        timezone: tz,
        quote,
        summary,
      });
    }

    // Cheapest first, then most seats left: the order an agent should read out.
    results.sort((a, b) => a.credits - b.credits || b.seatsAvailable - a.seatsAvailable);
    return results.slice(0, clampLimit(args.limit));
  }

  /* ---------------------------------------------------------------------- */
  /* createBooking                                                           */
  /* ---------------------------------------------------------------------- */

  async function createBooking(
    args: CreateBookingArgs,
    actor: Actor,
  ): Promise<CreateBookingResult> {
    assertWriteEnabled();
    const payload = await verifyQuote(args.quote, quoteKey, {
      now: now(),
      accountId: actor.accountId,
    });
    const dryRun = args.dryRun === true;

    const key = `book:${args.idempotencyKey ?? (await sha256Hex(args.quote))}`;
    const replay = await replayed<CreateBookingResult>(key);
    if (replay) return replay;

    if (config.maxCreditsPerBooking > 0 && payload.credits > config.maxCreditsPerBooking) {
      await audit(actor, "create_booking", auditArgs(payload, args), "denied", {
        credits: payload.credits,
        dryRun,
        error: "CAP_EXCEEDED",
      });
      throw new AppError(
        "CAP_EXCEEDED",
        `This booking costs ${payload.credits} credits but MAX_CREDITS_PER_BOOKING is ${config.maxCreditsPerBooking}.`,
        {
          hint: "Tell the user the per-booking credit ceiling blocked this; a cheaper slot may fit. Do not retry the same quote.",
          details: { maxCreditsPerBooking: config.maxCreditsPerBooking, credits: payload.credits },
        },
      );
    }

    const reservation = await session.reserveBooking({
      bookingKey: key,
      date: payload.date,
      credits: payload.credits,
      actor: actor.name,
      dryRun,
    });
    if (!reservation.ok) {
      await audit(actor, "create_booking", auditArgs(payload, args), "denied", {
        credits: payload.credits,
        dryRun,
        error: reservation.code,
      });
      throw new AppError("CAP_EXCEEDED", reservation.message, {
        hint: `A configured booking cap is already used up (${reservation.capsRemaining.day} left today, ${reservation.capsRemaining.week} this week). Tell the user the limit instead of retrying.`,
        details: { capsRemaining: reservation.capsRemaining },
      });
    }

    if (dryRun) {
      const booking = bookingFromQuote(payload, DRY_RUN_BOOKING_ID, "pending");
      const result: CreateBookingResult = {
        booking,
        dryRun: true,
        creditsCharged: payload.credits,
        capsRemaining: reservation.capsRemaining,
        summary: `Dry run: would book ${describeSlot(payload)} for ${payload.credits} credit(s). Nothing was sent to WeWork and no cap was used.`,
      };
      await audit(actor, "create_booking", auditArgs(payload, args), "ok", {
        credits: payload.credits,
        dryRun: true,
      });
      return result;
    }

    try {
      const priced = await api.quote(payload);
      if (Math.abs(priced.credits - payload.credits) > CREDIT_TOLERANCE) {
        throw new AppError(
          "BOOKING_REFUSED",
          `WeWork now prices this slot at ${priced.credits} credits, not the ${payload.credits} in the quote.`,
          {
            hint: "price changed, search again",
            details: { quotedCredits: payload.credits, currentCredits: priced.credits },
          },
        );
      }

      const booked = await api.book(payload, priced.creditRatio);
      const booking = bookingFromQuote(payload, booked.reservationId, "confirmed");
      booking.reservationId = booked.reservationId;
      const result: CreateBookingResult = {
        booking,
        dryRun: false,
        creditsCharged: priced.credits,
        capsRemaining: reservation.capsRemaining,
        summary: `Booked ${describeSlot(payload)} for ${priced.credits} credit(s). Booking id ${booked.reservationId}.`,
      };

      await session.confirmBooking({ bookingKey: key, bookingId: booking.bookingId });
      await session.idempotencyPut(key, result, IDEMPOTENCY_TTL_SEC);
      await audit(actor, "create_booking", auditArgs(payload, args), "ok", {
        bookingId: booking.bookingId,
        credits: priced.credits,
        dryRun: false,
      });
      return result;
    } catch (err) {
      // Nothing was booked (or we cannot prove it was): give the cap back and record why.
      await safely(() => session.releaseBooking({ bookingKey: key }));
      await audit(actor, "create_booking", auditArgs(payload, args), "error", {
        credits: payload.credits,
        dryRun: false,
        error: errorCode(err),
      });
      throw err;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* listBookings                                                            */
  /* ---------------------------------------------------------------------- */

  async function listBookings(args: ListBookingsArgs = {}): Promise<Booking[]> {
    const listArgs: { from?: string; to?: string; includePast?: boolean } = {};
    if (args.from) listArgs.from = assertDate(args.from, "from");
    if (args.to) listArgs.to = assertDate(args.to, "to");
    if (listArgs.from && listArgs.to && compareDates(listArgs.from, listArgs.to) > 0) {
      throw new AppError("VALIDATION", "from must not be after to.");
    }
    if (args.includePast !== undefined) listArgs.includePast = args.includePast;
    const bookings = await api.listBookings(listArgs);
    // `raw` exists for the cancel call; it is upstream JSON and never leaves the worker.
    return bookings.map(withoutRaw);
  }

  /* ---------------------------------------------------------------------- */
  /* cancelBooking                                                           */
  /* ---------------------------------------------------------------------- */

  async function cancelBooking(
    args: CancelBookingArgs,
    actor: Actor,
  ): Promise<CancelBookingResult> {
    assertWriteEnabled();
    const bookingId = trimmed(args.bookingId);
    if (!bookingId) {
      throw new AppError("VALIDATION", "booking_id is required.", {
        hint: "Call list_bookings and pass a bookingId from its result.",
      });
    }
    const dryRun = args.dryRun === true;

    const key = `cancel:${args.idempotencyKey ?? bookingId}`;
    const replay = await replayed<CancelBookingResult>(key);
    if (replay) return replay;

    const booking = (await api.listBookings({ includePast: true })).find(
      (candidate) => candidate.bookingId === bookingId,
    );
    if (!booking) {
      await audit(actor, "cancel_booking", { bookingId, dryRun }, "error", {
        bookingId,
        dryRun,
        error: "NOT_FOUND",
      });
      throw new AppError("NOT_FOUND", `No booking with id ${bookingId}.`, {
        hint: "Call list_bookings to get current booking ids; it may already be cancelled.",
      });
    }

    const where = `${booking.locationName} on ${booking.date}`;
    if (dryRun) {
      const result: CancelBookingResult = {
        bookingId,
        status: booking.status,
        summary: `Dry run: would cancel booking ${bookingId} at ${where}. Nothing was sent to WeWork.`,
      };
      await audit(actor, "cancel_booking", { bookingId, dryRun: true }, "ok", {
        bookingId,
        dryRun: true,
      });
      return result;
    }

    try {
      await api.cancelBooking(booking);
    } catch (err) {
      await audit(actor, "cancel_booking", { bookingId, dryRun: false }, "error", {
        bookingId,
        dryRun: false,
        error: errorCode(err),
      });
      throw err;
    }

    // Frees the day against the caps, so the user can rebook after cancelling.
    await safely(() => session.cancelLedger({ bookingId }));
    const result: CancelBookingResult = {
      bookingId,
      status: "cancelled",
      creditsRefunded: booking.credits,
      summary: `Cancelled booking ${bookingId} at ${where}. ${booking.credits} credit(s) refunded.`,
    };
    await session.idempotencyPut(key, result, IDEMPOTENCY_TTL_SEC);
    await audit(actor, "cancel_booking", { bookingId, dryRun: false }, "ok", {
      bookingId,
      credits: booking.credits,
      dryRun: false,
    });
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* whoami                                                                  */
  /* ---------------------------------------------------------------------- */

  async function whoami(actor: Actor): Promise<WhoamiResultWithCaps> {
    // Deliberately total: whoami is the tool an agent calls to find out *that* the
    // deployment is not connected, so it must answer even when nothing else can.
    const session_ = await softly<SessionInfo>(() => session.getSessionInfo(), {
      state: "none",
      source: "none",
      hasRefreshToken: false,
    });
    const connected = session_.state === "valid" || session_.state === "expiring";
    const profile = connected
      ? await softly<Profile>(() => api.getProfile(), { userId: "" })
      : { userId: "" };
    const credits = connected
      ? await softly<Credits | undefined>(() => api.getMonthlyCredits(), undefined)
      : undefined;
    const today = todayIn(profileTimezone(), now());
    const caps = await softly<CapsRemaining>(() => session.capsRemaining(today), {
      day: config.maxBookingsPerDay,
      week: config.maxBookingsPerWeek,
    });

    const result: WhoamiResultWithCaps = {
      profile,
      session: session_,
      actor,
      caps: {
        maxBookingsPerDay: config.maxBookingsPerDay,
        maxBookingsPerWeek: config.maxBookingsPerWeek,
        maxCreditsPerBooking: config.maxCreditsPerBooking,
      },
      capsRemaining: caps,
      writeEnabled: config.writeEnabled,
    };
    if (credits) result.credits = credits;
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  /** Phase 1 has no per-user zone; caps are counted on the UTC calendar day. */
  function profileTimezone(): string {
    return "UTC";
  }

  function assertWriteEnabled(): void {
    if (!config.writeEnabled) {
      throw new AppError("WRITE_DISABLED", "Booking is disabled on this deployment.", {
        hint: "Reads still work. Tell the user the operator must set WRITE_ENABLED=true to allow bookings.",
      });
    }
  }

  function pastDate(date: string): AppError {
    return new AppError("VALIDATION", `${date} is in the past at that building.`, {
      hint: "Desks can only be booked for today or a future local date at the building.",
    });
  }

  /** Returns a stored result for `key`, with the replay flagged in its summary. */
  async function replayed<T extends { summary: string }>(key: string): Promise<T | undefined> {
    const cached = await softly<unknown>(() => session.idempotencyGet(key), undefined);
    if (cached === undefined || cached === null || typeof cached !== "object") return undefined;
    const stored = cached as T;
    return {
      ...stored,
      summary: `${stored.summary} (idempotent: true — replay of the first call with this key, nothing was sent to WeWork again)`,
    };
  }

  async function audit(
    actor: Actor,
    tool: string,
    args: unknown,
    outcome: "ok" | "error" | "denied",
    extra: { bookingId?: string; credits?: number; dryRun?: boolean; error?: string } = {},
  ): Promise<void> {
    await safely(() =>
      session.audit({ actor: `${actor.kind}:${actor.name}`, tool, args, outcome, ...extra }),
    );
  }

  /** A failing audit or ledger call must never turn a successful booking into an error. */
  async function safely(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.error("booking-service: non-fatal session RPC failure", {
        code: errorCode(err),
      });
    }
  }

  /** Runs `fn`, falling back to `fallback` on any failure. */
  async function softly<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  /**
   * Makes every hint concrete.
   *
   * The default hints in `src/errors.ts` are written with a `<base>` placeholder
   * (`"Ask the user to open <base>/admin/connect"`) because that module knows nothing
   * about the deployment. This is the only layer that knows the public origin, so it
   * substitutes it on the way out — an agent is far more likely to act on a real URL.
   */
  async function withHints<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isAppError(err) && err.hint?.includes("<base>")) {
        throw new AppError(err.code, err.message, {
          status: err.status,
          hint: err.hint.replaceAll("<base>", deps.baseUrl),
          details: err.details,
          cause: err,
        });
      }
      throw err;
    }
  }

  return {
    listLocations: (args) => withHints(() => listLocations(args)),
    searchAvailability: (args) => withHints(() => searchAvailability(args)),
    createBooking: (args, actor) => withHints(() => createBooking(args, actor)),
    listBookings: (args) => withHints(() => listBookings(args)),
    cancelBooking: (args, actor) => withHints(() => cancelBooking(args, actor)),
    whoami: (actor) => withHints(() => whoami(actor)),
  };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

interface SlotWindow {
  startUtc: string;
  endUtc: string;
  startLocal: string;
  endLocal: string;
  startTime: string;
  endTime: string;
}

/**
 * The window to quote: the caller's requested times when given, otherwise whatever
 * the upstream search returned (normally the building's opening hours).
 */
function resolveWindow(
  space: SpaceAvailability,
  date: string,
  tz: string,
  startTime: string | undefined,
  endTime: string | undefined,
): SlotWindow {
  const fallbackStart = utcToLocal(space.startUtc, tz).time;
  const fallbackEnd = utcToLocal(space.endUtc, tz).time;
  const start = startTime ?? fallbackStart;
  const end = endTime ?? fallbackEnd;
  return {
    startUtc: startTime ? isoUtc(localToUtcMs(date, start, tz)) : space.startUtc,
    endUtc: endTime ? isoUtc(localToUtcMs(date, end, tz)) : space.endUtc,
    startLocal: startTime ? localWallClock(date, start) : space.startLocal,
    endLocal: endTime ? localWallClock(date, end) : space.endLocal,
    startTime: start,
    endTime: end,
  };
}

/** The one-line summary an agent reads back to the user. Local times, always. */
function summariseSpace(
  space: SpaceAvailability,
  date: string,
  window: SlotWindow,
  tz: string,
): string {
  const where = space.location.city
    ? `${space.location.name}, ${space.location.city}`
    : space.location.name;
  return `Desk at ${where} on ${date} ${window.startTime}-${window.endTime} (${tz}), ${space.credits} credits, ${space.seatsAvailable} seats left`;
}

/** `"1 Poultry, London, Mon 21 Sep 09:00-17:00 (Europe/London)"`. */
function describeSlot(payload: QuotePayload): string {
  const where = payload.city ? `${payload.locationName}, ${payload.city}` : payload.locationName;
  const when = formatLocalRange(payload.startUtc, payload.endUtc, payload.timezone);
  return `${where}, ${when} (${payload.timezone})`;
}

/** The booking a quote describes — used for both the dry run and the confirmed result. */
function bookingFromQuote(
  payload: QuotePayload,
  bookingId: string,
  status: Booking["status"],
): Booking {
  const start = utcToLocal(payload.startUtc, payload.timezone);
  const end = utcToLocal(payload.endUtc, payload.timezone);
  return {
    bookingId,
    locationId: payload.locationId,
    locationName: payload.locationName,
    address: payload.address,
    date: payload.date,
    startLocal: localWallClock(start.date, start.time),
    endLocal: localWallClock(end.date, end.time),
    timezone: payload.timezone,
    status,
    credits: payload.credits,
  };
}

/** What goes in the audit log: the slot, never the quote string or the note's content. */
function auditArgs(payload: QuotePayload, args: CreateBookingArgs): Record<string, unknown> {
  return {
    locationId: payload.locationId,
    locationName: payload.locationName,
    spaceId: payload.spaceId,
    date: payload.date,
    startUtc: payload.startUtc,
    endUtc: payload.endUtc,
    credits: payload.credits,
    dryRun: args.dryRun === true,
    hasNote: typeof args.note === "string" && args.note.length > 0,
  };
}

function withoutRaw(booking: Booking): Booking {
  const { raw: _raw, ...rest } = booking;
  return rest;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function trimmed(value: string | undefined): string | undefined {
  const out = value?.trim();
  return out ? out : undefined;
}

/** Case-insensitive substring match over the fields a human would type. */
function applyTextFilter(locations: Location[], query: string | undefined): Location[] {
  if (!query) return locations;
  const needle = query.toLowerCase();
  const hits = locations.filter((location) =>
    [location.name, location.address, location.city].some((field) =>
      (field ?? "").toLowerCase().includes(needle),
    ),
  );
  return hits.length > 0 ? hits : locations;
}

/**
 * Picks the city a free-text query most likely means: exact match, then either
 * direction of substring containment, preferring the shortest candidate so
 * `"york"` resolves to `"York"` rather than `"New York"`.
 */
function bestCityMatch(cities: string[], query: string): string | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const exact = cities.find((city) => city.toLowerCase() === needle);
  if (exact) return exact;
  const candidates = cities
    .filter((city) => {
      const name = city.toLowerCase();
      return name.includes(needle) || needle.includes(name);
    })
    .sort((a, b) => a.length - b.length);
  return candidates[0];
}

function errorCode(err: unknown): string {
  return isAppError(err) ? err.code : "UPSTREAM_ERROR";
}
