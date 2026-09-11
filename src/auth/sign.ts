/**
 * HMAC-SHA-256 signed, expiring, stateless values.
 *
 * Two things in this worker need one: the admin session cookie (`ww_admin`, 12h)
 * and the CSRF token that binds an OAuth approval form to the browser that asked
 * for it (`ww_csrf`, 10 min). Both are small JSON payloads we hand to the browser
 * and must trust on the way back, and neither justifies a Durable Object round
 * trip — so they are signed with `COOKIE_SIGNING_KEY` instead of stored.
 *
 * Wire format: `base64url(json(payload)) + "." + hex(hmacSha256(key, base64url))`.
 * Verification is constant-time on the MAC and rejects anything whose `exp`
 * (epoch seconds) has passed.
 */

import { constantTimeEqual } from "./tokens";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What every signed payload carries in addition to its own fields. */
export interface SignedClaims {
  /** Expiry, epoch **seconds**. */
  exp: number;
  /** Issued at, epoch **seconds**. */
  iat: number;
  [claim: string]: unknown;
}

/** Imports a signing key. Hex (the documented format for our secrets) is decoded; anything else is used as UTF-8 bytes. */
async function importKey(key: string): Promise<CryptoKey> {
  const raw =
    /^[0-9a-fA-F]+$/.test(key) && key.length % 2 === 0 ? hexToBytes(key) : encoder.encode(key);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function base64UrlEncode(input: string): string {
  const bytes = encoder.encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return decoder.decode(bytes);
}

/** Lower-case hex HMAC-SHA-256 of `message` under `key`. */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await importKey(key);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Signs `claims` so they can survive a round trip through the browser.
 *
 * @param key hex signing key (`COOKIE_SIGNING_KEY`).
 * @param claims application claims; `iat`/`exp` are added from `ttlSeconds`.
 */
export async function signValue(
  key: string,
  claims: Record<string, unknown>,
  ttlSeconds: number,
  now: () => number = Date.now,
): Promise<string> {
  const issuedAt = Math.floor(now() / 1000);
  const payload: SignedClaims = { ...claims, iat: issuedAt, exp: issuedAt + ttlSeconds };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const mac = await hmacSha256Hex(key, encoded);
  return `${encoded}.${mac}`;
}

/**
 * Verifies a value produced by {@link signValue}.
 *
 * @returns the claims, or `null` when the format, the MAC or `exp` does not hold.
 * Never throws, so a mangled cookie is simply "not signed in".
 */
export async function verifyValue(
  key: string,
  value: string | undefined,
  now: () => number = Date.now,
): Promise<SignedClaims | null> {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const encoded = value.slice(0, separator);
  const mac = value.slice(separator + 1);
  if (!/^[0-9a-f]{64}$/.test(mac)) return null;

  let expected: string;
  try {
    expected = await hmacSha256Hex(key, encoded);
  } catch {
    return null;
  }
  if (!constantTimeEqual(expected, mac)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(base64UrlDecode(encoded));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const candidate = claims as SignedClaims;
  if (typeof candidate.exp !== "number" || candidate.exp * 1000 <= now()) return null;
  return candidate;
}
