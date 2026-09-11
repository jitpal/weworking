/**
 * `refreshSession` — the grant this worker lives on.
 *
 * The cases that matter operationally: the exact request shape, *keeping* the old
 * refresh token when Auth0 does not rotate one (dropping it silently downgrades a
 * permanent session to a 12-hour one), and mapping `invalid_grant` to a terminal
 * `UPSTREAM_AUTH` rather than something a caller might retry forever.
 */

import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/core/types";
import { isAppError } from "../../src/errors";
import { FALLBACK_AUTH0_CONFIG } from "../../src/wework/auth/config";
import { refreshSession } from "../../src/wework/auth/refresh";
import tokenResponse from "../fixtures/wework/token-response.json";
import noRefresh from "../fixtures/wework/token-response-no-refresh.json";
import rotated from "../fixtures/wework/token-response-rotated.json";
import { createFakeFetch } from "../helpers/fake-fetch";
import {
  FIXTURE_ACCESS_TOKEN,
  FIXTURE_EXPIRES_AT_MS,
  FIXTURE_REFRESH_TOKEN,
  FIXTURE_USER_UUID,
  IDP,
  jsonBody,
  NOW_MS,
  now,
} from "./helpers";

const TOKEN_URL = `${IDP}/oauth/token`;

const stored: SessionRecord = {
  accessToken: "FAKE-OLD-ACCESS-TOKEN",
  refreshToken: FIXTURE_REFRESH_TOKEN,
  expiresAt: NOW_MS - 1000,
  obtainedAt: NOW_MS - 43_200_000,
  source: "login",
  userUuid: FIXTURE_USER_UUID,
};

/** A fetch stub answering the token endpoint once with `body`. */
function tokenFetch(body: unknown, init?: ResponseInit) {
  return createFakeFetch([
    {
      method: "POST",
      url: TOKEN_URL,
      times: 1,
      response: () => new Response(JSON.stringify(body), init),
    },
  ]);
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected an AppError with code ${code}`);
}

describe("refreshSession — request shape", () => {
  it("posts the refresh_token grant as JSON to the tenant token endpoint", async () => {
    const fetchStub = tokenFetch(tokenResponse);
    await refreshSession(stored, { fetch: fetchStub, now });

    const call = fetchStub.calls[0];
    expect(call?.url).toBe(TOKEN_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.headers["auth0-client"]).toBeTypeOf("string");
    expect(jsonBody(call?.body)).toEqual({
      grant_type: "refresh_token",
      client_id: FALLBACK_AUTH0_CONFIG.clientId,
      refresh_token: FIXTURE_REFRESH_TOKEN,
      redirect_uri: FALLBACK_AUTH0_CONFIG.redirectUri,
    });
    fetchStub.assertAllConsumed();
  });

  it("uses an injected config instead of the pinned constants", async () => {
    const fetchStub = createFakeFetch([
      {
        method: "POST",
        url: "https://tenant.example.invalid/oauth/token",
        times: 1,
        response: () => Response.json(tokenResponse),
      },
    ]);
    await refreshSession(stored, {
      fetch: fetchStub,
      now,
      config: { ...FALLBACK_AUTH0_CONFIG, domain: "tenant.example.invalid" },
    });
    fetchStub.assertAllConsumed();
  });

  it("sends no Cookie header — the refresh is a bare API call", async () => {
    const fetchStub = tokenFetch(tokenResponse);
    await refreshSession(stored, { fetch: fetchStub, now });
    expect(fetchStub.calls[0]?.headers.cookie).toBeUndefined();
  });
});

describe("refreshSession — result", () => {
  it("returns a refresh-sourced record with the exp claim as expiresAt", async () => {
    const session = await refreshSession(stored, { fetch: tokenFetch(tokenResponse), now });
    expect(session).toEqual({
      accessToken: FIXTURE_ACCESS_TOKEN,
      refreshToken: FIXTURE_REFRESH_TOKEN,
      expiresAt: FIXTURE_EXPIRES_AT_MS,
      obtainedAt: NOW_MS,
      source: "refresh",
      userUuid: FIXTURE_USER_UUID,
    });
  });

  it("keeps the stored refresh token when the response omits one", async () => {
    const session = await refreshSession(stored, { fetch: tokenFetch(noRefresh), now });
    expect(session.refreshToken).toBe(FIXTURE_REFRESH_TOKEN);
  });

  it("adopts a rotated refresh token when the response carries one", async () => {
    const session = await refreshSession(stored, { fetch: tokenFetch(rotated), now });
    expect(session.refreshToken).toBe(rotated.refresh_token);
    expect(session.refreshToken).not.toBe(FIXTURE_REFRESH_TOKEN);
  });

  it("falls back to expires_in when the access token has no exp claim", async () => {
    // A deliberately opaque (non-JWT) access token, as Auth0 can issue.
    const fetchStub = tokenFetch({ access_token: "opaque-token", expires_in: 600 });
    await expectAppError(refreshSession(stored, { fetch: fetchStub, now }), "UPSTREAM_AUTH");
  });
});

describe("refreshSession — failures", () => {
  it("maps invalid_grant to UPSTREAM_AUTH", async () => {
    const fetchStub = tokenFetch(
      { error: "invalid_grant", error_description: "Unknown or invalid refresh token." },
      { status: 403 },
    );
    const error = await expectAppError(
      refreshSession(stored, { fetch: fetchStub, now }),
      "UPSTREAM_AUTH",
    );
    expect(error.message).toContain("Unknown or invalid refresh token");
  });

  it("maps a 429 to UPSTREAM_RATE_LIMITED", async () => {
    const fetchStub = tokenFetch({ error: "too_many_requests" }, { status: 429 });
    await expectAppError(
      refreshSession(stored, { fetch: fetchStub, now }),
      "UPSTREAM_RATE_LIMITED",
    );
  });

  it("maps requires_verification to UPSTREAM_BLOCKED", async () => {
    const fetchStub = tokenFetch({ error: "requires_verification" }, { status: 400 });
    await expectAppError(refreshSession(stored, { fetch: fetchStub, now }), "UPSTREAM_BLOCKED");
  });

  it("maps a 500 to UPSTREAM_ERROR", async () => {
    const fetchStub = tokenFetch({ error: "server_error" }, { status: 500 });
    await expectAppError(refreshSession(stored, { fetch: fetchStub, now }), "UPSTREAM_ERROR");
  });

  it("maps a non-JSON body to UPSTREAM_ERROR", async () => {
    const fetchStub = createFakeFetch([
      { method: "POST", url: TOKEN_URL, response: () => new Response("<html>nope</html>") },
    ]);
    await expectAppError(refreshSession(stored, { fetch: fetchStub, now }), "UPSTREAM_ERROR");
  });

  it("refuses to call upstream at all when there is no refresh token", async () => {
    const fetchStub = createFakeFetch([]);
    const noToken: SessionRecord = { ...stored };
    delete noToken.refreshToken;
    const error = await expectAppError(
      refreshSession(noToken, { fetch: fetchStub, now }),
      "UPSTREAM_AUTH",
    );
    expect(error.hint).toContain("/admin/connect");
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("never puts the refresh token in an error message", async () => {
    const fetchStub = tokenFetch({ error: "invalid_grant" }, { status: 403 });
    const error = await expectAppError(
      refreshSession(stored, { fetch: fetchStub, now }),
      "UPSTREAM_AUTH",
    );
    expect(`${error.message} ${error.hint ?? ""}`).not.toContain(FIXTURE_REFRESH_TOKEN);
  });
});
