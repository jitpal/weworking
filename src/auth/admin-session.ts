/**
 * The admin browser session: `ADMIN_PASSWORD` in, a signed cookie out.
 *
 * `/admin/*` is the only place a human interacts with this worker, and the only
 * place a WeWork session token is ever pasted. It is therefore gated by the single
 * shared secret `ADMIN_PASSWORD`, and the proof of that sign-in is a stateless
 * HMAC-signed cookie (`ww_admin`, 12 hours, `HttpOnly; Secure; SameSite=Lax`) —
 * no server-side session store, so nothing to expire or clean up. The one piece of
 * state it does honour is the password itself: the cookie carries a short digest of
 * `ADMIN_PASSWORD` and is refused once that changes, so rotating the password ends
 * every session.
 *
 * This one sign-in serves both halves of the browser surface: the `/admin/*` pages
 * and the OAuth approval screen. Approving a client with the password also starts
 * the session, so the operator types the password once per browser.
 *
 * `SameSite=Lax` is doing real work: it means a cross-site `POST` never carries the
 * cookie. It is not the only defence, though, because a browser bug or a future
 * relaxation would be the whole story. Every form this worker serves therefore also
 * carries a CSRF token bound to a signed cookie, and the handler behind it verifies
 * the pair before doing anything: sign-in, OAuth approval, both API key forms, and
 * both session forms (`POST /admin/session`, `POST /admin/session/clear`). A
 * submission is accepted only from a browser that actually loaded that form.
 *
 * The cookie is the *only* way past {@link requireAdmin}. An agent credential, of
 * either kind, authenticates `/mcp` and `/api/*` and nothing else.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { Actor } from "../core/types";
import type { Env } from "../env";
import { banner, escapeHtml, htmlResponse, page } from "../http/admin-html";
import { baseUrlFrom, unauthorizedResponse } from "./guard";
import {
  clearFailures,
  clientIp,
  isRateLimited,
  rateLimitRetryAfter,
  recordFailure,
} from "./rate-limit";
import { signValue, verifyValue } from "./sign";
import { constantTimeEqual, sha256Hex } from "./tokens";

/** Name of the signed admin session cookie. */
export const ADMIN_COOKIE = "ww_admin";
/** Name of the short-lived CSRF cookie used by the two password forms. */
export const CSRF_COOKIE = "ww_csrf";
/** Admin session lifetime: 12 hours, matching a WeWork access token's. */
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
/** CSRF token lifetime. Long enough to read the page, short enough to be useless later. */
export const CSRF_TTL_SECONDS = 10 * 60;
/** Rate-limit bucket for `POST /admin/login`. */
export const ADMIN_LOGIN_BUCKET = "admin-login";

/** Hono bindings/variables every route group in this worker shares. */
export type AdminEnv = { Bindings: Env; Variables: { actor?: Actor } };

/* -------------------------------------------------------------------------- */
/* Cookies                                                                     */
/* -------------------------------------------------------------------------- */

/** Reads one cookie from a raw `Request` (the `Cookie` header), without Hono. */
export function cookieFromRequest(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/**
 * Hex characters of SHA-256(`ADMIN_PASSWORD`) carried in the cookie.
 *
 * Eight bytes is far more than enough to tell one password from another, and the
 * digest is of a secret the holder of the cookie already proved they knew, so the
 * prefix discloses nothing a brute-forcer could not test against the login form
 * itself.
 */
const PASSWORD_FINGERPRINT_HEX = 16;

/** Short digest of the configured password, or `null` when there is none. */
async function passwordFingerprint(env: Env): Promise<string | null> {
  const password = env.ADMIN_PASSWORD?.trim();
  if (!password) return null;
  return (await sha256Hex(password)).slice(0, PASSWORD_FINGERPRINT_HEX);
}

/**
 * Mints the signed `ww_admin` cookie as a ready-to-send `Set-Cookie` value.
 *
 * Shared by the login form and the OAuth approval screen, so both sign the operator
 * in the same way and one browser sign-in covers both.
 *
 * The claims carry a short digest of `ADMIN_PASSWORD` as well as `sub`, so the
 * cookie is bound to the password that minted it. Changing the password therefore
 * signs every browser out, which is what an operator who has just rotated it
 * expects; without it a copied cookie stayed valid for its full 12 hours and only
 * rotating `COOKIE_SIGNING_KEY` could end it.
 *
 * @returns the header value, or `null` when a required secret is not configured.
 */
export async function adminSessionCookie(env: Env): Promise<string | null> {
  const key = env.COOKIE_SIGNING_KEY?.trim();
  if (!key) return null;
  const fingerprint = await passwordFingerprint(env);
  if (!fingerprint) return null;
  const value = await signValue(key, { sub: "admin", pw: fingerprint }, ADMIN_SESSION_TTL_SECONDS);
  return [
    `${ADMIN_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
  ].join("; ");
}

/**
 * True when the request carries a valid, unexpired `ww_admin` cookie that was
 * minted under the password currently configured.
 */
export async function hasAdminCookie(request: Request, env: Env): Promise<boolean> {
  const key = env.COOKIE_SIGNING_KEY?.trim();
  if (!key) return false;
  const fingerprint = await passwordFingerprint(env);
  if (!fingerprint) return false;
  const claims = await verifyValue(key, cookieFromRequest(request, ADMIN_COOKIE));
  if (claims?.sub !== "admin" || typeof claims.pw !== "string") return false;
  return constantTimeEqual(claims.pw, fingerprint);
}

/* -------------------------------------------------------------------------- */
/* CSRF                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Mints a CSRF token for `purpose`: the `cookie` header value to send back (the
 * token, signed) and the bare `token` to embed in the form.
 *
 * The cookie holds the signed token and the form holds the bare token, so a
 * submission is only accepted from a browser that actually loaded the form
 * (double-submit, with the cookie half authenticated by HMAC).
 */
export async function issueCsrfToken(
  env: Env,
  purpose: string,
): Promise<{ token: string; cookie: string }> {
  const key = env.COOKIE_SIGNING_KEY?.trim();
  const token = crypto.randomUUID();
  if (!key) return { token, cookie: "" };
  const signed = await signValue(key, { purpose, token }, CSRF_TTL_SECONDS);
  const cookie = [
    `${CSRF_COOKIE}=${encodeURIComponent(signed)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${CSRF_TTL_SECONDS}`,
  ].join("; ");
  return { token, cookie };
}

/** Response headers that carry a freshly issued CSRF cookie (empty when unconfigured). */
export function csrfHeaders(
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return cookie ? { "Set-Cookie": cookie, ...extra } : { ...extra };
}

/** Verifies the `purpose`-bound CSRF pair (cookie + submitted form field). */
export async function verifyCsrfToken(
  request: Request,
  env: Env,
  purpose: string,
  submitted: string | undefined,
): Promise<boolean> {
  const key = env.COOKIE_SIGNING_KEY?.trim();
  if (!key || !submitted) return false;
  const claims = await verifyValue(key, cookieFromRequest(request, CSRF_COOKIE));
  if (!claims || claims.purpose !== purpose || typeof claims.token !== "string") return false;
  return constantTimeEqual(claims.token, submitted);
}

/* -------------------------------------------------------------------------- */
/* Shared password checking                                                    */
/* -------------------------------------------------------------------------- */

/** Why a password form could not be processed. `ok` means the password matched. */
export type PasswordOutcome =
  | { ok: true }
  | { ok: false; reason: "not-configured"; status: 503; message: string }
  | { ok: false; reason: "rate-limited"; status: 429; message: string; retryAfter: number }
  | { ok: false; reason: "bad-password"; status: 401; message: string };

/**
 * The shared check behind both password forms: rate limit, then configuration, then
 * a constant-time comparison. A failure records one strike for the caller's IP; a
 * success forgets them all.
 */
export async function checkAdminPassword(
  request: Request,
  env: Env,
  bucket: string,
  submitted: string | undefined,
): Promise<PasswordOutcome> {
  const ip = clientIp(request);
  if (isRateLimited(bucket, ip)) {
    const retryAfter = rateLimitRetryAfter(bucket, ip);
    return {
      ok: false,
      reason: "rate-limited",
      status: 429,
      retryAfter,
      message: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    };
  }

  const configured = env.ADMIN_PASSWORD?.trim();
  if (!configured) {
    return {
      ok: false,
      reason: "not-configured",
      status: 503,
      message: "ADMIN_PASSWORD secret not set",
    };
  }

  if (!submitted || !constantTimeEqual(configured, submitted)) {
    recordFailure(bucket, ip);
    return { ok: false, reason: "bad-password", status: 401, message: "Incorrect password." };
  }

  clearFailures(bucket, ip);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

/** Only same-origin absolute paths survive, so `?next=` cannot become an open redirect. */
export function safeNextPath(next: string | undefined, fallback = "/admin"): string {
  if (!next?.startsWith("/") || next.startsWith("//")) return fallback;
  if (next.includes("\\") || next.includes("\n") || next.includes("\r")) return fallback;
  return next;
}

/**
 * `GET/POST /admin/login` and `GET /admin/logout`.
 *
 * Mount at the root: the paths above are absolute, so `app.route("/", adminRoutes())`.
 */
export function adminRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get("/admin/login", async (c) => {
    const next = safeNextPath(c.req.query("next"));
    if (!c.env.ADMIN_PASSWORD?.trim()) {
      return htmlResponse(notConfiguredPage(), 503);
    }
    const { token, cookie } = await issueCsrfToken(c.env, ADMIN_LOGIN_BUCKET);
    return htmlResponse(loginPage({ next, csrf: token }), 200, csrfHeaders(cookie));
  });

  app.post("/admin/login", async (c) => {
    const form = await readFormish(c.req.raw);
    const next = safeNextPath(form.next);
    const csrfOk = await verifyCsrfToken(c.req.raw, c.env, ADMIN_LOGIN_BUCKET, form.csrf);
    if (!csrfOk) {
      const { token, cookie } = await issueCsrfToken(c.env, ADMIN_LOGIN_BUCKET);
      return htmlResponse(
        loginPage({
          next,
          csrf: token,
          error: "That form expired or was submitted from another site. Try again.",
        }),
        403,
        csrfHeaders(cookie),
      );
    }

    const outcome = await checkAdminPassword(c.req.raw, c.env, ADMIN_LOGIN_BUCKET, form.password);
    if (!outcome.ok) {
      if (outcome.reason === "not-configured") return htmlResponse(notConfiguredPage(), 503);
      const { token, cookie } = await issueCsrfToken(c.env, ADMIN_LOGIN_BUCKET);
      const extra: Record<string, string> =
        outcome.reason === "rate-limited" ? { "Retry-After": String(outcome.retryAfter) } : {};
      return htmlResponse(
        loginPage({ next, csrf: token, error: outcome.message }),
        outcome.status,
        csrfHeaders(cookie, extra),
      );
    }

    const cookie = await adminSessionCookie(c.env);
    if (!cookie) {
      return htmlResponse(
        page({
          title: "Not configured",
          body: banner("err", "COOKIE_SIGNING_KEY secret not set"),
        }),
        503,
      );
    }

    c.header("Set-Cookie", cookie, { append: true });
    deleteCookie(c, CSRF_COOKIE, { path: "/" });
    return c.redirect(next, 303);
  });

  app.get("/admin/logout", (c) => {
    deleteCookie(c, ADMIN_COOKIE, { path: "/" });
    return c.redirect("/admin/login", 303);
  });

  return app;
}

/**
 * Gate for every page in `src/http/admin.ts`.
 *
 * The `ww_admin` cookie is the only credential it accepts: `/admin/*` is an
 * operator surface driven from a browser, and an agent credential is deliberately
 * not a way in.
 *
 * Unauthenticated HTML navigation is redirected to the login form (with `?next=`);
 * anything else gets the JSON 401 with the OAuth challenge, so a script or an MCP
 * client is told how to authenticate rather than handed a login page.
 */
export const requireAdmin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  if (await hasAdminCookie(c.req.raw, c.env)) {
    await next();
    return;
  }

  if (prefersHtml(c.req.raw)) {
    const url = new URL(c.req.url);
    const target = c.req.method === "GET" ? `${url.pathname}${url.search}` : "/admin";
    return c.redirect(`/admin/login?next=${encodeURIComponent(safeNextPath(target))}`, 303);
  }
  return unauthorizedResponse(baseUrlFrom(c.req.raw, c.env));
};

/** True when the caller looks like a browser navigating, rather than a script or agent. */
export function prefersHtml(request: Request): boolean {
  const accept = request.headers.get("Accept") ?? "";
  if (!accept.includes("text/html")) return false;
  const contentType = request.headers.get("Content-Type") ?? "";
  return !contentType.includes("application/json");
}

/**
 * Reads a request body as either a form post or a JSON object, so every admin
 * endpoint accepts both a browser form and a scripted `Content-Type: application/json`.
 */
export async function readFormish(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("Content-Type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = await request.json();
      if (typeof body !== "object" || body === null) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        out[key] = typeof value === "string" ? value : JSON.stringify(value);
      }
      return out;
    }
    const form = await request.formData();
    const out: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

function loginPage(options: { next: string; csrf: string; error?: string }): string {
  return page({
    title: "Admin sign-in",
    subtitle: "Enter the ADMIN_PASSWORD for this deployment.",
    body: `
${options.error ? banner("err", options.error) : ""}
<form class="card" method="post" action="/admin/login">
<input type="hidden" name="next" value="${escapeHtml(options.next)}">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<label for="password">Admin password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>
<p class="small muted">The session cookie lasts 12 hours. It is the same sign-in the OAuth approval screen uses.</p>`,
  });
}

function notConfiguredPage(): string {
  return page({
    title: "Not configured",
    body: `${banner("err", "ADMIN_PASSWORD secret not set")}
<p>Set it and redeploy:</p>
<pre>npx wrangler secret put ADMIN_PASSWORD</pre>
<p class="small muted">See docs/SELF_HOSTING.md step 3.</p>`,
  });
}
