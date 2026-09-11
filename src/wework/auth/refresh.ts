/**
 * The refresh-token grant — the only way this worker should normally obtain a token.
 *
 * Headless login is fragile by design (Auth0 bot protection, MFA, TLS
 * fingerprinting); a refresh is a single JSON POST with no redirects, no cookies
 * and no HTML parsing, so it works reliably from a datacenter IP. The intended
 * lifecycle is therefore: one interactive login from a real browser, then refresh
 * forever — lazily on a 401 and proactively from the daily cron.
 *
 * `offline_access` must have been in the original scope for a refresh token to
 * exist at all; see `FALLBACK_AUTH0_CONFIG.scope`.
 */

import type { SessionRecord } from "../../core/types";
import { AppError } from "../../errors";
import { type Auth0Config, FALLBACK_AUTH0_CONFIG } from "./config";
import { postTokenEndpoint, sessionFromTokenResponse } from "./token-exchange";

/** Options for {@link refreshSession}. */
export interface RefreshOptions {
  fetch: typeof fetch;
  /** Injected clock (epoch ms). */
  now?: () => number;
  /**
   * Tenant parameters. Defaults to the pinned constants rather than calling
   * discovery, so a refresh costs exactly one subrequest — it runs on the hot path
   * of every 401 retry and inside the cron alongside other work.
   */
  config?: Auth0Config;
  userAgent?: string;
}

/**
 * Exchanges the stored refresh token for a fresh access token.
 *
 * The returned record keeps the existing refresh token when Auth0 does not rotate
 * one, and carries `source: "refresh"`.
 *
 * @throws {AppError} `UPSTREAM_AUTH` when the grant is rejected (`invalid_grant` —
 * the refresh token was revoked, rotated away or belongs to another client) or when
 * there is no refresh token to use; `UPSTREAM_RATE_LIMITED` on 429;
 * `UPSTREAM_ERROR` on anything else.
 *
 * @example
 * const next = await refreshSession(stored, { fetch });
 * await tokenStore.setSession(next);
 */
export async function refreshSession(
  rec: SessionRecord,
  opts: RefreshOptions,
): Promise<SessionRecord> {
  const now = opts.now ?? Date.now;
  const config = opts.config ?? FALLBACK_AUTH0_CONFIG;

  if (!rec.refreshToken) {
    throw new AppError(
      "UPSTREAM_AUTH",
      "The stored WeWork session has no refresh token, so it cannot be renewed.",
      {
        hint: "Ask the user to reconnect at <base>/admin/connect; make sure the login scope includes offline_access.",
      },
    );
  }

  const raw = await postTokenEndpoint({
    fetch: opts.fetch,
    config,
    grantLabel: "refresh_token",
    ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}),
    body: {
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: rec.refreshToken,
      redirect_uri: config.redirectUri,
    },
  });

  const session = sessionFromTokenResponse({
    raw,
    now,
    source: "refresh",
    previousRefreshToken: rec.refreshToken,
  });

  return { ...session, obtainedAt: now() };
}
