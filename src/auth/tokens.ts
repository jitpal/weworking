/**
 * API keys: minting them, and the hashing every credential check goes through.
 *
 * An agent authenticates to this deployment in one of two ways: an OAuth access
 * token, or an **API key** the operator minted at `/admin/keys` and presented as
 * `Authorization: Bearer ww_...`. This module owns the second one's format and its
 * hash; the keys themselves live (hashed) in the `WeWorkSession` Durable Object, and
 * `src/auth/guard.ts` is what looks them up.
 *
 * Only the SHA-256 of a key is ever stored. The plaintext exists twice: once on the
 * page that mints it, and once in the client config the operator pastes it into. A
 * dump of the Durable Object therefore hands nobody a usable credential.
 */

import type { Scope } from "../core/types";

/** The three scopes this deployment understands. */
export const SCOPES: readonly Scope[] = ["read", "write", "admin"] as const;

/** The id used for every Actor in phase 1 (single WeWork account per deployment). */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Prefix on every minted key.
 *
 * It is load-bearing, not decoration: the guard uses it to tell a possible API key
 * from anything else without paying for a Durable Object round trip.
 */
export const API_KEY_PREFIX = "ww_";

/** Bytes of entropy behind a minted key. */
const API_KEY_BYTES = 32;

/* -------------------------------------------------------------------------- */
/* Crypto                                                                      */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder();

/** Lower-case hex SHA-256 of a UTF-8 string, via WebCrypto. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** Lower-case hex of a byte array. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Base64url of a byte array, unpadded. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Compares two strings without an early exit, so the time taken does not reveal a
 * matching prefix.
 *
 * Length inequality *is* observable (as it is in every practical implementation,
 * including `crypto.timingSafeEqual`); the values compared here are fixed-length
 * CSRF tokens and passwords, so that leaks nothing useful.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length === 0 || right.length === 0) return left.length === right.length;
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) {
    // Index `right` modulo its length so the loop always runs to completion.
    diff |= (left[i] ?? 0) ^ (right[i % right.length] ?? 0);
  }
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* Minting                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mints a new API key.
 *
 * @returns the plaintext `token` to show the operator exactly once, and the
 * `sha256` to store. Nothing else is derived from the token, so losing the
 * plaintext means minting a new key — there is no recovery, by design.
 *
 * Matching a presented key is an exact hash lookup in SQLite rather than a
 * constant-time walk over every entry. That is sound here: the lookup key is the
 * digest of 32 random bytes, so there is no low-entropy secret for a timing signal
 * to narrow down.
 */
export async function generateApiKey(): Promise<{ token: string; sha256: string }> {
  const bytes = new Uint8Array(API_KEY_BYTES);
  crypto.getRandomValues(bytes);
  const token = `${API_KEY_PREFIX}${bytesToBase64Url(bytes)}`;
  return { token, sha256: await sha256Hex(token) };
}

/** True when `value` is shaped like a minted key, before any lookup is attempted. */
export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX.length;
}
