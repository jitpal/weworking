/**
 * The admin browser session: `ADMIN_PASSWORD` in, a signed cookie out.
 *
 * `/admin/*` is the only place a human interacts with this worker, and the only
 * place a WeWork session token is ever pasted. It is therefore gated by the single
 * shared secret `ADMIN_PASSWORD`, and the proof of that sign-in is a stateless
 * HMAC-signed cookie (`ww_admin`, 12 hours, `HttpOnly; Secure; SameSite=Lax`) —
 * no server-side session store, so nothing to expire or clean up.
 *
 * `SameSite=Lax` is doing real work: it means a cross-site `POST` never carries the
 * cookie, which is what protects `POST /admin/session` and `POST /admin/session/clear`
 * from CSRF without a token. The two *password* forms (this one and the OAuth
 * approval screen) do carry an explicit CSRF token, because they are reachable
 * before any cookie exists.
 *
 * An `admin`-scoped credential (static bearer or OAuth) is accepted in place of the
 * cookie, so `POST /admin/session` can be driven by a script — the "residential
 * relay" pattern in docs/SELF_HOSTING.md.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Actor } from "../core/types";
import type { Env } from "../env";
import { banner, escapeHtml, htmlResponse, page } from "../http/admin-html";
import {
  ACTOR_CONTEXT_KEY,
  baseUrlFrom,
  hasScope,
  resolveActor,
  unauthorizedResponse,
} from "./guard";
import {
  clearFailures,
  clientIp,
  isRateLimited,
  rateLimitRetryAfter,
  recordFailure,
} from "./rate-limit";
import { signValue, verifyValue } from "./sign";
import { constantTimeEqual } from "./tokens";

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

/** True when the request carries a valid, unexpired `ww_admin` cookie. */
export async function hasAdminCookie(request: Request, env: Env): Promise<boolean> {
  const key = env.COOKIE_SIGNING_KEY?.trim();
  if (!key) return false;
  const claims = await verifyValue(key, cookieFromRequest(request, ADMIN_COOKIE));
  return claims?.sub === "admin";
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

    const key = c.env.COOKIE_SIGNING_KEY?.trim();
    if (!key) {
      return htmlResponse(
        page({
          title: "Not configured",
          body: banner("err", "COOKIE_SIGNING_KEY secret not set"),
        }),
        503,
      );
    }

    const value = await signValue(key, { sub: "admin" }, ADMIN_SESSION_TTL_SECONDS);
    setCookie(c, ADMIN_COOKIE, value, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: ADMIN_SESSION_TTL_SECONDS,
    });
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
 * Accepts either the `ww_admin` cookie or an `admin`-scoped `Actor` — from
 * `c.get("actor")` when `src/index.ts` middleware already resolved one, otherwise
 * resolved here from the raw `Authorization` header.
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

  const existing = c.get(ACTOR_CONTEXT_KEY);
  const actor = existing ?? (await resolveActor(c.req.raw, c.env));
  if (actor && hasScope(actor, "admin")) {
    if (!existing) c.set(ACTOR_CONTEXT_KEY, actor);
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
<p class="small muted">The session cookie lasts 12 hours. Scripts can use an <code>admin</code>-scoped bearer token instead of signing in.</p>`,
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
