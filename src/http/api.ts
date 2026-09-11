/**
 * The REST mirror of the MCP tools.
 *
 * Every route is the same three steps: validate with the shared zod schema from
 * `src/mcp/schemas.ts`, call the matching `run*` operation from
 * `src/mcp/operations.ts`, and return its `structured` result as the JSON body. That is
 * what guarantees the promise in docs/API.md — a REST body and the matching MCP
 * `structuredContent` are the same bytes — and it means scope checks, validation and
 * summaries cannot drift between the two front doors.
 *
 * Naming: **requests are `snake_case`** (query strings and JSON
 * bodies alike), **responses are `camelCase`**. A URL only carries strings, so query
 * parameters go through `coerceQuery()` before validation.
 *
 * Authentication happens upstream: `src/index.ts` resolves the {@link ../core/types!Actor}
 * and puts it on the context as `actor`. These routes only enforce *scope*, and they do
 * it inside the operations, exactly as the MCP handlers do.
 */

import { Hono } from "hono";
import type { ZodType } from "zod";
import type { BookingServiceImpl } from "../core/booking-service";
import type { Actor } from "../core/types";
import type { Env } from "../env";
import { AppError, statusFor, toErrorBody } from "../errors";
import {
  runCancelBooking,
  runCreateBooking,
  runListBookings,
  runListLocations,
  runSearchAvailability,
  runWhoami,
} from "../mcp/operations";
import {
  cancelBookingInput,
  coerceQuery,
  createBookingInput,
  listBookingsInput,
  listLocationsInput,
  searchAvailabilityInput,
} from "../mcp/schemas";

/** The Hono environment these routes expect: bindings, plus the actor set by the guard. */
export interface ApiEnv {
  Bindings: Env;
  Variables: { actor: Actor };
}

/** Options for {@link apiRoutes}. */
export interface ApiRoutesOptions {
  /** Builds the booking service for this request and actor. */
  buildService: (env: Env, actor: Actor, req: Request) => BookingServiceImpl;
}

/**
 * The `/api` router. Mount it *after* the middleware that sets `actor`:
 *
 * @example
 * app.use("/api/*", actorMiddleware);
 * app.route("/api", apiRoutes({ buildService }));
 */
export function apiRoutes(opts: ApiRoutesOptions): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>();

  api.get("/whoami", async (c) => {
    const { service, actor } = context(c.get("actor"), c.env, c.req.raw, opts);
    const { structured } = await runWhoami(service, actor);
    return c.json(structured);
  });

  api.get("/locations", async (c) => {
    const { service } = context(c.get("actor"), c.env, c.req.raw, opts);
    const input = parse(listLocationsInput, coerceQuery(c.req.query()));
    const { structured } = await runListLocations(service, input);
    return c.json(structured);
  });

  api.get("/availability", async (c) => {
    const { service } = context(c.get("actor"), c.env, c.req.raw, opts);
    const input = parse(searchAvailabilityInput, coerceQuery(c.req.query()));
    const { structured } = await runSearchAvailability(service, input);
    return c.json(structured);
  });

  api.get("/bookings", async (c) => {
    const { service } = context(c.get("actor"), c.env, c.req.raw, opts);
    const input = parse(listBookingsInput, coerceQuery(c.req.query()));
    const { structured } = await runListBookings(service, input);
    return c.json(structured);
  });

  api.post("/bookings", async (c) => {
    const { service, actor } = context(c.get("actor"), c.env, c.req.raw, opts);
    const input = parse(createBookingInput, await jsonBody(c.req.raw));
    const { structured } = await runCreateBooking(service, input, actor);
    // 201: a booking was created. A dry run creates nothing, so it stays 200.
    return c.json(structured, structured.dryRun ? 200 : 201);
  });

  api.delete("/bookings/:id", async (c) => {
    const { service, actor } = context(c.get("actor"), c.env, c.req.raw, opts);
    const input = parse(cancelBookingInput, {
      ...coerceQuery(c.req.query()),
      booking_id: c.req.param("id"),
    });
    const { structured } = await runCancelBooking(service, input, actor);
    return c.json(structured);
  });

  /** Same envelope as every other failure in this worker: `{ error: { code, message, hint } }`. */
  api.onError((err, c) => c.json(toErrorBody(err), statusFor(err) as 400));

  return api;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/** Resolves the actor set by the guard and builds the per-request service. */
function context(
  actor: Actor | undefined,
  env: Env,
  req: Request,
  opts: ApiRoutesOptions,
): { service: BookingServiceImpl; actor: Actor } {
  if (!actor) {
    // Only reachable if these routes are mounted without the guard in front of them.
    throw new AppError("UNAUTHORIZED", "No authenticated caller on this request.");
  }
  return { service: opts.buildService(env, actor, req), actor };
}

/**
 * Validates input, turning a zod failure into the standard `VALIDATION` error with a
 * message that names the offending fields (and nothing else — never the values).
 */
function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
    .join("; ");
  throw new AppError("VALIDATION", `Invalid request parameters — ${issues}`, {
    hint: "Fix the named parameters and call again. Request parameters are snake_case, e.g. location_id, start_time, dry_run.",
  });
}

/** Reads a JSON body, treating an absent or malformed one as a `VALIDATION` error. */
async function jsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) {
    throw new AppError("VALIDATION", "A JSON request body is required.", {
      hint: 'POST /api/bookings takes {"quote": "...", "idempotency_key": "..."}.',
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION", "The request body is not valid JSON.");
  }
}
