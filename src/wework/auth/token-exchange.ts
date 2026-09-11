/**
 * The `POST /oauth/token` call, shared by the authorization-code exchange at the end
 * of a headless login and by the refresh-token grant.
 *
 * Internal to `src/wework/auth/`; the public surface is `createHeadlessLoginStrategy`
 * and `refreshSession` (see `src/wework/auth/index.ts`).
 *
 * Auth0 returns errors here as a JSON body with an `error` code and HTTP 400/401,
 * so the status alone is not enough to classify a failure — `invalid_grant` on a
 * refresh means "the user revoked us, reconnect" and must not be retried, while
 * `requires_verification` means bot protection tripped and no amount of retrying
 * will help either. Both map to terminal error codes, never to a retry.
 */

import type { SessionRecord } from "../../core/types";
import { AppError } from "../../errors";
import { redact } from "../../redact";
import { DESKTOP_USER_AGENT, MEMBERS_ORIGIN } from "../headers";
import { AUTH0_CLIENT_HEADER, type Auth0Config, authUrl } from "./config";
import { decodeJwtPayload, USER_UUID_CLAIM } from "./manual";

/** The subset of Auth0's token response we read. */
export interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** Arguments for {@link postTokenEndpoint}. */
export interface TokenRequestArgs {
  fetch: typeof fetch;
  config: Auth0Config;
  /** Form fields; sent as JSON, which is what auth0-spa-js 2.x does. */
  body: Record<string, string>;
  userAgent?: string;
  /** Labels the operation in error messages, e.g. `"authorization_code"`. */
  grantLabel: string;
}

/**
 * Calls the tenant token endpoint and returns the parsed body.
 *
 * @throws {AppError} `UPSTREAM_AUTH` for `invalid_grant` / `invalid_request` /
 * 401 / 403, `UPSTREAM_BLOCKED` for `requires_verification`,
 * `UPSTREAM_RATE_LIMITED` for 429, `UPSTREAM_ERROR` otherwise.
 */
export async function postTokenEndpoint(args: TokenRequestArgs): Promise<RawTokenResponse> {
  const url = authUrl(args.config, "/oauth/token");
  const response = await args.fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Auth0-Client": AUTH0_CLIENT_HEADER,
      Origin: MEMBERS_ORIGIN,
      Referer: `${MEMBERS_ORIGIN}/`,
      "User-Agent": args.userAgent ?? DESKTOP_USER_AGENT,
    },
    body: JSON.stringify(args.body),
  });

  const text = await response.text();
  let parsed: RawTokenResponse | undefined;
  try {
    const json: unknown = JSON.parse(text);
    if (typeof json === "object" && json !== null) parsed = json as RawTokenResponse;
  } catch {
    parsed = undefined;
  }

  const errorCode = typeof parsed?.error === "string" ? parsed.error : undefined;
  const description =
    typeof parsed?.error_description === "string" ? parsed.error_description : undefined;

  if (response.status === 429) {
    throw new AppError(
      "UPSTREAM_RATE_LIMITED",
      `Auth0 rate-limited the ${args.grantLabel} token request.`,
    );
  }

  if (errorCode === "requires_verification" || /captcha|verification/i.test(description ?? "")) {
    throw new AppError(
      "UPSTREAM_BLOCKED",
      "Auth0 requires human verification before issuing a token.",
    );
  }

  if (!response.ok || errorCode) {
    const rejected =
      response.status === 401 ||
      response.status === 403 ||
      errorCode === "invalid_grant" ||
      errorCode === "invalid_request" ||
      errorCode === "invalid_client" ||
      errorCode === "unauthorized_client" ||
      errorCode === "access_denied";

    // `description` is Auth0 copy such as "Unknown or invalid refresh token" — safe
    // to surface; it never contains the token itself.
    const detail = description ?? errorCode ?? `HTTP ${response.status}`;
    if (rejected) {
      throw new AppError("UPSTREAM_AUTH", `Auth0 rejected the ${args.grantLabel} grant: ${detail}`);
    }
    console.warn(
      "[wework] unexpected token endpoint response",
      redact({ grant: args.grantLabel, status: response.status, error: errorCode }),
    );
    throw new AppError(
      "UPSTREAM_ERROR",
      `Auth0 token endpoint returned an unexpected response for the ${args.grantLabel} grant: ${detail}`,
    );
  }

  if (!parsed) {
    throw new AppError(
      "UPSTREAM_ERROR",
      `Auth0 token endpoint returned a non-JSON body for the ${args.grantLabel} grant.`,
    );
  }
  return parsed;
}

/** Arguments for {@link sessionFromTokenResponse}. */
export interface SessionFromTokenArgs {
  raw: RawTokenResponse;
  now: () => number;
  source: SessionRecord["source"];
  /**
   * Refresh token to keep when the response omits one. Auth0 only re-issues a
   * refresh token when rotation is enabled, so dropping the old one on a refresh
   * would silently turn a long-lived session into a 12-hour one.
   */
  previousRefreshToken?: string;
}

/**
 * Converts a token response into a {@link SessionRecord}.
 *
 * `expiresAt` prefers the access token's own `exp` claim over `expires_in`, because
 * `exp` is what WeWork's gateway actually enforces and is immune to clock skew
 * between the Worker and Auth0.
 *
 * @throws {AppError} `UPSTREAM_ERROR` when the response has no access token, and
 * `UPSTREAM_AUTH` when the token carries no WeWork member id (which would make
 * every API call fail with an empty payload).
 */
export function sessionFromTokenResponse(
  args: SessionFromTokenArgs,
): Omit<SessionRecord, "obtainedAt"> {
  const accessToken = typeof args.raw.access_token === "string" ? args.raw.access_token : "";
  if (!accessToken) {
    throw new AppError("UPSTREAM_ERROR", "Auth0 returned no access_token.");
  }

  let claims: Record<string, unknown> = {};
  try {
    claims = decodeJwtPayload(accessToken);
  } catch {
    claims = {};
  }

  const exp = typeof claims.exp === "number" ? claims.exp : undefined;
  const expiresIn =
    typeof args.raw.expires_in === "number"
      ? args.raw.expires_in
      : typeof args.raw.expires_in === "string"
        ? Number.parseInt(args.raw.expires_in, 10)
        : undefined;

  const expiresAt =
    exp !== undefined
      ? exp * 1000
      : expiresIn !== undefined && Number.isFinite(expiresIn)
        ? args.now() + expiresIn * 1000
        : undefined;

  if (expiresAt === undefined) {
    throw new AppError(
      "UPSTREAM_ERROR",
      "Auth0 returned a token with neither an `exp` claim nor `expires_in`.",
    );
  }

  const userUuid = typeof claims[USER_UUID_CLAIM] === "string" ? claims[USER_UUID_CLAIM] : "";
  if (!userUuid) {
    throw new AppError(
      "UPSTREAM_AUTH",
      `The access token is missing the "${USER_UUID_CLAIM}" claim, so WeWork API calls would be rejected.`,
      {
        hint: "Check that the Auth0 audience is 'wework'. If it is, the tenant's claim mapping changed and this worker needs updating.",
      },
    );
  }

  const refreshToken =
    typeof args.raw.refresh_token === "string" && args.raw.refresh_token
      ? args.raw.refresh_token
      : args.previousRefreshToken;

  const record: Omit<SessionRecord, "obtainedAt"> = {
    accessToken,
    expiresAt,
    source: args.source,
    userUuid,
  };
  if (refreshToken) record.refreshToken = refreshToken;
  return record;
}
