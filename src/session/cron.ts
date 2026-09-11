/**
 * Scheduled maintenance (cron `17 5 * * *`).
 *
 * All the work happens inside the Durable Object — see
 * {@link WeWorkSession.maintain}: refresh the WeWork token while it is still valid
 * (so a user who never visits `/admin` keeps a working session), then prune expired
 * idempotency rows, audit rows older than 90 days and abandoned reservations.
 *
 * This wrapper exists to keep `src/index.ts` free of session logic and to guarantee
 * two things: the summary that reaches the log is redacted, and a failure never
 * throws out of the cron handler (a throwing handler is retried, which would hammer
 * Auth0 with login attempts).
 */

import type { Env } from "../env";
import { toErrorBody } from "../errors";
import { redact } from "../redact";
import { getSessionStub } from "./do";

/**
 * Runs one maintenance pass against the session Durable Object.
 *
 * @param env worker bindings; `env.SESSION` is the only one used.
 * @returns always resolves — failures are logged, not thrown.
 */
export async function runScheduled(env: Env): Promise<void> {
  try {
    const summary = await getSessionStub(env).maintain();
    // A purpose-built, flat log line: every field is a boolean, a number, an enum or
    // an ISO timestamp, so no token can appear even by accident. (Handing the whole
    // summary to `redact()` would be safe too, but its key heuristic matches
    // "refreshed"/"hasRefreshToken" and would hide the only interesting fields.)
    console.log(
      "session:maintain",
      JSON.stringify(
        redact({
          renewed: summary.refreshed,
          pruned: summary.pruned,
          state: summary.session.state,
          source: summary.session.source,
          expiresAt: summary.session.expiresAt ?? "none",
          error: summary.error ?? summary.session.lastError ?? "none",
        }),
      ),
    );
  } catch (err) {
    console.error("session:maintain failed", JSON.stringify(redact(toErrorBody(err))));
  }
}
