/**
 * Static scoped bearer tokens — the `AUTH_TOKENS` secret.
 *
 * A deployment can be reached two ways: the OAuth flow (for hosted clients that
 * cannot be given a header) and a long-lived static token (for local clients and
 * scripts). This module owns the second one.
 *
 * Only the SHA-256 of each token is ever stored, so a leaked `AUTH_TOKENS` secret
 * (or a `wrangler secret list` dump) does not hand anyone a usable credential. The
 * comparison is constant-time, and a malformed secret degrades to "no static
 * tokens" rather than taking the whole worker down — `/mcp` must keep answering
 * 401-with-a-challenge so OAuth clients can still discover the authorization
 * server.
 */

import { z } from "zod";
import type { Actor, Scope } from "../core/types";
import type { Env, StaticTokenConfig } from "../env";
import { redact } from "../redact";

/** The three scopes this deployment understands. `admin` implies the other two. */
export const SCOPES: readonly Scope[] = ["read", "write", "admin"] as const;

/** One `AUTH_TOKENS` entry. Mirrors {@link StaticTokenConfig}. */
export const staticTokenSchema = z.object({
  /** Label for the audit log, e.g. `"claude-code"`. Never a secret. */
  name: z.string().trim().min(1),
  /** Lower-case hex SHA-256 of the bearer token, 64 characters. */
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  /** Non-empty subset of `read` | `write` | `admin`. */
  scopes: z.array(z.enum(["read", "write", "admin"])).min(1),
});

/** The whole `AUTH_TOKENS` secret: a JSON array of {@link staticTokenSchema}. */
export const authTokensSchema = z.array(staticTokenSchema);

/** The id used for every Actor in phase 1 (single WeWork account per deployment). */
export const DEFAULT_ACCOUNT_ID = "default";

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** Single-entry memo, so a request does not re-parse (and re-validate) the secret. */
let memoRaw: string | undefined;
let memoTokens: StaticTokenConfig[] = [];
/** The last raw value we complained about, so a broken secret logs once, not once per request. */
let warnedRaw: string | undefined;

/**
 * Parses the `AUTH_TOKENS` secret into validated entries.
 *
 * Unlike `parseConfig()` in `src/env.ts` — which *throws* `VALIDATION` so a
 * misconfigured deployment is loud at startup — this parser is deliberately
 * forgiving: a malformed secret logs once (redacted) and yields `[]`. The guard
 * then answers 401 with the OAuth challenge, which is the useful failure mode for
 * an MCP client. `/healthz` reports `secrets.authTokens: 0`, which the
 * self-hosting guide already documents as "malformed JSON".
 *
 * @param raw the secret value, or `undefined` when unset.
 */
export function parseStaticTokens(raw: string | undefined): StaticTokenConfig[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  if (trimmed === memoRaw) return memoTokens;

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    warnOnce(trimmed, "AUTH_TOKENS is not valid JSON; no static tokens are active.", undefined);
    return [];
  }

  const result = authTokensSchema.safeParse(json);
  if (!result.success) {
    warnOnce(
      trimmed,
      "AUTH_TOKENS failed validation; no static tokens are active.",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
    return [];
  }

  const tokens: StaticTokenConfig[] = result.data.map((entry) => ({
    name: entry.name,
    sha256: entry.sha256.toLowerCase(),
    scopes: [...entry.scopes],
  }));
  memoRaw = trimmed;
  memoTokens = tokens;
  return tokens;
}

function warnOnce(raw: string, message: string, details: unknown): void {
  if (warnedRaw === raw) return;
  warnedRaw = raw;
  // `details` carries zod paths and messages only — never the secret's content.
  console.warn(
    "auth: %s",
    message,
    redact({ entries: countableLength(raw), issues: details ?? null }),
  );
}

/** Length only — enough to tell "empty" from "something is in there", with no content. */
function countableLength(raw: string): number {
  return raw.length;
}

/** Test seam: forgets the memo and the "already warned" marker. */
export function resetStaticTokenCache(): void {
  memoRaw = undefined;
  memoTokens = [];
  warnedRaw = undefined;
}

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

/**
 * Compares two strings without an early exit, so the time taken does not reveal a
 * matching prefix.
 *
 * Length inequality *is* observable (as it is in every practical implementation,
 * including `crypto.timingSafeEqual`); the values compared here are fixed-length
 * hex digests, so that leaks nothing.
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
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolves a presented bearer token against `AUTH_TOKENS`.
 *
 * Every configured entry is compared (no early return) so the number of
 * comparisons does not depend on which token was presented.
 *
 * @returns an `Actor` of kind `"bearer"`, or `null` when nothing matches.
 */
export async function matchStaticToken(env: Env, presentedToken: string): Promise<Actor | null> {
  const presented = presentedToken.trim();
  if (!presented) return null;
  const tokens = parseStaticTokens(env.AUTH_TOKENS);
  if (tokens.length === 0) return null;

  const digest = await sha256Hex(presented);
  let matched: StaticTokenConfig | undefined;
  for (const token of tokens) {
    if (constantTimeEqual(digest, token.sha256)) matched = token;
  }
  if (!matched) return null;

  return {
    kind: "bearer",
    name: matched.name,
    scopes: [...matched.scopes],
    accountId: DEFAULT_ACCOUNT_ID,
  };
}
