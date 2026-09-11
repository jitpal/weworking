/**
 * Quote signing and verification.
 *
 * The quote is the only thing standing between an agent and the user's credits, so the
 * cases that matter are the adversarial ones: a tampered payload, a tampered signature,
 * a quote from another deployment, a quote from another account, and an expired one.
 */

import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  sha256Hex,
  signQuote,
  timingSafeEqual,
  verifyQuote,
} from "../../src/core/quote";
import type { QuotePayload } from "../../src/core/types";
import { isAppError } from "../../src/errors";
import { NOW_MS, TEST_QUOTE_KEY } from "./fakes";

const OTHER_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

function payload(overrides: Partial<QuotePayload> = {}): QuotePayload {
  return {
    v: 1,
    accountId: "default",
    locationId: "loc-poultry",
    spaceId: "space-1",
    wwSpaceId: "space-1",
    bookingSpaceId: "kube-1",
    accountType: 2,
    date: "2026-09-21",
    startUtc: "2026-09-21T08:00:00Z",
    endUtc: "2026-09-21T16:00:00Z",
    credits: 1,
    timezone: "Europe/London",
    tzOffset: "+01:00",
    locationName: "1 Poultry",
    address: "1 Poultry, London EC2R 8EJ",
    city: "London",
    country: "GBR",
    exp: Math.floor(NOW_MS / 1000) + 600,
    ...overrides,
  };
}

const verifyOpts = { now: NOW_MS, accountId: "default" };

/** Asserts that `promise` rejects with an `AppError` carrying `code` and a hint. */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((err: unknown) => {
    if (!isAppError(err)) throw new Error(`expected AppError, got ${String(err)}`);
    expect(err.code).toBe(code);
    expect(err.hint).toBeTypeOf("string");
    return true;
  });
}

describe("signQuote / verifyQuote", () => {
  it("round-trips a payload unchanged", async () => {
    const original = payload();
    const quote = await signQuote(original, TEST_QUOTE_KEY);
    expect(quote.split(".")).toHaveLength(2);
    await expect(verifyQuote(quote, TEST_QUOTE_KEY, verifyOpts)).resolves.toEqual(original);
  });

  it("produces url-safe tokens with no padding", async () => {
    const quote = await signQuote(payload({ locationName: "Süd/Straße +1" }), TEST_QUOTE_KEY);
    expect(quote).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("is deterministic for the same payload and key", async () => {
    const fixed = payload();
    await expect(signQuote(fixed, TEST_QUOTE_KEY)).resolves.toBe(
      await signQuote(fixed, TEST_QUOTE_KEY),
    );
  });

  it("rejects a tampered payload — the classic 'make it free' edit", async () => {
    const quote = await signQuote(payload({ credits: 5 }), TEST_QUOTE_KEY);
    const [, signature] = quote.split(".") as [string, string];
    const forged = `${base64UrlEncode(
      new TextEncoder().encode(JSON.stringify(payload({ credits: 0 }))),
    )}.${signature}`;
    await expectCode(verifyQuote(forged, TEST_QUOTE_KEY, verifyOpts), "QUOTE_INVALID");
  });

  it("rejects a tampered signature", async () => {
    const quote = await signQuote(payload(), TEST_QUOTE_KEY);
    const [body, signature] = quote.split(".") as [string, string];
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    await expectCode(
      verifyQuote(`${body}.${flipped}`, TEST_QUOTE_KEY, verifyOpts),
      "QUOTE_INVALID",
    );
  });

  it("rejects a quote signed by another deployment's key", async () => {
    const quote = await signQuote(payload(), OTHER_KEY);
    await expectCode(verifyQuote(quote, TEST_QUOTE_KEY, verifyOpts), "QUOTE_INVALID");
  });

  it("rejects a quote issued for another account", async () => {
    const quote = await signQuote(payload({ accountId: "tenant-b" }), TEST_QUOTE_KEY);
    await expectCode(verifyQuote(quote, TEST_QUOTE_KEY, verifyOpts), "QUOTE_INVALID");
  });

  it("rejects an unknown payload version", async () => {
    const quote = await signQuote(
      { ...payload(), v: 2 } as unknown as QuotePayload,
      TEST_QUOTE_KEY,
    );
    await expectCode(verifyQuote(quote, TEST_QUOTE_KEY, verifyOpts), "QUOTE_INVALID");
  });

  it("reports an expired quote as QUOTE_EXPIRED, not QUOTE_INVALID", async () => {
    const quote = await signQuote(payload({ exp: Math.floor(NOW_MS / 1000) - 30 }), TEST_QUOTE_KEY);
    await expectCode(verifyQuote(quote, TEST_QUOTE_KEY, verifyOpts), "QUOTE_EXPIRED");
  });

  it("treats exp exactly now as expired", async () => {
    const quote = await signQuote(payload({ exp: Math.floor(NOW_MS / 1000) }), TEST_QUOTE_KEY);
    await expectCode(verifyQuote(quote, TEST_QUOTE_KEY, verifyOpts), "QUOTE_EXPIRED");
  });

  it("accepts a quote that is still valid for one more second", async () => {
    const quote = await signQuote(payload({ exp: Math.floor(NOW_MS / 1000) + 1 }), TEST_QUOTE_KEY);
    await expect(verifyQuote(quote, TEST_QUOTE_KEY, verifyOpts)).resolves.toMatchObject({ v: 1 });
  });

  it.each([
    ["empty string", ""],
    ["no separator", "notaquote"],
    ["three parts", "a.b.c"],
    ["empty signature", "abc."],
    ["non-base64url characters", "abc!.def!"],
    ["base64url but not JSON", `${base64UrlEncode(new TextEncoder().encode("nope"))}.AAAA`],
  ])("rejects garbage input (%s)", async (_label, garbage) => {
    await expectCode(verifyQuote(garbage, TEST_QUOTE_KEY, verifyOpts), "QUOTE_INVALID");
  });

  it("never leaks the signing key in an error", async () => {
    const quote = await signQuote(payload(), OTHER_KEY);
    await expect(verifyQuote(quote, TEST_QUOTE_KEY, verifyOpts)).rejects.toSatisfy(
      (err: unknown) => {
        const text = JSON.stringify(err instanceof Error ? err.message : err);
        expect(text).not.toContain(TEST_QUOTE_KEY);
        expect(text).not.toContain(OTHER_KEY);
        return true;
      },
    );
  });
});

describe("primitives", () => {
  it("base64url round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 62, 63, 250, 251, 252, 253, 254, 255]);
    expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes]);
  });

  it("timingSafeEqual compares content, not identity", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("sha256Hex produces the known digest of the empty string", async () => {
    await expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("treats a hex key as bytes, so a differently-cased key verifies the same", async () => {
    const quote = await signQuote(payload(), TEST_QUOTE_KEY.toUpperCase());
    await expect(verifyQuote(quote, TEST_QUOTE_KEY, verifyOpts)).resolves.toMatchObject({ v: 1 });
  });

  it("accepts a non-hex key as UTF-8, for readable test keys", async () => {
    const quote = await signQuote(payload(), "not-hex-secret");
    await expect(verifyQuote(quote, "not-hex-secret", verifyOpts)).resolves.toMatchObject({ v: 1 });
    await expectCode(verifyQuote(quote, "other-secret", verifyOpts), "QUOTE_INVALID");
  });
});
