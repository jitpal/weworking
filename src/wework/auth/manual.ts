/**
 * Manual session import — the escape hatch when headless login is blocked.
 *
 * Auth0's bot protection reliably blocks datacenter IPs (`requires_verification`),
 * and MFA-enrolled accounts cannot complete a non-interactive login at all. For
 * those deployments the user logs in with their own browser and hands us the
 * resulting token, so this parser has to accept whatever a non-expert can
 * plausibly copy out of a browser:
 *
 * 1. the **whole** `localStorage` dump as a JSON object whose keys start
 *    `@@auth0spajs@@` (what the bookmarklet on `/admin/connect` produces);
 * 2. a single Auth0 SPA cache entry, `{ body: { access_token, ... }, expiresAt }`,
 *    where the value may itself still be a JSON *string*;
 * 3. a plain `{ access_token, refresh_token?, expires_in | expires_at }` object;
 * 4. a bare JWT, with or without a `Bearer ` prefix, with or without stray
 *    whitespace and newlines from a sloppy copy-paste.
 *
 * When several entries are present we pick the one that is actually useful: the
 * access token whose `aud` includes `"wework"` (an id_token or a
 * `/userinfo`-audience token is useless as an API bearer) and, among those, the one
 * with the latest `exp`.
 *
 * Every failure is an `AppError("VALIDATION")` whose hint tells the *user* what to
 * paste instead — this is the one parser whose errors a human reads. No error
 * message ever echoes the input.
 */

import type { SessionRecord } from "../../core/types";
import { AppError } from "../../errors";
import { base64UrlDecodeToString } from "./pkce";

/** The JWT claim carrying the WeWork member id required by the `WeWorkUUID` header. */
export const USER_UUID_CLAIM = "https://wework.com/user_uuid";

/** Prefix auth0-spa-js uses for its `localStorage` cache keys. */
export const AUTH0_SPA_CACHE_PREFIX = "@@auth0spajs@@";

/** The audience an access token must carry to be usable as a WeWork API bearer. */
const REQUIRED_AUDIENCE = "wework";

/** Timestamps below this are seconds, above are milliseconds (2001-09-09 in ms). */
const MS_THRESHOLD = 1e12;

/**
 * Decodes a JWT's payload without verifying the signature.
 *
 * Verification is deliberately absent: we are not the audience of this token and
 * hold none of Auth0's keys. We read it only for `exp` and the member id, and the
 * token's real validation happens when WeWork rejects or accepts it upstream.
 *
 * @throws {AppError} `VALIDATION` when the input is not three base64url segments
 * with a JSON object in the middle.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const trimmed = stripBearer(token);
  const segments = trimmed.split(".");
  if (segments.length !== 3) {
    throw validation(
      "That does not look like a JWT: expected three dot-separated segments.",
      "Paste the whole access token, including both dots.",
    );
  }
  const payload = segments[1];
  if (!payload) throw validation("The JWT payload segment is empty.");

  let json: string;
  try {
    json = base64UrlDecodeToString(payload);
  } catch {
    throw validation("The JWT payload is not valid base64url.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw validation("The JWT payload is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw validation("The JWT payload is not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parses anything a user might paste into a {@link SessionRecord}.
 *
 * `obtainedAt` is stamped by the token store, not here, which is why the return
 * type omits it.
 *
 * @param input a string (JSON, or a bare/`Bearer `-prefixed JWT) or an already-parsed object.
 * @param now injected clock, for deriving `expiresAt` from `expires_in`.
 * @throws {AppError} `VALIDATION` with a user-facing hint on anything unparseable.
 *
 * @example
 * parseManualSession('Bearer eyJhbGciOi...').source; // "manual"
 */
export function parseManualSession(
  input: string | object,
  now: () => number = Date.now,
): Omit<SessionRecord, "obtainedAt"> {
  const candidates = collectCandidates(input);
  if (candidates.length === 0) {
    throw validation(
      "No access token was found in the pasted value.",
      "Paste either the JSON from the bookmarklet on the connect page, a single @@auth0spajs@@ localStorage entry, or just the access token itself.",
    );
  }

  const best = chooseBestCandidate(candidates);
  const claims = tryDecode(best.accessToken);

  const userUuid = claims ? stringClaim(claims[USER_UUID_CLAIM]) : undefined;
  if (!userUuid) {
    throw validation(
      `The access token does not carry the "${USER_UUID_CLAIM}" claim, so WeWork API calls would be rejected.`,
      "Make sure you copied the access_token (not the id_token) from members.wework.com while logged in.",
    );
  }

  const expFromClaims = claims ? numberClaim(claims.exp) : undefined;
  const expiresAt =
    expFromClaims !== undefined
      ? expFromClaims * 1000
      : (best.expiresAtMs ??
        (best.expiresInSeconds !== undefined ? now() + best.expiresInSeconds * 1000 : undefined));

  if (expiresAt === undefined) {
    throw validation(
      "Could not work out when this token expires: it has no `exp` claim and the pasted value had no expires_in/expiresAt.",
      "Paste the full @@auth0spajs@@ cache entry, which includes the expiry.",
    );
  }
  if (expiresAt <= now()) {
    throw validation(
      "That token has already expired.",
      "Reload members.wework.com so Auth0 issues a fresh token, then copy it again.",
    );
  }

  const record: Omit<SessionRecord, "obtainedAt"> = {
    accessToken: best.accessToken,
    expiresAt,
    source: "manual",
    userUuid,
  };
  if (best.refreshToken) record.refreshToken = best.refreshToken;
  return record;
}

/* -------------------------------------------------------------------------- */
/* Candidate extraction                                                        */
/* -------------------------------------------------------------------------- */

/** One possible session found in the input, before we decide which to keep. */
interface Candidate {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
  expiresInSeconds?: number;
}

function collectCandidates(input: string | object): Candidate[] {
  const value = typeof input === "string" ? parseStringInput(input) : input;
  if (typeof value === "string") {
    // A bare token: no expiry metadata, so `exp` had better be in the claims.
    return [{ accessToken: value }];
  }
  if (typeof value !== "object" || value === null) return [];
  return candidatesFromObject(value as Record<string, unknown>, 0);
}

/**
 * Turns a pasted string into either a bare token or a parsed object.
 *
 * Tolerates: surrounding whitespace and newlines, a `Bearer ` prefix, wrapping
 * quotes, and a trailing comma or semicolon from a copied JS expression.
 */
function parseStringInput(raw: string): string | object {
  let trimmed = raw
    .trim()
    .replace(/[;,]+$/, "")
    .trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed) {
    throw validation(
      "Nothing was pasted.",
      "Copy the value from the connect page instructions and try again.",
    );
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as object;
    } catch {
      throw validation(
        "That looks like JSON but could not be parsed.",
        "Copy the whole value, including the outer braces, with nothing trimmed off either end.",
      );
    }
  }

  const token = stripBearer(trimmed).replace(/\s+/g, "");
  if (!token) throw validation("Nothing was pasted except a Bearer prefix.");
  return token;
}

/** Walks an object, collecting every `{access_token, ...}` shape it contains. */
function candidatesFromObject(record: Record<string, unknown>, depth: number): Candidate[] {
  if (depth > 4) return [];

  // Shape 1: a localStorage dump keyed by @@auth0spajs@@::...
  const spaKeys = Object.keys(record).filter((key) => key.startsWith(AUTH0_SPA_CACHE_PREFIX));
  if (spaKeys.length > 0) {
    const found: Candidate[] = [];
    for (const key of spaKeys) {
      const entry = coerceJson(record[key]);
      if (entry && typeof entry === "object") {
        found.push(...candidatesFromObject(entry as Record<string, unknown>, depth + 1));
      }
    }
    if (found.length > 0) return found;
  }

  // Shape 2: an Auth0 SPA cache entry, { body: {...}, expiresAt }.
  const body = coerceJson(record.body);
  if (body && typeof body === "object") {
    const inner = candidatesFromObject(body as Record<string, unknown>, depth + 1);
    const outerExpiry = toMs(numberClaim(record.expiresAt) ?? numberClaim(record.expires_at));
    if (inner.length > 0) {
      return inner.map((candidate) =>
        candidate.expiresAtMs === undefined && outerExpiry !== undefined
          ? { ...candidate, expiresAtMs: outerExpiry }
          : candidate,
      );
    }
  }

  // Shape 3: a plain token object.
  const accessToken =
    stringClaim(record.access_token) ??
    stringClaim(record.accessToken) ??
    stringClaim(record.token);
  if (accessToken) {
    const candidate: Candidate = { accessToken: stripBearer(accessToken) };
    const refreshToken = stringClaim(record.refresh_token) ?? stringClaim(record.refreshToken);
    if (refreshToken) candidate.refreshToken = refreshToken;
    const expiresAtMs = toMs(
      numberClaim(record.expires_at) ??
        numberClaim(record.expiresAt) ??
        numberClaim(record.expiresAtMs),
    );
    if (expiresAtMs !== undefined) candidate.expiresAtMs = expiresAtMs;
    const expiresIn = numberClaim(record.expires_in) ?? numberClaim(record.expiresIn);
    if (expiresIn !== undefined) candidate.expiresInSeconds = expiresIn;
    return [candidate];
  }

  // Shape 4: something wrapping one of the above, e.g. { session: {...} }.
  const nested: Candidate[] = [];
  for (const value of Object.values(record)) {
    const coerced = coerceJson(value);
    if (coerced && typeof coerced === "object" && !Array.isArray(coerced)) {
      nested.push(...candidatesFromObject(coerced as Record<string, unknown>, depth + 1));
    }
  }
  return nested;
}

/**
 * Picks the usable token: `aud` containing `"wework"` wins, and among equals the
 * latest `exp`. A token we cannot decode ranks last but is still a candidate, so a
 * future opaque access token would not break the connect page outright.
 */
function chooseBestCandidate(candidates: Candidate[]): Candidate {
  let best: Candidate | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestExp = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const claims = tryDecode(candidate.accessToken);
    const hasUuid = claims !== undefined && stringClaim(claims[USER_UUID_CLAIM]) !== undefined;
    const hasAudience = claims !== undefined && audienceIncludesWework(claims.aud);
    const score = (hasAudience ? 2 : 0) + (hasUuid ? 1 : 0);
    const exp = claims ? (numberClaim(claims.exp) ?? 0) : 0;

    if (score > bestScore || (score === bestScore && exp > bestExp)) {
      best = candidate;
      bestScore = score;
      bestExp = exp;
    }
  }

  // `candidates` is non-empty at every call site, so this is only for the type.
  return best ?? (candidates[0] as Candidate);
}

function audienceIncludesWework(aud: unknown): boolean {
  if (typeof aud === "string") return aud.split(/\s+/).includes(REQUIRED_AUDIENCE);
  if (Array.isArray(aud)) return aud.some((entry) => entry === REQUIRED_AUDIENCE);
  return false;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function tryDecode(token: string): Record<string, unknown> | undefined {
  try {
    return decodeJwtPayload(token);
  } catch {
    return undefined;
  }
}

/** auth0-spa-js stores its cache values as JSON strings; unwrap one level. */
function coerceJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function stripBearer(value: string): string {
  return value
    .trim()
    .replace(/^bearer\s+/i, "")
    .trim();
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberClaim(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number.parseFloat(value.trim());
  }
  return undefined;
}

/** Normalises a timestamp that may be in seconds or milliseconds to milliseconds. */
function toMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value < MS_THRESHOLD ? value * 1000 : value;
}

function validation(message: string, hint?: string): AppError {
  return new AppError("VALIDATION", message, hint !== undefined ? { hint } : {});
}
