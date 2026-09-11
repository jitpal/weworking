/**
 * OAuth 2.1 front door, via `@cloudflare/workers-oauth-provider`.
 *
 * The provider *wraps* the Hono app (see `src/index.ts`): it owns
 * `/oauth/token`, `/oauth/register`, `/.well-known/oauth-authorization-server` and
 * `/.well-known/oauth-protected-resource`, validates access tokens on the protected
 * prefixes (`/mcp`, `/api/`), and forwards everything else — including the
 * authorization page below — to our app.
 *
 * Three deliberate decisions live here:
 *
 * 1. **`resolveExternalToken` is wired.** It is the library's seam for a non-OAuth
 *    credential on a protected route, and using it means an API key reaches `/mcp`
 *    and `/api/*` through exactly the same path as an OAuth token, with `ctx.props`
 *    already populated — no second code path inside the API handler, and the
 *    provider's own 401 carries the `WWW-Authenticate: ... resource_metadata=...`
 *    challenge MCP clients need. `src/auth/guard.ts#resolveActor` still works on a
 *    raw header, so middleware outside the provider (or a test) resolves the same
 *    `Actor`.
 * 2. **Dynamic client registration is bounded, not closed.** MCP clients register
 *    themselves, so the endpoint has to stay open; what it must not be is an
 *    unauthenticated write to permanent storage. Registrations expire after
 *    {@link CLIENT_REGISTRATION_TTL_SECONDS} and are rate limited per client IP.
 * 3. **The approval screen is the operator's own sign-in, not an identity provider.**
 *    There is one user — the operator — so `userId` is always `"admin"`. A browser
 *    already carrying the `ww_admin` cookie only has to press Approve; one without it
 *    is asked for `ADMIN_PASSWORD`, rate-limited, and is signed in on success, so the
 *    password is typed once per browser whichever page asked for it first. Both forms
 *    carry a CSRF token bound to a signed cookie, and the parsed `AuthRequest` travels
 *    through the form *signed*, so it cannot be swapped for one pointing at someone
 *    else's redirect URI.
 */

import OAuthProvider, {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Scope } from "../core/types";
import type { Env } from "../env";
import {
  banner,
  CONTENT_SECURITY_POLICY,
  escapeHtml,
  htmlResponse,
  page,
} from "../http/admin-html";
import { redact } from "../redact";
import {
  adminSessionCookie,
  checkAdminPassword,
  csrfHeaders,
  hasAdminCookie,
  issueCsrfToken,
  verifyCsrfToken,
} from "./admin-session";
import { matchApiKey } from "./guard";
import { clientIp, isRateLimited, recordFailure } from "./rate-limit";
import { base64UrlDecode, base64UrlEncode, signValue, verifyValue } from "./sign";
import { DEFAULT_ACCOUNT_ID, SCOPES } from "./tokens";

/** Prefixes the provider protects with an access token. */
export const API_ROUTES = ["/mcp", "/api/"] as const;
/** Where the approval form lives (served by our app through `defaultHandler`). */
export const AUTHORIZE_ENDPOINT = "/oauth/authorize";
/** Token endpoint, served by the provider itself. */
export const TOKEN_ENDPOINT = "/oauth/token";
/** Dynamic client registration (RFC 7591), served by the provider itself. */
export const REGISTRATION_ENDPOINT = "/oauth/register";
/** Scopes this deployment will issue. */
export const SCOPES_SUPPORTED: Scope[] = [...SCOPES];
/**
 * Scopes the approval form pre-ticks.
 *
 * `read` only, deliberately. `write` spends the operator's money, so granting it is
 * a decision the operator makes by ticking a box, not one they make by not
 * un-ticking one. A client that asked for `write` still has it offered.
 */
export const DEFAULT_SCOPES: Scope[] = ["read"];
/** Rate-limit bucket for the approval form. */
export const OAUTH_APPROVE_BUCKET = "oauth-authorize";
/** Rate-limit bucket for dynamic client registration. */
export const OAUTH_REGISTER_BUCKET = "oauth-register";
/**
 * How long a dynamically registered client lives in `OAUTH_KV`.
 *
 * The library's default is 90 days and `undefined` means "never expires", which is
 * the wrong default for an endpoint anyone on the internet may call: without a TTL
 * every registration is a permanent KV entry. Thirty days is far longer than the
 * few minutes a real client needs between registering and completing its first
 * authorization, and a client that is still in use re-registers.
 */
export const CLIENT_REGISTRATION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Purpose string binding a CSRF token to this form. */
const CSRF_PURPOSE = "oauth-authorize";
/** How long a rendered approval form stays valid. */
const AUTH_REQUEST_TTL_SECONDS = 10 * 60;

/** The env as it looks once the provider has injected its helpers. */
type EnvWithHelpers = Env & { OAUTH_PROVIDER?: OAuthHelpers };

/** A `fetch`-shaped API handler, the plain-function form of `apiHandler`. */
export type ApiFetchHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response> | Response;

/** Options for {@link createOAuthProvider}. */
export interface CreateOAuthProviderOptions {
  /** Handles `/mcp` and `/api/*` *after* the provider validated a token; reads `ctx.props`. */
  apiHandler: ExportedHandler<Env> | ApiFetchHandler;
  /** Handles everything else — the Hono app (landing page, `/admin/*`, the approval form). */
  defaultHandler: ExportedHandler<Env>;
  /**
   * Client ID Metadata Documents (MCP 2026-07-28). On by default; it also wants
   * `global_fetch_strictly_public` in `compatibility_flags`, so a deployment that
   * cannot add that flag should pass `false`.
   */
  clientIdMetadataDocumentEnabled?: boolean;
  /** Human-readable name published in the RFC 9728 protected-resource metadata. */
  resourceName?: string;
}

/**
 * Builds the configured provider. `src/index.ts` exports its `fetch` as the worker's.
 *
 * `resourceMetadata.resource` is deliberately **not** pinned: it would have to be an
 * absolute URL known at module scope, while the canonical origin is a per-deployment
 * var (`PUBLIC_BASE_URL`) and workers.dev hostnames differ per account. Leaving it
 * unset makes the provider derive the resource from the request, which is what a
 * self-hoster with an unknown hostname needs.
 */
export function createOAuthProvider(options: CreateOAuthProviderOptions): OAuthProvider {
  return new OAuthProvider<Env>({
    apiRoute: [...API_ROUTES],
    apiHandler: normaliseApiHandler(options.apiHandler),
    defaultHandler: options.defaultHandler as ProviderDefaultHandler,
    authorizeEndpoint: AUTHORIZE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientRegistrationEndpoint: REGISTRATION_ENDPOINT,
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
    /**
     * Dynamic client registration is unauthenticated by MCP's design, so the only
     * thing bounding it is arrival rate. Same in-memory bucket as the password
     * forms: per-isolate and modest, but enough that one source cannot sit there
     * filling the namespace. Returning an object rejects the registration.
     */
    clientRegistrationCallback: ({ request }) => {
      const ip = clientIp(request);
      if (isRateLimited(OAUTH_REGISTER_BUCKET, ip)) {
        return {
          code: "access_denied",
          description: "Too many client registrations from this address. Try again later.",
          status: 429,
        };
      }
      recordFailure(OAUTH_REGISTER_BUCKET, ip);
      return undefined;
    },
    scopesSupported: SCOPES_SUPPORTED,
    clientIdMetadataDocumentEnabled: options.clientIdMetadataDocumentEnabled ?? true,
    resourceMetadata: {
      scopes_supported: SCOPES_SUPPORTED,
      resource_name: options.resourceName ?? "weworking (unofficial WeWork hot desks)",
      bearer_methods_supported: ["header"],
    },
    /**
     * Accepts an API key on a protected route, so `/mcp` and `/api/*` see one
     * uniform `ctx.props`. `null` falls through to the provider's own
     * `invalid_token` 401, which already carries the challenge header.
     */
    resolveExternalToken: async ({ token, env }) => {
      const actor = await matchApiKey(env, token);
      if (!actor) return null;
      return {
        props: {
          kind: actor.kind,
          name: actor.name,
          scopes: actor.scopes,
          accountId: actor.accountId,
        },
      };
    },
    onError: (error) => {
      console.warn(
        "oauth: %s",
        error.code,
        redact({
          status: error.status,
          description: error.description,
          internal: error.internal
            ? { category: error.internal.category, reason: error.internal.reason }
            : undefined,
        }),
      );
    },
  });
}

/** The library's own handler types, which require a non-optional `fetch`. */
type ProviderApiHandler = NonNullable<OAuthProviderOptions<Env>["apiHandler"]>;
type ProviderDefaultHandler = OAuthProviderOptions<Env>["defaultHandler"];

/**
 * Accepts either handler shape and hands the library what it wants. The cast is the
 * gap between `ExportedHandler<Env>` (whose `fetch` is optional) and the library's
 * `ExportedHandlerWithFetch<Env>`; the function form always has one.
 */
function normaliseApiHandler(handler: ExportedHandler<Env> | ApiFetchHandler): ProviderApiHandler {
  const normalised: ExportedHandler<Env> =
    typeof handler === "function"
      ? { fetch: (request, env, ctx) => handler(request, env, ctx) }
      : handler;
  return normalised as ProviderApiHandler;
}

/* -------------------------------------------------------------------------- */
/* The approval page                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `GET/POST /oauth/authorize` — the operator's approval screen.
 *
 * Mount at the root (paths are absolute): `app.route("/", oauthRoutes())`.
 */
export function oauthRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get(AUTHORIZE_ENDPOINT, async (c) => {
    const helpers = oauthHelpers(c.env);
    if (!helpers) return htmlResponse(misconfiguredPage("OAuth provider not wired up"), 500);
    const missing = missingSecretsPage(c.env);
    if (missing) return htmlResponse(missing.html, missing.status);

    let authRequest: AuthRequest;
    try {
      authRequest = await helpers.parseAuthRequest(c.req.raw);
    } catch (error) {
      return authorizationErrorResponse(error);
    }

    const client = await helpers.lookupClient(authRequest.clientId);
    if (!client) {
      return htmlResponse(
        errorPage("Unknown OAuth client", "This client is not registered with this deployment."),
        400,
      );
    }

    const requested = normaliseScopes(authRequest.scope);
    const key = requireSigningKey(c.env);
    const { token: csrf, cookie } = await issueCsrfToken(c.env, CSRF_PURPOSE);
    const sealed = await signValue(
      key,
      { ar: base64UrlEncode(JSON.stringify(authRequest)) },
      AUTH_REQUEST_TTL_SECONDS,
    );

    return htmlResponse(
      approvePage({
        clientName: client.clientName ?? authRequest.clientId,
        clientUri: client.clientUri,
        redirectUri: authRequest.redirectUri,
        requested,
        checked: preTickedScopes(requested),
        csrf,
        sealed,
        signedIn: await hasAdminCookie(c.req.raw, c.env),
      }),
      200,
      csrfHeaders(cookie),
    );
  });

  app.post(AUTHORIZE_ENDPOINT, async (c) => {
    const helpers = oauthHelpers(c.env);
    if (!helpers) return htmlResponse(misconfiguredPage("OAuth provider not wired up"), 500);
    const missing = missingSecretsPage(c.env);
    if (missing) return htmlResponse(missing.html, missing.status);

    const submitted = await readApprovalForm(c.req.raw);
    const key = requireSigningKey(c.env);
    // A browser that already signed in at /admin/login (or on an earlier approval)
    // is not asked for the password again; the CSRF token still binds this form.
    const signedIn = await hasAdminCookie(c.req.raw, c.env);

    if (!(await verifyCsrfToken(c.req.raw, c.env, CSRF_PURPOSE, submitted.csrf))) {
      return htmlResponse(
        errorPage(
          "This approval form expired",
          "Start the connection again from your client so it sends a fresh authorization request.",
        ),
        403,
      );
    }

    const authRequest = await openSealedAuthRequest(key, submitted.sealed);
    if (!authRequest) {
      return htmlResponse(
        errorPage(
          "This approval form expired",
          "Start the connection again from your client so it sends a fresh authorization request.",
        ),
        400,
      );
    }

    const client = await helpers.lookupClient(authRequest.clientId);
    const clientName = client?.clientName ?? authRequest.clientId;
    const requested = normaliseScopes(authRequest.scope);

    if (!signedIn) {
      const outcome = await checkAdminPassword(
        c.req.raw,
        c.env,
        OAUTH_APPROVE_BUCKET,
        submitted.password,
      );
      if (!outcome.ok) {
        if (outcome.reason === "not-configured") {
          return htmlResponse(adminPasswordMissingPage(), 503);
        }
        const { token: csrf, cookie } = await issueCsrfToken(c.env, CSRF_PURPOSE);
        const sealed = await signValue(
          key,
          { ar: base64UrlEncode(JSON.stringify(authRequest)) },
          AUTH_REQUEST_TTL_SECONDS,
        );
        const extra: Record<string, string> =
          outcome.reason === "rate-limited" ? { "Retry-After": String(outcome.retryAfter) } : {};
        return htmlResponse(
          approvePage({
            clientName,
            clientUri: client?.clientUri,
            redirectUri: authRequest.redirectUri,
            requested,
            checked: submitted.scopes.length > 0 ? submitted.scopes : preTickedScopes(requested),
            csrf,
            sealed,
            error: outcome.message,
            signedIn: false,
          }),
          outcome.status,
          csrfHeaders(cookie, extra),
        );
      }
    }

    const granted = grantableScopes(requested, submitted.scopes);
    if (granted.length === 0) {
      const { token: csrf, cookie } = await issueCsrfToken(c.env, CSRF_PURPOSE);
      const sealed = await signValue(
        key,
        { ar: base64UrlEncode(JSON.stringify(authRequest)) },
        AUTH_REQUEST_TTL_SECONDS,
      );
      return htmlResponse(
        approvePage({
          clientName,
          clientUri: client?.clientUri,
          redirectUri: authRequest.redirectUri,
          requested,
          checked: preTickedScopes(requested),
          csrf,
          sealed,
          error: "Tick at least one scope, or cancel in your client.",
          signedIn,
        }),
        400,
        csrfHeaders(cookie),
      );
    }

    const { redirectTo } = await helpers.completeAuthorization({
      request: authRequest,
      userId: "admin",
      metadata: { label: clientName, approvedAt: new Date().toISOString() },
      scope: granted,
      props: {
        kind: "oauth",
        name: clientName,
        scopes: granted,
        accountId: DEFAULT_ACCOUNT_ID,
      },
    });

    const response = c.redirect(redirectTo, 302);
    // The password just proved the operator is here, so start the browser session
    // too: /admin/* and any later approval will not ask again.
    if (!signedIn) {
      const cookie = await adminSessionCookie(c.env);
      if (cookie) response.headers.append("Set-Cookie", cookie);
    }
    return response;
  });

  return app;
}

/**
 * `GET /` — the landing page.
 *
 * **Exported separately** from {@link oauthRoutes} (rather than bundled into it) so
 * `src/index.ts` can mount the public root page without implying it is part of the
 * OAuth flow, and so a deployment behind a custom front page can leave it out.
 */
/** Where the landing page sends people for docs; forks change this. */
const REPO_URL = "https://github.com/jitpal/weworking";

export function landingRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/", () => htmlResponse(landingPage()));
  return app;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The provider's helper object, or `null` when the app is running outside it. */
export function oauthHelpers(env: Env): OAuthHelpers | null {
  return (env as EnvWithHelpers).OAUTH_PROVIDER ?? null;
}

/** Keeps only scopes this deployment knows, de-duplicated and in canonical order. */
export function normaliseScopes(scopes: readonly string[] | undefined): Scope[] {
  if (!scopes) return [];
  return SCOPES_SUPPORTED.filter((scope) => scopes.includes(scope));
}

/**
 * What the form pre-ticks: the safe subset of what the client asked for, or the safe
 * default when it asked for nothing. Never `write`.
 */
export function preTickedScopes(requested: Scope[]): Scope[] {
  if (requested.length === 0) return [...DEFAULT_SCOPES];
  return requested.filter((scope) => DEFAULT_SCOPES.includes(scope));
}

/**
 * The scopes to actually grant: what the operator ticked, narrowed to what the
 * client asked for (a client that asked for nothing may receive any of them).
 */
export function grantableScopes(requested: Scope[], chosen: Scope[]): Scope[] {
  const allowed = requested.length > 0 ? requested : SCOPES_SUPPORTED;
  return allowed.filter((scope) => chosen.includes(scope));
}

function requireSigningKey(env: Env): string {
  // `missingSecretsPage()` has already rejected the request when this is absent.
  return env.COOKIE_SIGNING_KEY?.trim() ?? "";
}

async function openSealedAuthRequest(
  key: string,
  sealed: string | undefined,
): Promise<AuthRequest | null> {
  const claims = await verifyValue(key, sealed);
  if (!claims || typeof claims.ar !== "string") return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(claims.ar)) as AuthRequest;
    if (typeof parsed?.clientId !== "string" || typeof parsed?.redirectUri !== "string")
      return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Fields the approval form submits. Accepts a browser form post or a JSON body. */
interface ApprovalForm {
  password?: string;
  csrf?: string;
  sealed?: string;
  scopes: Scope[];
}

async function readApprovalForm(request: Request): Promise<ApprovalForm> {
  const contentType = request.headers.get("Content-Type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      const scopes = Array.isArray(body.scope)
        ? body.scope
        : Array.isArray(body.scopes)
          ? body.scopes
          : [];
      return {
        password: typeof body.password === "string" ? body.password : undefined,
        csrf: typeof body.csrf === "string" ? body.csrf : undefined,
        sealed: typeof body.auth_request === "string" ? body.auth_request : undefined,
        scopes: normaliseScopes(scopes.filter((s): s is string => typeof s === "string")),
      };
    }
    const form = await request.formData();
    const scopes = form.getAll("scope").filter((v): v is string => typeof v === "string");
    return {
      password: stringField(form.get("password")),
      csrf: stringField(form.get("csrf")),
      sealed: stringField(form.get("auth_request")),
      scopes: normaliseScopes(scopes),
    };
  } catch {
    return { scopes: [] };
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Turns a `parseAuthRequest` failure into either a local error page or an OAuth error redirect. */
function authorizationErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) throw error;
  if (!error.redirectUri) {
    return htmlResponse(errorPage("Invalid authorization request", error.description), 400);
  }
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect.toString(), 302);
}

/** `{ html, status }` when a secret this page needs is missing, otherwise `null`. */
function missingSecretsPage(env: Env): { html: string; status: number } | null {
  if (!env.ADMIN_PASSWORD?.trim()) return { html: adminPasswordMissingPage(), status: 503 };
  if (!env.COOKIE_SIGNING_KEY?.trim()) {
    return {
      html: page({
        title: "Not configured",
        body: `${banner("err", "COOKIE_SIGNING_KEY secret not set")}<pre>npx wrangler secret put COOKIE_SIGNING_KEY</pre>`,
      }),
      status: 503,
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  read: "search desks, list locations and bookings",
  write: "book and cancel desks (spends your credits, within the configured caps)",
  admin: "nothing beyond write today; the operator pages need the admin password",
};

function approvePage(options: {
  clientName: string;
  clientUri?: string;
  redirectUri: string;
  requested: Scope[];
  checked: Scope[];
  csrf: string;
  sealed: string;
  error?: string;
  /** True when the browser already holds the admin session cookie. */
  signedIn: boolean;
}): string {
  let redirectHost = options.redirectUri;
  try {
    redirectHost = new URL(options.redirectUri).host || options.redirectUri;
  } catch {
    // Keep the raw value; it is escaped on output either way.
  }
  const offered = options.requested.length > 0 ? options.requested : SCOPES_SUPPORTED;
  const checkboxes = offered
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"${
          options.checked.includes(scope) ? " checked" : ""
        }> <span><code>${escapeHtml(scope)}</code> — ${escapeHtml(SCOPE_DESCRIPTIONS[scope])}</span></label>`,
    )
    .join("");

  return page({
    title: "Authorize client",
    heading: "Authorize this client",
    subtitle: "Approving gives it access to your WeWork account through this deployment.",
    body: `
${options.error ? banner("err", options.error) : ""}
<div class="card">
${keyValueRow("Client", options.clientName)}
${options.clientUri ? keyValueRow("Client URL", options.clientUri) : ""}
${keyValueRow("Redirecting to", redirectHost)}
${keyValueRow(
  "Requested scopes",
  options.requested.length > 0 ? options.requested.join(", ") : "(none specified)",
)}
</div>
<form class="card" method="post" action="${escapeHtml(AUTHORIZE_ENDPOINT)}">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<input type="hidden" name="auth_request" value="${escapeHtml(options.sealed)}">
<label>Grant these scopes</label>
<div class="scopes">${checkboxes}</div>
${
  options.signedIn
    ? `<p class="small muted">Signed in as the operator of this deployment.</p>`
    : `<label for="password">Admin password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>`
}
<button type="submit">Approve</button>
</form>
<p class="small muted">Only approve a client you started yourself. If you did not open this page from your own MCP client, close it.</p>
<p class="small muted">The <code>admin</code> scope grants nothing beyond <code>write</code> today: the operator pages are reached with the admin password in a browser, not with an agent credential.</p>`,
  });
}

function keyValueRow(label: string, value: string): string {
  return `<p class="small"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`;
}

function errorPage(title: string, detail: string): string {
  return page({ title, body: banner("err", detail) });
}

function misconfiguredPage(detail: string): string {
  return page({
    title: "Not configured",
    body: `${banner("err", detail)}<p class="small muted">The worker must export the OAuthProvider built by <code>createOAuthProvider()</code>.</p>`,
  });
}

function adminPasswordMissingPage(): string {
  return page({
    title: "Not configured",
    body: `${banner("err", "ADMIN_PASSWORD secret not set")}
<p>This deployment cannot approve OAuth clients until the operator sets it:</p>
<pre>npx wrangler secret put ADMIN_PASSWORD</pre>`,
  });
}

function landingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CONTENT_SECURITY_POLICY)}">
<meta name="robots" content="noindex, nofollow">
<title>weworking</title>
<style>
html { background: #fff; color: #000; }
body { margin: 0; padding: clamp(1.5rem, 6vw, 5rem); font: 17px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
main { max-width: 34rem; }
h1 { font-size: clamp(2.6rem, 9vw, 5rem); font-weight: 500; letter-spacing: -0.04em; line-height: 1; margin: 0 0 1.5rem; }
p { margin: 0 0 1.25rem; }
a { color: inherit; text-decoration: underline; text-underline-offset: 0.2em; text-decoration-thickness: 1px; }
a:hover, a:focus-visible { text-decoration-thickness: 2px; outline: none; }
footer { max-width: 34rem; font-size: 0.85rem; color: #555; margin-top: 3rem; }
@media (prefers-color-scheme: dark) {
  html { background: #000; color: #fff; }
  footer { color: #999; }
}
</style>
</head>
<body>
<main>
<h1>weworking</h1>
<p>Your AI agent books your WeWork desk. This is one member's own copy, running on Cloudflare Workers and speaking MCP.</p>
<p><a href="${escapeHtml(REPO_URL)}">Source and setup instructions</a></p>
<p><a href="/admin">Operator sign in</a></p>
</main>
<footer>Unofficial. Not affiliated with WeWork. Bookings made through this deployment spend the operator's own credits.</footer>
</body>
</html>`;
}
