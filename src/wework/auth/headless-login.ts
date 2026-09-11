/**
 * Strategy A: non-interactive Auth0 login, end to end, from inside a Worker.
 *
 * This reproduces what auth0-spa-js + Auth0's universal login do in a browser,
 * without a browser:
 *
 * 1. discover the tenant (`config.ts`);
 * 2. `POST /co/authenticate` with the password-realm credential type to turn the
 *    username/password into a single-use `login_ticket`;
 * 3. seed the two transaction cookies (`a0.spajs.txs.<clientId>` and its `_legacy_`
 *    twin) that the SPA would have written from JavaScript, holding the PKCE
 *    verifier, nonce, scope, audience, redirect_uri and state;
 * 4. `GET /authorize` with the ticket and the S256 challenge, then follow every
 *    redirect **manually** (Workers' `fetch` has no cookie jar, so automatic
 *    redirects drop `Set-Cookie` and the chain dies), submitting any HTML form the
 *    chain interposes — in practice `/u/mfa-detect-browser-capabilities`;
 * 5. stop at the `redirect_uri` carrying `?code=`, then
 *    `POST /oauth/token` with the code and the verifier.
 *
 * It is the *fallback* strategy, not the primary one. Auth0's bot protection scores
 * datacenter IPs harshly and answers `requires_verification`, for which there is no
 * programmatic remedy — and an MFA-enrolled account cannot complete this flow at
 * all. Both are reported as `UPSTREAM_BLOCKED` with a hint pointing the user at
 * `/admin/connect`, because the right response is a human pasting a token, not a
 * retry. The happy path costs roughly 10-14 subrequests, within the Workers limit
 * but close enough to it that nothing else should share the request.
 *
 * Passwords, cookies, tickets and tokens never reach a log: everything logged here
 * goes through `redact()` / `redactUrl()`, and the password is not in any structure
 * that gets logged.
 */

import type { LoginStrategy, SessionRecord } from "../../core/types";
import { AppError } from "../../errors";
import { redact, redactUrl } from "../../redact";
import { DESKTOP_USER_AGENT, MEMBERS_ORIGIN } from "../headers";
import {
  AUTH0_CLIENT_HEADER,
  AUTH0_REALM,
  type Auth0Config,
  authOrigin,
  authUrl,
  fetchAuth0Config,
  isAllowedAuthHost,
  PASSWORD_REALM_GRANT,
} from "./config";
import { CookieJar } from "./cookie-jar";
import { createPkcePair, randomNonce, randomState } from "./pkce";
import { postTokenEndpoint, sessionFromTokenResponse } from "./token-exchange";

/** Options for {@link createHeadlessLoginStrategy} and {@link headlessLogin}. */
export interface HeadlessLoginOptions {
  username: string;
  password: string;
  /** Injected `fetch`. Tests pass a route table; nothing here touches the network directly. */
  fetch: typeof fetch;
  /** Injected clock (epoch ms). */
  now?: () => number;
  /** Overrides the Safari user agent. */
  userAgent?: string;
  /** Skips discovery and uses these tenant parameters. */
  config?: Auth0Config;
  /** Overrides {@link MAX_REDIRECT_HOPS}. */
  maxRedirects?: number;
  /** Injected delay, so the 429 retry path is testable without real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/** Hard cap on the `/authorize` redirect chain. A real login uses 8-12 hops. */
export const MAX_REDIRECT_HOPS = 15;

/** Attempts (including the first) before a 429 becomes `UPSTREAM_RATE_LIMITED`. */
export const MAX_RATE_LIMIT_ATTEMPTS = 3;

/** Upper bound on any `Retry-After` we honour; Auth0 sometimes suggests minutes. */
export const RETRY_AFTER_CAP_MS = 10_000;

/** Used when a 429 carries no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 1_000;

/** The Auth0 page that probes for WebAuthn support before deciding on MFA. */
const CAPABILITIES_PATH_MARKER = "mfa-detect-browser-capabilities";

/**
 * What the capabilities page's JavaScript would have filled in. Declaring no
 * WebAuthn support is what makes Auth0 fall through to the password-only outcome
 * for accounts that are not MFA-enrolled.
 */
const CAPABILITY_FIELDS: Record<string, string> = {
  "js-available": "true",
  "webauthn-available": "false",
  "webauthn-platform-available": "false",
  "is-brave": "false",
  action: "default",
};

/** Markers for bot-protection / CAPTCHA interstitials in an HTML hop. */
const CAPTCHA_MARKERS: RegExp[] = [
  /requires_verification/i,
  /g-recaptcha/i,
  /recaptcha\/api/i,
  /hcaptcha\.com/i,
  /arkoselabs/i,
  /funcaptcha/i,
  /data-sitekey/i,
  /name=["']?captcha["']?/i,
  /\/u\/verify-captcha/i,
  /cf-chl|cf_chl_opt|Attention Required! \| Cloudflare/i,
];

/** Hint shared by every blocked outcome; it is the only remedy that works. */
const BLOCKED_HINT =
  "Automated sign-in cannot get past this. Ask the user to log in at members.wework.com in their own browser and paste the token at <base>/admin/connect.";

/**
 * Builds the `headless` {@link LoginStrategy}.
 *
 * The Durable Object calls `login()` at most once at a time (it coalesces
 * concurrent callers), so this holds no state between calls — every invocation
 * mints a fresh PKCE pair, state, nonce and cookie jar.
 */
export function createHeadlessLoginStrategy(opts: HeadlessLoginOptions): LoginStrategy {
  return {
    name: "headless",
    login: () => headlessLogin(opts),
  };
}

/** Runs the whole flow once. See the module comment for the five steps. */
export async function headlessLogin(opts: HeadlessLoginOptions): Promise<SessionRecord> {
  const now = opts.now ?? Date.now;
  const userAgent = opts.userAgent ?? DESKTOP_USER_AGENT;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (!opts.username || !opts.password) {
    throw new AppError(
      "UPSTREAM_AUTH",
      "Headless login needs both WEWORK_USERNAME and WEWORK_PASSWORD.",
      { hint: "Set both secrets, or use LOGIN_STRATEGY=manual and connect a token by hand." },
    );
  }

  // (a) discovery — never throws; falls back to pinned constants.
  const config = opts.config ?? (await fetchAuth0Config(opts.fetch));

  const ctx: FlowContext = {
    config,
    fetch: opts.fetch,
    userAgent,
    sleep,
    jar: new CookieJar({ now }),
    maxRedirects: opts.maxRedirects ?? MAX_REDIRECT_HOPS,
  };

  // (b) username/password -> login_ticket.
  const loginTicket = await coAuthenticate(ctx, opts.username, opts.password);

  // (c) the PKCE transaction, and the cookies that carry it.
  const pkce = await createPkcePair();
  const state = randomState();
  const nonce = randomNonce();
  seedTransactionCookies(ctx, {
    nonce,
    code_verifier: pkce.codeVerifier,
    scope: config.scope,
    audience: config.audience,
    redirect_uri: config.redirectUri,
    state,
  });

  // (d) /authorize, then the redirect chain, down to the authorization code.
  const authorizeUrl = buildAuthorizeUrl(config, {
    loginTicket,
    state,
    nonce,
    codeChallenge: pkce.codeChallenge,
  });
  const code = await followAuthorizeChain(ctx, authorizeUrl, state);

  // (e) code + verifier -> tokens.
  const raw = await postTokenEndpoint({
    fetch: ctx.fetch,
    config,
    grantLabel: "authorization_code",
    userAgent,
    body: {
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      code_verifier: pkce.codeVerifier,
      redirect_uri: config.redirectUri,
    },
  });

  const session = sessionFromTokenResponse({ raw, now, source: "login" });
  return { ...session, obtainedAt: now() };
}

/* -------------------------------------------------------------------------- */
/* Step (b): cross-origin authentication                                       */
/* -------------------------------------------------------------------------- */

/** Everything the steps share. Deliberately does not hold the password. */
interface FlowContext {
  config: Auth0Config;
  fetch: typeof fetch;
  userAgent: string;
  sleep: (ms: number) => Promise<void>;
  jar: CookieJar;
  maxRedirects: number;
}

/**
 * Exchanges credentials for a single-use `login_ticket`.
 *
 * @throws {AppError} `UPSTREAM_AUTH` on 401/403 (wrong password, or the account is
 * not in the `id-wework` realm), `UPSTREAM_BLOCKED` on `requires_verification` or a
 * CAPTCHA demand, `UPSTREAM_RATE_LIMITED` after {@link MAX_RATE_LIMIT_ATTEMPTS}
 * 429s, `UPSTREAM_ERROR` otherwise.
 */
async function coAuthenticate(
  ctx: FlowContext,
  username: string,
  password: string,
): Promise<string> {
  const url = authUrl(ctx.config, "/co/authenticate");

  for (let attempt = 1; attempt <= MAX_RATE_LIMIT_ATTEMPTS; attempt += 1) {
    const response = await ctx.fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        "Auth0-Client": AUTH0_CLIENT_HEADER,
        Origin: MEMBERS_ORIGIN,
        Referer: `${MEMBERS_ORIGIN}/`,
        "User-Agent": ctx.userAgent,
      },
      body: JSON.stringify({
        client_id: ctx.config.clientId,
        username,
        password,
        realm: AUTH0_REALM,
        credential_type: PASSWORD_REALM_GRANT,
      }),
    });

    // Auth0 sets the cross-origin verifier cookie here; the chain needs it.
    ctx.jar.addFromResponse(url, response);

    if (response.status === 429) {
      const waitMs = parseRetryAfterMs(response.headers.get("retry-after"));
      if (attempt < MAX_RATE_LIMIT_ATTEMPTS) {
        console.warn(
          "[wework] co/authenticate rate-limited, retrying",
          redact({ attempt, waitMs }),
        );
        await ctx.sleep(waitMs);
        continue;
      }
      throw new AppError(
        "UPSTREAM_RATE_LIMITED",
        `Auth0 rate-limited the sign-in after ${MAX_RATE_LIMIT_ATTEMPTS} attempts.`,
      );
    }

    const text = await response.text();

    if (looksBlocked(text)) {
      throw new AppError(
        "UPSTREAM_BLOCKED",
        "Auth0 bot protection demands human verification for this sign-in.",
        { hint: BLOCKED_HINT },
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        "UPSTREAM_AUTH",
        `Auth0 rejected the WeWork credentials (HTTP ${response.status}).`,
        {
          hint: "Check WEWORK_USERNAME and WEWORK_PASSWORD. If they are right, the account may require MFA — use <base>/admin/connect instead.",
        },
      );
    }

    const parsed = parseJson(text);
    const ticket =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).login_ticket
        : undefined;

    if (!response.ok || typeof ticket !== "string" || !ticket) {
      const description = describeAuth0Error(parsed);
      console.warn(
        "[wework] co/authenticate did not return a login ticket",
        redact({ status: response.status, description }),
      );
      throw new AppError(
        "UPSTREAM_ERROR",
        `Auth0 /co/authenticate returned no login_ticket (HTTP ${response.status}${
          description ? `: ${description}` : ""
        }).`,
      );
    }
    return ticket;
  }

  // Unreachable: the loop either returns or throws.
  throw new AppError("UPSTREAM_ERROR", "Auth0 /co/authenticate exhausted its attempts.");
}

/* -------------------------------------------------------------------------- */
/* Step (c): the transaction cookies                                           */
/* -------------------------------------------------------------------------- */

/** The auth0-spa-js transaction, stored in a cookie rather than `sessionStorage`. */
export interface Auth0Transaction {
  nonce: string;
  code_verifier: string;
  scope: string;
  audience: string;
  redirect_uri: string;
  state: string;
}

/** Cookie name auth0-spa-js 2.x uses for its transaction. */
export function transactionCookieName(clientId: string): string {
  return `a0.spajs.txs.${clientId}`;
}

/** The `_legacy_` twin auth0-spa-js writes for browsers that reject `SameSite=None`. */
export function legacyTransactionCookieName(clientId: string): string {
  return `_legacy_a0.spajs.txs.${clientId}`;
}

/**
 * Writes the transaction cookies on the tenant domain.
 *
 * The value is `encodeURIComponent(JSON.stringify(transaction))` — js-cookie, which
 * auth0-spa-js uses, URL-encodes on write, and Auth0's `/authorize` handler
 * URL-decodes on read.
 */
function seedTransactionCookies(ctx: FlowContext, transaction: Auth0Transaction): void {
  const value = encodeURIComponent(JSON.stringify(transaction));
  for (const name of [
    transactionCookieName(ctx.config.clientId),
    legacyTransactionCookieName(ctx.config.clientId),
  ]) {
    ctx.jar.seed({ name, value, domain: ctx.config.domain, path: "/", secure: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Step (d): /authorize and the redirect chain                                 */
/* -------------------------------------------------------------------------- */

/** Builds the `/authorize` URL, matching what auth0-spa-js would emit. */
export function buildAuthorizeUrl(
  config: Auth0Config,
  args: { loginTicket: string; state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(authUrl(config, "/authorize"));
  const params: Record<string, string> = {
    client_id: config.clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: config.redirectUri,
    scope: config.scope,
    audience: config.audience,
    state: args.state,
    nonce: args.nonce,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
    login_ticket: args.loginTicket,
    auth0Client: AUTH0_CLIENT_HEADER,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** One pending request in the chain. */
interface PendingRequest {
  url: string;
  method: "GET" | "POST";
  body?: string;
  referer?: string;
}

/**
 * Walks the redirect chain until the callback URL carries `?code=`.
 *
 * @throws {AppError} `UPSTREAM_BLOCKED` for MFA and CAPTCHA pages,
 * `UPSTREAM_AUTH` when the callback reports `error=access_denied`,
 * `UPSTREAM_RATE_LIMITED` after repeated 429s, `UPSTREAM_ERROR` for a missing
 * `Location`, an unparseable hop, a hop that leaves the WeWork/Auth0 hosts, or more
 * than `maxRedirects` hops.
 */
async function followAuthorizeChain(
  ctx: FlowContext,
  authorizeUrl: string,
  expectedState: string,
): Promise<string> {
  let pending: PendingRequest = { url: authorizeUrl, method: "GET" };
  let rateLimitAttempts = 0;

  for (let hop = 0; hop < ctx.maxRedirects; hop += 1) {
    const early = extractCode(pending.url, ctx.config.redirectUri, expectedState);
    if (early) return early;

    const response = await requestHop(ctx, pending);
    ctx.jar.addFromResponse(pending.url, response);

    if (response.status === 429) {
      rateLimitAttempts += 1;
      const waitMs = parseRetryAfterMs(response.headers.get("retry-after"));
      if (rateLimitAttempts >= MAX_RATE_LIMIT_ATTEMPTS) {
        throw new AppError(
          "UPSTREAM_RATE_LIMITED",
          `Auth0 rate-limited /authorize after ${MAX_RATE_LIMIT_ATTEMPTS} attempts.`,
        );
      }
      console.warn("[wework] /authorize rate-limited, retrying", redact({ hop, waitMs }));
      await ctx.sleep(waitMs);
      continue; // Same request, same hop budget cost — the cap is on total hops.
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new AppError(
          "UPSTREAM_ERROR",
          `Auth0 returned HTTP ${response.status} with no Location header.`,
        );
      }
      const next = new URL(location, pending.url).toString();
      const code = extractCode(next, ctx.config.redirectUri, expectedState);
      if (code) return code;
      pending = { url: next, method: "GET", referer: pending.url };
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      const body = await safeText(response);
      if (looksBlocked(body)) {
        throw new AppError(
          "UPSTREAM_BLOCKED",
          `Auth0 blocked the sign-in chain with HTTP ${response.status}.`,
          { hint: BLOCKED_HINT },
        );
      }
      throw new AppError(
        "UPSTREAM_AUTH",
        `Auth0 rejected the sign-in chain with HTTP ${response.status}.`,
      );
    }

    if (!response.ok) {
      throw new AppError(
        "UPSTREAM_ERROR",
        `Auth0 returned HTTP ${response.status} during the sign-in chain.`,
      );
    }

    // 200: an interposed HTML page. Classify it, then submit its form.
    const html = await safeText(response);
    const path = new URL(pending.url).pathname;

    if (looksBlocked(html)) {
      throw new AppError("UPSTREAM_BLOCKED", "Auth0 served a CAPTCHA or bot-protection page.", {
        hint: BLOCKED_HINT,
      });
    }

    const form = parseFirstForm(html);
    const isCapabilities = path.includes(CAPABILITIES_PATH_MARKER);

    if (!isCapabilities && isMfaChallenge(path, form)) {
      throw new AppError(
        "UPSTREAM_BLOCKED",
        "This WeWork account is enrolled in multi-factor authentication, which a non-interactive sign-in cannot complete.",
        { hint: "MFA enrolled accounts must use /admin/connect" },
      );
    }

    if (!form) {
      console.warn(
        "[wework] sign-in chain stalled on a page with no form",
        redact({ url: redactUrl(pending.url), status: response.status, bytes: html.length }),
      );
      throw new AppError(
        "UPSTREAM_ERROR",
        "Auth0 served a page the sign-in chain does not know how to continue from.",
        { hint: BLOCKED_HINT },
      );
    }

    const fields = isCapabilities ? { ...form.fields, ...CAPABILITY_FIELDS } : { ...form.fields };
    const actionUrl = new URL(form.action || pending.url, pending.url);
    const method = form.method.toUpperCase() === "GET" ? "GET" : "POST";

    if (method === "GET") {
      for (const [key, value] of Object.entries(fields)) {
        actionUrl.searchParams.set(key, value);
      }
      pending = { url: actionUrl.toString(), method: "GET", referer: pending.url };
    } else {
      pending = {
        url: actionUrl.toString(),
        method: "POST",
        body: new URLSearchParams(fields).toString(),
        referer: pending.url,
      };
    }
  }

  throw new AppError(
    "UPSTREAM_ERROR",
    `The Auth0 sign-in chain did not reach the callback within ${ctx.maxRedirects} hops.`,
    { hint: BLOCKED_HINT },
  );
}

/**
 * Refuses to issue a hop to anything outside the WeWork/Auth0 allow-list.
 *
 * The chain is driven by `Location` headers and HTML form actions from upstream, and
 * each hop carries the previous URL as `Referer` — hop one's referer contains the
 * single-use `login_ticket`. A redirect to another origin would hand that to whoever
 * controls it, so the chain stops instead.
 */
function assertAllowedHop(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new AppError(
      "UPSTREAM_ERROR",
      "The Auth0 sign-in chain produced a URL that cannot be parsed.",
      { hint: BLOCKED_HINT },
    );
  }
  if (!isAllowedAuthHost(hostname)) {
    throw new AppError(
      "UPSTREAM_ERROR",
      `The Auth0 sign-in chain tried to continue at ${hostname}, which is neither a wework.com nor an auth0.com host. It was stopped rather than followed.`,
      { hint: BLOCKED_HINT },
    );
  }
}

/** Issues one hop, carrying the jar's cookies and a browser-shaped header block. */
async function requestHop(ctx: FlowContext, pending: PendingRequest): Promise<Response> {
  assertAllowedHop(pending.url);
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": ctx.userAgent,
  };
  const cookie = ctx.jar.headerFor(pending.url);
  if (cookie) headers.Cookie = cookie;
  if (pending.referer) headers.Referer = pending.referer;
  if (pending.method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers.Origin = authOrigin(ctx.config);
  }

  const init: RequestInit = { method: pending.method, redirect: "manual", headers };
  if (pending.body !== undefined) init.body = pending.body;
  return await ctx.fetch(pending.url, init);
}

/**
 * Returns the authorization code when `candidate` is the callback URL.
 *
 * Matching is on origin + pathname only, because the configured `redirect_uri`
 * already carries a `?domain=` query parameter that the callback keeps alongside
 * `code` and `state`.
 *
 * @throws {AppError} when the callback reports an OAuth error, or when `state` does
 * not match the value we sent (a sign the chain crossed into another transaction).
 */
export function extractCode(
  candidate: string,
  redirectUri: string,
  expectedState?: string,
): string | undefined {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(candidate);
    expected = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) return undefined;

  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description") ?? error;
    if (/requires_verification|captcha|verification/i.test(`${error} ${description}`)) {
      throw new AppError("UPSTREAM_BLOCKED", `Auth0 refused the sign-in: ${description}`, {
        hint: BLOCKED_HINT,
      });
    }
    if (/mfa|multifactor/i.test(`${error} ${description}`)) {
      throw new AppError("UPSTREAM_BLOCKED", `Auth0 requires a second factor: ${description}`, {
        hint: "MFA enrolled accounts must use /admin/connect",
      });
    }
    throw new AppError("UPSTREAM_AUTH", `Auth0 refused the sign-in: ${description}`);
  }

  const code = url.searchParams.get("code");
  if (!code) return undefined;

  if (expectedState !== undefined) {
    const returned = url.searchParams.get("state");
    if (returned !== null && returned !== expectedState) {
      throw new AppError(
        "UPSTREAM_ERROR",
        "The Auth0 callback returned a state value we did not send.",
      );
    }
  }
  return code;
}

/* -------------------------------------------------------------------------- */
/* HTML form parsing                                                           */
/* -------------------------------------------------------------------------- */

/** A form lifted out of an HTML hop. */
export interface ParsedForm {
  /** `action` attribute verbatim; may be relative or empty. */
  action: string;
  /** `method` attribute, or `"POST"` — every Auth0 universal-login form posts. */
  method: string;
  /** Every named `input`/`button`, mapped to its `value` attribute (default `""`). */
  fields: Record<string, string>;
  /** The field names, in document order, for challenge detection. */
  names: string[];
}

/**
 * Extracts the first `<form>` from an HTML document.
 *
 * Regex rather than a parser because there is no DOM in a Worker and the pages
 * involved are machine-generated Auth0 templates, not arbitrary web content. Kept
 * generic (all named inputs, not a hard-coded list) so a new interstitial field
 * Auth0 adds is carried through automatically.
 */
export function parseFirstForm(html: string): ParsedForm | undefined {
  const formMatch = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (!formMatch) return undefined;
  const attrs = formMatch[1] ?? "";
  const inner = formMatch[2] ?? "";

  const fields: Record<string, string> = {};
  const names: string[] = [];
  for (const tag of inner.match(/<(?:input|button|textarea)\b[^>]*>/gi) ?? []) {
    const name = attribute(tag, "name");
    if (!name) continue;
    const type = (attribute(tag, "type") ?? "").toLowerCase();
    // Skip unrelated submit alternatives, but keep the primary named button:
    // Auth0's capabilities form carries `action=default` on a <button>.
    if (type === "image" || type === "reset") continue;
    if (!(name in fields)) names.push(name);
    fields[name] = decodeHtmlEntities(attribute(tag, "value") ?? "");
  }

  return {
    action: decodeHtmlEntities(attribute(attrs, "action") ?? ""),
    method: attribute(attrs, "method") ?? "POST",
    fields,
    names,
  };
}

/** Reads one HTML attribute, handling double, single and unquoted values. */
function attribute(source: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = pattern.exec(source);
  if (!match) return undefined;
  return match[2] ?? match[3] ?? match[4];
}

/** The five entities Auth0 templates actually emit inside attribute values. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&amp;/g, "&");
}

/* -------------------------------------------------------------------------- */
/* Classification helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * True when the hop is an MFA/OTP challenge.
 *
 * Both signals are needed: Auth0 uses `/u/mfa-*` paths for the enrolment and
 * challenge screens, but an SMS/TOTP prompt can also appear under `/u/login` with a
 * `code` input. The caller must exclude `mfa-detect-browser-capabilities` first,
 * since that path also matches `/u/mfa-` and is a normal part of the happy path.
 */
export function isMfaChallenge(path: string, form: ParsedForm | undefined): boolean {
  if (/\/u\/mfa-|\/u\/challenge|\/mfa-otp|\/u\/webauthn/i.test(path)) return true;
  if (!form) return false;
  return form.names.some((name) => {
    const normalised = name.toLowerCase();
    return normalised === "code" || normalised === "otp" || normalised === "mfa-code";
  });
}

/** True when the body looks like bot protection rather than a login step. */
export function looksBlocked(body: string): boolean {
  return CAPTCHA_MARKERS.some((marker) => marker.test(body));
}

/** `Retry-After` in milliseconds, clamped to {@link RETRY_AFTER_CAP_MS}. */
export function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const trimmed = header.trim();

  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(seconds) && /^\d+$/.test(trimmed)) {
    return clampRetry(seconds * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    // Relative to Date.now() deliberately: this is a wall-clock HTTP date, not
    // something the injected clock should reinterpret.
    return clampRetry(asDate - Date.now());
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function clampRetry(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Pulls a human-readable reason out of an Auth0 error body, if there is one. */
function describeAuth0Error(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  for (const key of ["error_description", "description", "error", "code", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
