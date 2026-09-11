/**
 * Public surface of the WeWork authentication layer.
 *
 * The session Durable Object imports only from here (`../wework/auth`), so the
 * internals — the cookie jar, the PKCE helpers, the token-endpoint wrapper — stay
 * free to change without touching another engineer's module.
 *
 * Three ways to get a session, in decreasing order of reliability:
 *
 * 1. {@link refreshSession} — one POST, works from a datacenter IP. The normal path.
 * 2. {@link parseManualSession} — a human pastes a token from their own browser.
 *    The fallback that always works, and the only option for MFA accounts.
 * 3. {@link createHeadlessLoginStrategy} — full non-interactive Auth0 login. Often
 *    blocked by bot protection; keep it, but do not depend on it.
 */

export {
  AUTH0_CLIENT_HEADER,
  AUTH0_CONFIG_URL,
  AUTH0_REALM,
  type Auth0Config,
  authOrigin,
  authUrl,
  FALLBACK_AUTH0_CONFIG,
  fetchAuth0Config,
  PASSWORD_REALM_GRANT,
} from "./config";
export { CookieJar, type CookieJarOptions, type StoredCookie } from "./cookie-jar";
export {
  buildAuthorizeUrl,
  createHeadlessLoginStrategy,
  type HeadlessLoginOptions,
  headlessLogin,
  MAX_RATE_LIMIT_ATTEMPTS,
  MAX_REDIRECT_HOPS,
  type ParsedForm,
  parseFirstForm,
  parseRetryAfterMs,
  RETRY_AFTER_CAP_MS,
} from "./headless-login";
export {
  AUTH0_SPA_CACHE_PREFIX,
  decodeJwtPayload,
  parseManualSession,
  USER_UUID_CLAIM,
} from "./manual";
export {
  base64UrlDecode,
  base64UrlEncode,
  CODE_CHALLENGE_METHOD,
  createCodeChallenge,
  createCodeVerifier,
  createPkcePair,
  type PkcePair,
  randomNonce,
  randomState,
} from "./pkce";
export { type RefreshOptions, refreshSession } from "./refresh";
