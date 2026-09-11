/**
 * The six MCP tools.
 *
 * Descriptions here are part of the product: they are the only documentation the model
 * gets, so each one says what the tool costs, what it needs first, and what the agent
 * must do before spending the user's credits. Three rules are repeated deliberately,
 * because an agent reads one tool's description without necessarily reading the others:
 *
 *  1. every time is **local wall clock at the building**, never UTC, never the user's
 *     own zone;
 *  2. `search_availability` is the only source of quotes, and `create_booking` takes
 *     nothing else;
 *  3. `create_booking` spends real WeWork credits — confirm the exact slot and price
 *     with the user first.
 *
 * Results are uniform: `content[0].text` is a human sentence, `structuredContent` is
 * the machine answer (identical to the matching REST route's body), and failures come
 * back as `isError: true` with `{ code, message, hint }` as JSON text so the agent can
 * branch on `code` and act on `hint`.
 */

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { BookingServiceImpl } from "../core/booking-service";
import type { Actor } from "../core/types";
import { isAppError } from "../errors";
import {
  runCancelBooking,
  runCreateBooking,
  runListBookings,
  runListLocations,
  runSearchAvailability,
  runWhoami,
} from "./operations";
import {
  cancelBookingInput,
  cancelBookingOutput,
  createBookingInput,
  createBookingOutput,
  listBookingsInput,
  listBookingsOutput,
  listLocationsInput,
  listLocationsOutput,
  searchAvailabilityInput,
  searchAvailabilityOutput,
  whoamiInput,
  whoamiOutput,
} from "./schemas";

/** Per-request context for the tool handlers: one service, one authenticated caller. */
export interface ToolContext {
  service: BookingServiceImpl;
  actor: Actor;
}

/** The tool names, in the order `tools/list` reports them. Exact per build spec §9. */
export const TOOL_NAMES = [
  "whoami",
  "list_locations",
  "search_availability",
  "create_booking",
  "list_bookings",
  "cancel_booking",
] as const;

/**
 * Registers all six tools on a fresh `McpServer`.
 *
 * @param server a per-request server instance (never a cached one)
 * @param ctx the service and actor for this request
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: [
        "Report how this deployment is configured and whether it can book anything right now.",
        "Returns the WeWork member profile, the remaining monthly credit balance, the stored WeWork session state, your own token's scopes, the configured booking caps and how much of them is left today.",
        "Call this first when you do not know whether the deployment is connected: if session.state is 'none' or 'expired', stop and tell the user to reconnect — no search or booking will work.",
        "Costs nothing and changes nothing.",
      ].join(" "),
      inputSchema: whoamiInput,
      outputSchema: whoamiOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => guard(async () => toolResult(await runWhoami(ctx.service, ctx.actor))),
  );

  server.registerTool(
    "list_locations",
    {
      title: "Find WeWork buildings",
      description: [
        "Find WeWork buildings by city, by free text, or near a latitude/longitude.",
        "Use it to turn what the user said ('somewhere near London Bridge') into the location_id that search_availability needs, and to show them the choice.",
        "Each result carries the building's IANA timezone — every date and time in this API is local wall clock at the building, so read times back to the user in that zone.",
        "Read-only: no credits, no bookings.",
      ].join(" "),
      inputSchema: listLocationsInput,
      outputSchema: listLocationsOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => guard(async () => toolResult(await runListLocations(ctx.service, args))),
  );

  server.registerTool(
    "search_availability",
    {
      title: "Search hot-desk availability",
      description: [
        "Search bookable hot desks at one building (location_id) or across a city (city) for one local date, and issue a signed quote for each option.",
        "This is the ONLY source of quotes: create_booking accepts a quote and nothing else, so always search first, show the user the options with their credit cost, and book the one they pick.",
        "date is YYYY-MM-DD and start_time/end_time are HH:MM, both local at the building; times are snapped to 30-minute boundaries. Omit the times to get the building's full opening hours.",
        "Each result reports credits (the WeWork credits the booking would spend), seatsAvailable, local and UTC instants, and an opaque quote string to pass through verbatim.",
        "Quotes expire (default 10 minutes) — if the user takes a while to decide, search again rather than booking a stale quote.",
        "Only hot desks are implemented; space_type 'meeting_room' or 'private_office' returns UNSUPPORTED_SPACE_TYPE.",
        "Read-only: searching spends nothing.",
      ].join(" "),
      inputSchema: searchAvailabilityInput,
      outputSchema: searchAvailabilityOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(async () => toolResult(await runSearchAvailability(ctx.service, args))),
  );

  server.registerTool(
    "create_booking",
    {
      title: "Book a hot desk",
      description: [
        "Book the desk described by a quote from search_availability. THIS SPENDS THE USER'S REAL WEWORK CREDITS.",
        "Confirm with the user first: tell them the building, the local date and times, and the exact credit cost from the search result, and book only once they have said yes to that specific option.",
        "Pass the quote string verbatim — it cannot be constructed, edited or reused for a different slot, and it expires. Pass idempotency_key (a UUID) so a retry cannot double-book.",
        "Use dry_run: true to validate the quote, re-check the price and test the caps without booking anything; nothing is sent to WeWork and no allowance is used.",
        "The price is re-checked against WeWork immediately before booking: if it has changed at all, the booking is refused with BOOKING_REFUSED rather than silently costing more — search again and re-confirm.",
        "On success, report the booking id, the local times and the credits charged, plus how much of the booking allowance is left.",
      ].join(" "),
      inputSchema: createBookingInput,
      outputSchema: createBookingOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // True only when idempotency_key is supplied — which the description tells the
        // agent to always do, and which is what makes a retry safe.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(async () => toolResult(await runCreateBooking(ctx.service, args, ctx.actor))),
  );

  server.registerTool(
    "list_bookings",
    {
      title: "List bookings",
      description: [
        "List the member's desk bookings in a local date range (default: today to 30 days out; include_past for finished ones).",
        "Use it to find the bookingId cancel_booking needs, to check whether a desk is already booked before searching, and to tell the user what they have coming up.",
        "startLocal/endLocal are local wall clock at each building — report them in that building's timezone, which each booking carries.",
        "Read-only: no credits, no changes.",
      ].join(" "),
      inputSchema: listBookingsInput,
      outputSchema: listBookingsOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => guard(async () => toolResult(await runListBookings(ctx.service, args))),
  );

  server.registerTool(
    "cancel_booking",
    {
      title: "Cancel a booking",
      description: [
        "Cancel an existing desk booking by its bookingId (from list_bookings). THIS IS DESTRUCTIVE AND CANNOT BE UNDONE.",
        "Confirm the exact booking with the user first — read back the building, the local date and the times — and cancel only that one.",
        "Credits are refunded only when the booking's cancellation deadline has not passed; cancelling late usually refunds nothing, so say so if cancelDeadlineLocal is already behind us.",
        "Use dry_run: true to check what would be cancelled without touching it. Pass idempotency_key so a retry is safe.",
      ].join(" "),
      inputSchema: cancelBookingInput,
      outputSchema: cancelBookingOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(async () => toolResult(await runCancelBooking(ctx.service, args, ctx.actor))),
  );
}

/* -------------------------------------------------------------------------- */
/* Result plumbing                                                             */
/* -------------------------------------------------------------------------- */

/** Turns an {@link ./operations!OperationResult} into the MCP wire shape. */
function toolResult(result: { structured: unknown; text: string }): CallToolResult {
  return {
    content: [{ type: "text", text: result.text }],
    structuredContent: result.structured as Record<string, unknown>,
  };
}

/**
 * Converts a thrown {@link ../errors!AppError} into an MCP tool error.
 *
 * The JSON body is `{ code, message, hint }` — `code` to branch on, `hint` to act on.
 * Anything that is *not* an `AppError` is reported as a generic internal failure: an
 * arbitrary `message` may carry an upstream body, and upstream bodies carry tokens.
 */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const body = isAppError(err)
      ? { code: err.code, message: err.message, hint: err.hint }
      : {
          code: "UPSTREAM_ERROR",
          message: "An unexpected internal error occurred.",
          hint: "Retry once; if it persists, report it to the user rather than retrying.",
        };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(body) }],
    };
  }
}
