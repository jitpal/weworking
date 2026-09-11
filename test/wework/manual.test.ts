/**
 * `parseManualSession` and `decodeJwtPayload`.
 *
 * This parser is the escape hatch a human uses when headless login is blocked, so
 * the tests cover every input shape the connect page documents *and* the sloppy
 * copy-paste variants of them, plus every failure mode — because a bad error message
 * here is a support ticket, not a stack trace.
 */

import { describe, expect, it } from "vitest";
import { isAppError } from "../../src/errors";
import { decodeJwtPayload, parseManualSession } from "../../src/wework/auth/manual";
import { base64UrlEncode } from "../../src/wework/auth/pkce";
import dump from "../fixtures/wework/localstorage-dump.json";
import tokenResponse from "../fixtures/wework/token-response.json";
import {
  FIXTURE_ACCESS_TOKEN,
  FIXTURE_EXPIRES_AT_MS,
  FIXTURE_REFRESH_TOKEN,
  FIXTURE_USER_UUID,
  NOW_MS,
  now,
} from "./helpers";

const SPA_KEY =
  "@@auth0spajs@@::zE51Ep7FttlmtQV6ZEGyJKsY2jD1EtAu::wework::openid profile email offline_access";

/** Builds a JWT with an arbitrary payload and an unverifiable signature. */
function fakeJwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  return `${segment({ alg: "RS256", typ: "JWT" })}.${segment(payload)}.FAKE-SIGNATURE`;
}

/** Asserts a thrown `AppError` has the expected code, and returns it. */
function expectAppError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    if (!isAppError(error)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected an AppError with code ${code}`);
}

describe("decodeJwtPayload", () => {
  it("decodes the fixture token's claims", () => {
    const claims = decodeJwtPayload(FIXTURE_ACCESS_TOKEN);
    expect(claims["https://wework.com/user_uuid"]).toBe(FIXTURE_USER_UUID);
    expect(claims.aud).toEqual(["wework", "https://idp.wework.com/userinfo"]);
    expect(claims.exp).toBe(FIXTURE_EXPIRES_AT_MS / 1000);
  });

  it("tolerates a Bearer prefix and surrounding whitespace", () => {
    const claims = decodeJwtPayload(`  Bearer ${FIXTURE_ACCESS_TOKEN}\n`);
    expect(claims["https://wework.com/user_uuid"]).toBe(FIXTURE_USER_UUID);
  });

  it("rejects a non-JWT", () => {
    expectAppError(() => decodeJwtPayload("not-a-token"), "VALIDATION");
  });

  it("rejects a JWT whose payload is not JSON", () => {
    expectAppError(() => decodeJwtPayload("aaa.bm90LWpzb24.sig"), "VALIDATION");
  });

  it("rejects a JWT whose payload is a JSON array", () => {
    expectAppError(() => decodeJwtPayload(`aaa.${base64UrlEncode(new TextEncoder().encode("[1]"))}.s`), "VALIDATION");
  });
});

describe("parseManualSession — accepted shapes", () => {
  it("a bare JWT", () => {
    const session = parseManualSession(FIXTURE_ACCESS_TOKEN, now);
    expect(session).toEqual({
      accessToken: FIXTURE_ACCESS_TOKEN,
      expiresAt: FIXTURE_EXPIRES_AT_MS,
      source: "manual",
      userUuid: FIXTURE_USER_UUID,
    });
  });

  it('a "Bearer xxx" string', () => {
    expect(parseManualSession(`Bearer ${FIXTURE_ACCESS_TOKEN}`, now).accessToken).toBe(
      FIXTURE_ACCESS_TOKEN,
    );
  });

  it("a token with stray whitespace, quotes and a trailing semicolon", () => {
    const messy = `  "${FIXTURE_ACCESS_TOKEN}" ;  `;
    expect(parseManualSession(messy, now).accessToken).toBe(FIXTURE_ACCESS_TOKEN);
  });

  it("the raw token response object", () => {
    const session = parseManualSession(tokenResponse, now);
    expect(session.accessToken).toBe(FIXTURE_ACCESS_TOKEN);
    expect(session.refreshToken).toBe(FIXTURE_REFRESH_TOKEN);
    // exp from the claims beats expires_in.
    expect(session.expiresAt).toBe(FIXTURE_EXPIRES_AT_MS);
  });

  it("the raw token response as a JSON string", () => {
    expect(parseManualSession(JSON.stringify(tokenResponse), now).refreshToken).toBe(
      FIXTURE_REFRESH_TOKEN,
    );
  });

  it("a single Auth0 SPA cache entry", () => {
    const entry = (dump as Record<string, unknown>)[SPA_KEY];
    const session = parseManualSession(entry as object, now);
    expect(session.accessToken).toBe(FIXTURE_ACCESS_TOKEN);
    expect(session.refreshToken).toBe(FIXTURE_REFRESH_TOKEN);
    expect(session.source).toBe("manual");
  });

  it("an SPA cache entry whose value is still a JSON string", () => {
    const entry = (dump as Record<string, unknown>)[SPA_KEY];
    const session = parseManualSession({ [SPA_KEY]: JSON.stringify(entry) }, now);
    expect(session.accessToken).toBe(FIXTURE_ACCESS_TOKEN);
  });

  it("the whole localStorage dump, ignoring unrelated keys", () => {
    const session = parseManualSession(dump, now);
    expect(session.accessToken).toBe(FIXTURE_ACCESS_TOKEN);
    expect(session.refreshToken).toBe(FIXTURE_REFRESH_TOKEN);
  });

  it("picks the wework-audience token, not the userinfo one", () => {
    // The dump's second entry has audience https://idp.wework.com/userinfo, no
    // member id, and an earlier exp. It must lose.
    const session = parseManualSession(dump, now);
    const claims = decodeJwtPayload(session.accessToken);
    expect(claims.aud).toContain("wework");
    expect(session.expiresAt).toBe(FIXTURE_EXPIRES_AT_MS);
  });

  it("picks the latest exp among equally-suitable tokens", () => {
    const older = fakeJwt({
      aud: ["wework"],
      exp: Math.floor(NOW_MS / 1000) + 600,
      "https://wework.com/user_uuid": FIXTURE_USER_UUID,
    });
    const newer = fakeJwt({
      aud: ["wework"],
      exp: Math.floor(NOW_MS / 1000) + 7200,
      "https://wework.com/user_uuid": FIXTURE_USER_UUID,
    });
    const session = parseManualSession(
      {
        "@@auth0spajs@@::c::wework::a": { body: { access_token: older } },
        "@@auth0spajs@@::c::wework::b": { body: { access_token: newer } },
      },
      now,
    );
    expect(session.accessToken).toBe(newer);
    expect(session.expiresAt).toBe((Math.floor(NOW_MS / 1000) + 7200) * 1000);
  });

  it("falls back to the entry's expiresAt in seconds when the token has no exp", () => {
    const noExp = fakeJwt({
      aud: ["wework"],
      "https://wework.com/user_uuid": FIXTURE_USER_UUID,
    });
    const expiresAtSeconds = Math.floor(NOW_MS / 1000) + 3600;
    const session = parseManualSession(
      { body: { access_token: noExp }, expiresAt: expiresAtSeconds },
      now,
    );
    expect(session.expiresAt).toBe(expiresAtSeconds * 1000);
  });

  it("falls back to expires_in when there is no exp and no expiresAt", () => {
    const noExp = fakeJwt({
      aud: ["wework"],
      "https://wework.com/user_uuid": FIXTURE_USER_UUID,
    });
    const session = parseManualSession({ access_token: noExp, expires_in: 1800 }, now);
    expect(session.expiresAt).toBe(NOW_MS + 1_800_000);
  });

  it("accepts camelCase keys and an expires_at already in milliseconds", () => {
    const noExp = fakeJwt({
      aud: ["wework"],
      "https://wework.com/user_uuid": FIXTURE_USER_UUID,
    });
    const session = parseManualSession(
      { accessToken: noExp, refreshToken: "FAKE-R", expiresAt: NOW_MS + 60_000 },
      now,
    );
    expect(session.expiresAt).toBe(NOW_MS + 60_000);
    expect(session.refreshToken).toBe("FAKE-R");
  });

  it("unwraps a one-level wrapper such as { session: ... }", () => {
    const session = parseManualSession({ session: tokenResponse }, now);
    expect(session.accessToken).toBe(FIXTURE_ACCESS_TOKEN);
  });

  it("omits refreshToken rather than setting it to an empty string", () => {
    const session = parseManualSession({ access_token: FIXTURE_ACCESS_TOKEN, refresh_token: "" }, now);
    expect("refreshToken" in session).toBe(false);
  });
});

describe("parseManualSession — failures", () => {
  it("empty input", () => {
    const error = expectAppError(() => parseManualSession("   ", now), "VALIDATION");
    expect(error.hint).toBeTypeOf("string");
  });

  it("JSON that does not parse", () => {
    expectAppError(() => parseManualSession('{"access_token": ', now), "VALIDATION");
  });

  it("an object with no token anywhere", () => {
    expectAppError(() => parseManualSession({ hello: "world" }, now), "VALIDATION");
  });

  it("a token with no user_uuid claim", () => {
    const noUuid = fakeJwt({ aud: ["wework"], exp: Math.floor(NOW_MS / 1000) + 600 });
    const error = expectAppError(() => parseManualSession(noUuid, now), "VALIDATION");
    expect(error.message).toContain("https://wework.com/user_uuid");
  });

  it("an already-expired token", () => {
    const expired = fakeJwt({
      aud: ["wework"],
      exp: Math.floor(NOW_MS / 1000) - 60,
      "https://wework.com/user_uuid": FIXTURE_USER_UUID,
    });
    const error = expectAppError(() => parseManualSession(expired, now), "VALIDATION");
    expect(error.message).toMatch(/expired/i);
  });

  it("a token with no expiry information at all", () => {
    const noExpiry = fakeJwt({
      aud: ["wework"],
      "https://wework.com/user_uuid": FIXTURE_USER_UUID,
    });
    const error = expectAppError(() => parseManualSession(noExpiry, now), "VALIDATION");
    expect(error.message).toMatch(/expires/i);
  });

  it("never echoes the pasted value back in the error", () => {
    const secret = `Bearer ${"S3CRET".repeat(6)}`;
    const error = expectAppError(() => parseManualSession(secret, now), "VALIDATION");
    expect(`${error.message} ${error.hint ?? ""}`).not.toContain("S3CRET");
  });
});
