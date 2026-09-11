/**
 * PKCE and random-value primitives for the Auth0 authorization-code flow.
 *
 * Everything here uses WebCrypto only — no Node builtins, no dependencies — because
 * this code runs inside a Cloudflare Worker. `crypto.getRandomValues` and
 * `crypto.subtle.digest` are both available there (and in the vitest workers pool).
 *
 * The encoding is base64url *without* padding, as RFC 7636 §4.2 requires: Auth0
 * rejects a challenge containing `+`, `/` or `=`.
 */

/** Bytes of entropy behind a `code_verifier`. 32 bytes -> 43 base64url characters. */
const VERIFIER_BYTES = 32;

/** Bytes of entropy behind `state` and `nonce`. Matches auth0-spa-js. */
const OPAQUE_BYTES = 16;

/** The only challenge method we use; Auth0 supports `plain` but we never offer it. */
export const CODE_CHALLENGE_METHOD = "S256" as const;

/** A `code_verifier` with its derived S256 `code_challenge`. */
export interface PkcePair {
  /** The secret. Sent only to `/oauth/token`, never to `/authorize`. */
  codeVerifier: string;
  /** `base64url(sha256(codeVerifier))`. Sent to `/authorize`. */
  codeChallenge: string;
  codeChallengeMethod: typeof CODE_CHALLENGE_METHOD;
}

/**
 * Encodes bytes as unpadded base64url.
 *
 * @example
 * base64UrlEncode(new Uint8Array([251, 255])); // "-_8"
 */
export function base64UrlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes unpadded (or padded) base64url back to bytes.
 *
 * @throws {Error} when the input is not valid base64.
 */
export function base64UrlDecode(value: string): Uint8Array {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes unpadded base64url to a UTF-8 string. Used for JWT payloads. */
export function base64UrlDecodeToString(value: string): string {
  return new TextDecoder().decode(base64UrlDecode(value));
}

/** `byteLength` cryptographically random bytes, base64url-encoded. */
export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** A fresh RFC 7636 `code_verifier` (43 characters, unreserved alphabet). */
export function createCodeVerifier(): string {
  return randomBase64Url(VERIFIER_BYTES);
}

/** `base64url(SHA-256(verifier))` — the `code_challenge` for method `S256`. */
export async function createCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(digest);
}

/** A fresh verifier/challenge pair. */
export async function createPkcePair(): Promise<PkcePair> {
  const codeVerifier = createCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: await createCodeChallenge(codeVerifier),
    codeChallengeMethod: CODE_CHALLENGE_METHOD,
  };
}

/** An opaque CSRF `state` value. */
export function randomState(): string {
  return randomBase64Url(OPAQUE_BYTES);
}

/** An opaque replay-guard `nonce` for the id_token. */
export function randomNonce(): string {
  return randomBase64Url(OPAQUE_BYTES);
}
