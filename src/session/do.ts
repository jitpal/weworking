/**
 * `WeWorkSession` — the single stateful component of this worker.
 *
 * One SQLite-backed Durable Object instance (id `"session:default"`) owns:
 *   - the WeWork access/refresh token, and the mutex that coalesces concurrent
 *     refresh or login attempts into one upstream call;
 *   - the idempotency table, so a retried `create_booking` cannot double-book;
 *   - the booking ledger that enforces the daily/weekly caps;
 *   - the audit log.
 *
 * Keeping all of that in one object is what makes the caps and the mutex correct:
 * a Durable Object serialises its own requests, so no two bookings race.
 *
 * STATUS: scaffold. This class is deliberately a stub — the session engineer
 * replaces the body with the schema and RPC methods described in docs/DESIGN.md §7
 * (`getAccessToken`, `setSession`, `getSessionInfo`, `clearSession`,
 * `checkAndReserveCap`, `recordBooking`, `releaseBooking`, `idempotencyGet/Put`,
 * `audit`, `listAudit`, `maintain`). Do not add business logic to the worker side
 * that belongs here.
 *
 * Invariant for every future method: tokens never appear in a return value, an
 * error message or a log line. Only `getAccessToken` returns one, and only to the
 * `WeWorkClient`.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/** The Durable Object id every request uses in phase 1 (single WeWork account). */
export const SESSION_DO_NAME = "session:default";

export class WeWorkSession extends DurableObject<Env> {
  /**
   * Liveness probe used by `/healthz` and the smoke test: proves the binding,
   * the SQLite migration and RPC all work without touching any state.
   *
   * @returns the current Durable Object wall-clock time, in epoch milliseconds.
   */
  ping(): { ok: true; now: number } {
    return { ok: true, now: Date.now() };
  }
}

/**
 * Resolves the one session Durable Object stub.
 *
 * Always go through this helper rather than calling `idFromName` inline, so the
 * single-instance invariant (and the future multi-account seam) lives in one place.
 */
export function getSessionStub(
  env: Env,
  accountId = "default",
): DurableObjectStub<WeWorkSession> {
  const name = accountId === "default" ? SESSION_DO_NAME : `session:${accountId}`;
  return env.SESSION.get(env.SESSION.idFromName(name));
}
