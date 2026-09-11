/**
 * Booking quotes — the capability token that makes `create_booking` safe.
 *
 * `create_booking` accepts **only** a quote. Everything the upstream booking call
 * needs (the resolved `SpaceID`, the account type, the UTC window, the price) is
 * captured at search time, signed with `QUOTE_SIGNING_KEY`, and handed to the agent
 * as one opaque string. An agent therefore cannot book a space the user never saw in
 * a search result, cannot move the window, and cannot change the price: any edit
 * breaks the MAC, and the token dies after ten minutes (`QUOTE_TTL_SECONDS` in
 * booking-service; it is a constant, not a configurable var).
 *
 * Wire format:
 *
 * ```text
 * quote = base64url(utf8(json(QuotePayload))) "." base64url(HMAC-SHA-256(key, payloadB64))
 * ```
 *
 * The MAC covers the **base64url text** of the payload, not the decoded bytes, so
 * verification never has to re-serialise JSON (key order would not survive).
 *
 * Nothing secret is inside a quote — it is a signed, *readable* description of one
 * bookable slot. Treat it as a bearer capability all the same: it is single-purpose
 * and short-lived, but anyone holding one can spend the user's credits on that slot.
 */

import { AppError } from "../errors";
import type { QuotePayload } from "./types";

/** The only payload version this build issues or accepts. */
const QUOTE_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** HMAC keys are imported per call; Workers caches the underlying key material cheaply. */
const HMAC_PARAMS = { name: "HMAC", hash: "SHA-256" } as const;

/**
 * Signs a quote payload.
 *
 * @param payload the slot description; `exp` must already be set by the caller
 *   (the booking service sets it to `now + QUOTE_TTL_SECONDS`)
 * @param key `QUOTE_SIGNING_KEY` — hex is decoded to bytes, anything else is used as
 *   UTF-8, so tests can pass a readable string
 * @returns the two-part quote token
 */
export async function signQuote(payload: QuotePayload, key: string): Promise<string> {
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(key, payloadB64);
  return `${payloadB64}.${base64UrlEncode(signature)}`;
}

/** Verification context: the clock and the tenant the quote must belong to. */
export interface VerifyQuoteOptions {
  /** Unix epoch **milliseconds** — compared against the payload's `exp` (seconds). */
  now: number;
  /** The calling {@link ../core/types!Actor}'s `accountId`; must match the payload. */
  accountId: string;
}

/**
 * Verifies a quote and returns its payload.
 *
 * Checks, in order — signature first, because nothing in an unverified payload may
 * be trusted, not even to produce an error message:
 *
 *  1. shape (two base64url parts) → `QUOTE_INVALID`
 *  2. HMAC, compared in constant time → `QUOTE_INVALID`
 *  3. payload parses, and `v === 1` → `QUOTE_INVALID`
 *  4. `accountId` matches the caller → `QUOTE_INVALID`
 *  5. `exp` is in the future → `QUOTE_EXPIRED`
 *
 * @throws {AppError} `QUOTE_INVALID` or `QUOTE_EXPIRED`, each with an agent-facing hint
 */
export async function verifyQuote(
  quote: string,
  key: string,
  opts: VerifyQuoteOptions,
): Promise<QuotePayload> {
  if (typeof quote !== "string" || quote.length === 0) {
    throw invalid("No quote was supplied.");
  }
  const parts = quote.split(".");
  if (parts.length !== 2) {
    throw invalid("A quote must be the two dot-separated parts returned by search_availability.");
  }
  const [payloadB64, signatureB64] = parts as [string, string];
  if (!payloadB64 || !signatureB64) {
    throw invalid("The quote is malformed: one of its two parts is empty.");
  }

  let provided: Uint8Array;
  try {
    provided = base64UrlDecode(signatureB64);
  } catch {
    throw invalid("The quote's signature is not valid base64url.");
  }

  const expected = await hmac(key, payloadB64);
  if (!timingSafeEqual(provided, expected)) {
    throw invalid("The quote's signature does not verify.");
  }

  let payload: QuotePayload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(payloadB64))) as QuotePayload;
  } catch {
    throw invalid("The quote's payload is not valid JSON.");
  }
  if (typeof payload !== "object" || payload === null) {
    throw invalid("The quote's payload is not an object.");
  }
  if (payload.v !== QUOTE_VERSION) {
    throw invalid(
      `This quote uses payload version ${String(payload.v)}; this deployment issues version ${QUOTE_VERSION}.`,
    );
  }
  if (payload.accountId !== opts.accountId) {
    throw invalid("This quote was issued for a different account.");
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw invalid("The quote has no usable expiry.");
  }
  if (payload.exp * 1000 <= opts.now) {
    const agoSec = Math.round((opts.now - payload.exp * 1000) / 1000);
    throw new AppError("QUOTE_EXPIRED", `This quote expired ${agoSec} second(s) ago.`, {
      hint: "Call search_availability again and book from a fresh result.",
    });
  }
  return payload;
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

function invalid(message: string): AppError {
  return new AppError("QUOTE_INVALID", message, {
    hint: "Quotes cannot be constructed or edited. Call search_availability and pass a quote from its result verbatim.",
  });
}

async function hmac(key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes(key), HMAC_PARAMS, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return new Uint8Array(signature);
}

/**
 * `QUOTE_SIGNING_KEY` is validated as hex by `parseConfig`, and hex is decoded so the
 * key has its full 32 bytes of entropy. Any other string (a test key such as
 * `"secret"`) is used as UTF-8 bytes rather than rejected.
 */
function keyBytes(key: string): Uint8Array {
  if (key.length >= 2 && key.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(key)) {
    const out = new Uint8Array(key.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = Number.parseInt(key.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return encoder.encode(key);
}

/**
 * Constant-time byte comparison.
 *
 * A `===` on base64 strings leaks the length of the matching prefix through timing,
 * which is enough to forge a MAC one byte at a time given enough attempts. The early
 * length return is safe: the length of an HMAC-SHA-256 tag is not a secret.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Base64url (RFC 4648 §5) without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes base64url, rejecting anything outside the alphabet.
 *
 * @throws {Error} on invalid input — callers turn this into `QUOTE_INVALID`
 */
export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Lower-case hex SHA-256 of a UTF-8 string. Used to derive default idempotency keys. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
