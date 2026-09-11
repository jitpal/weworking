/**
 * TEMP: replace with "../wework/auth" at integration.
 *
 * `src/session/do.ts` needs two functions from the WeWork auth module (§11.1 of the
 * build spec) that another engineer is writing concurrently:
 *
 * ```ts
 * export function createHeadlessLoginStrategy(opts: HeadlessLoginOptions): LoginStrategy;
 * export function refreshSession(rec: SessionRecord, opts: RefreshOptions): Promise<SessionRecord>;
 * ```
 *
 * Until `src/wework/auth/index.ts` exists this module stands in for it so the
 * session module typechecks and tests on its own. It never reaches the network: both
 * stubs throw `UPSTREAM_ERROR`.
 *
 * ## Integration (one edit, no changes in `do.ts`)
 *
 * Replace the two stub bodies below with a single re-export:
 *
 * ```ts
 * export { createHeadlessLoginStrategy, refreshSession } from "../wework/auth";
 * ```
 *
 * …or point `do.ts`'s import at `"../wework/auth"` and delete this file. The session
 * tests mock *this* module path, so they keep passing either way.
 */

import type { LoginStrategy, SessionRecord } from "../core/types";
import { AppError } from "../errors";

/** Options accepted by {@link createHeadlessLoginStrategy} (spec §11.1). */
export interface HeadlessLoginOptions {
  username: string;
  password: string;
  fetch: typeof fetch;
  now?: () => number;
}

/** Options accepted by {@link refreshSession} (spec §11.1). */
export interface RefreshOptions {
  fetch: typeof fetch;
  now?: () => number;
}

const NOT_IMPLEMENTED =
  "The WeWork auth module is not wired up in this build (src/session/_auth-shim.ts is still a stub).";

/**
 * Strategy A — Auth0 PKCE login with the stored username/password.
 *
 * Real implementation: `src/wework/auth/headless-login.ts`. Throws `UPSTREAM_BLOCKED`
 * when Auth0 demands verification or a captcha, `UPSTREAM_AUTH` on bad credentials,
 * `UPSTREAM_RATE_LIMITED` after exhausting 429 retries, `UPSTREAM_ERROR` otherwise.
 */
export function createHeadlessLoginStrategy(_opts: HeadlessLoginOptions): LoginStrategy {
  return {
    name: "headless",
    login(): Promise<SessionRecord> {
      return Promise.reject(new AppError("UPSTREAM_ERROR", NOT_IMPLEMENTED));
    },
  };
}

/**
 * `refresh_token` grant against Auth0; resolves to a record with `source: "refresh"`.
 *
 * Real implementation: `src/wework/auth/refresh.ts`. Throws `UPSTREAM_AUTH` when the
 * refresh token is rejected (`invalid_grant`).
 */
export function refreshSession(
  _rec: SessionRecord,
  _opts: RefreshOptions,
): Promise<SessionRecord> {
  return Promise.reject(new AppError("UPSTREAM_ERROR", NOT_IMPLEMENTED));
}
