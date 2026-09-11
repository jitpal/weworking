/**
 * API key minting and the primitives every credential check is built on.
 *
 * The invariant this file pins down: a key is `ww_` plus 32 random bytes, and
 * nothing in the module can hand back a key from its digest.
 */

import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  bytesToBase64Url,
  bytesToHex,
  constantTimeEqual,
  generateApiKey,
  looksLikeApiKey,
  sha256Hex,
} from "../../src/auth/tokens";

describe("sha256Hex", () => {
  it("matches the known SHA-256 of 'abc'", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns 64 lower-case hex characters", async () => {
    await expect(sha256Hex("dev-token")).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("bytesToHex and bytesToBase64Url", () => {
  it("renders bytes as lower-case hex", () => {
    expect(bytesToHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
  });

  it("renders bytes as unpadded, URL-safe base64", () => {
    const encoded = bytesToBase64Url(new Uint8Array([251, 255, 190, 255]));
    expect(encoded).toBe("-_--_w");
    expect(encoded).not.toContain("=");
    expect(encoded).not.toMatch(/[+/]/);
  });
});

describe("constantTimeEqual", () => {
  it("is true only for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("handles different lengths and empty strings without throwing", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual("a", "")).toBe(false);
  });

  it("compares every byte, not just the prefix", () => {
    const digest = "a".repeat(63);
    expect(constantTimeEqual(`${digest}b`, `${digest}c`)).toBe(false);
  });
});

describe("generateApiKey", () => {
  it("mints a prefixed, base64url key with its matching digest", async () => {
    const { token, sha256 } = await generateApiKey();
    expect(token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(token.slice(API_KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(sha256Hex(token)).resolves.toBe(sha256);
  });

  it("never repeats a key", async () => {
    const minted = await Promise.all(Array.from({ length: 20 }, () => generateApiKey()));
    expect(new Set(minted.map((key) => key.token)).size).toBe(20);
    expect(new Set(minted.map((key) => key.sha256)).size).toBe(20);
  });

  it("does not leak the key into its digest", async () => {
    const { token, sha256 } = await generateApiKey();
    expect(sha256).not.toContain(token.slice(API_KEY_PREFIX.length, 12));
  });
});

describe("looksLikeApiKey", () => {
  it("accepts a minted key and rejects anything else", async () => {
    const { token } = await generateApiKey();
    expect(looksLikeApiKey(token)).toBe(true);
    expect(looksLikeApiKey("ww_")).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey("an-oauth-access-token")).toBe(false);
    expect(looksLikeApiKey("WW_upper")).toBe(false);
  });
});
