/**
 * PKCE primitives. The S256 vector is RFC 7636's own appendix B example, which is
 * the only way to be sure the base64url encoding is right rather than merely
 * self-consistent.
 */

import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlDecodeToString,
  base64UrlEncode,
  CODE_CHALLENGE_METHOD,
  createCodeChallenge,
  createCodeVerifier,
  createPkcePair,
  randomBase64Url,
  randomNonce,
  randomState,
} from "../../src/wework/auth/pkce";

describe("base64url", () => {
  it("encodes without padding and with the url-safe alphabet", () => {
    // 0xfb 0xff would be "+/8=" in standard base64.
    expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe("-_8");
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(37);
    crypto.getRandomValues(bytes);
    expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes]);
  });

  it("accepts an ArrayBuffer as well as a Uint8Array", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(base64UrlEncode(bytes.buffer)).toBe(base64UrlEncode(bytes));
  });

  it("decodes utf-8 text, which is how JWT payloads are read", () => {
    expect(base64UrlDecodeToString(base64UrlEncode(new TextEncoder().encode('{"a":1}')))).toBe(
      '{"a":1}',
    );
  });
});

describe("createCodeChallenge", () => {
  it("matches the RFC 7636 appendix B vector", async () => {
    await expect(createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("createCodeVerifier", () => {
  it("is 43 unreserved characters, as RFC 7636 requires", () => {
    const verifier = createCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 20 }, () => createCodeVerifier()));
    expect(seen.size).toBe(20);
  });
});

describe("createPkcePair", () => {
  it("derives the challenge from its own verifier and declares S256", async () => {
    const pair = await createPkcePair();
    expect(pair.codeChallengeMethod).toBe(CODE_CHALLENGE_METHOD);
    expect(pair.codeChallengeMethod).toBe("S256");
    await expect(createCodeChallenge(pair.codeVerifier)).resolves.toBe(pair.codeChallenge);
  });

  it("produces a challenge that is safe in a query string", async () => {
    const pair = await createPkcePair();
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(encodeURIComponent(pair.codeChallenge)).toBe(pair.codeChallenge);
  });
});

describe("randomState / randomNonce", () => {
  it("are opaque, url-safe and unique", () => {
    const values = [randomState(), randomState(), randomNonce(), randomNonce()];
    expect(new Set(values).size).toBe(4);
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9\-_]{22}$/);
    }
  });

  it("randomBase64Url honours the requested entropy", () => {
    // 32 bytes -> ceil(32/3)*4 minus padding = 43 characters.
    expect(randomBase64Url(32)).toHaveLength(43);
    expect(randomBase64Url(16)).toHaveLength(22);
  });
});
