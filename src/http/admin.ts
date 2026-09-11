/**
 * The operator's pages: status, connect, API keys, audit.
 *
 * Everything here is behind {@link requireAdmin}, which accepts only the `ww_admin`
 * cookie: these are operator pages, driven from a browser. `/admin/connect` exists
 * because the interesting failure mode of this project is *not* code, it is "Auth0
 * refused an automated login", which only a human with a browser can fix. A
 * bookmarklet copies the Auth0 SPA cache out of `members.wework.com`, the operator
 * pastes it here, and the token lands in the Durable Object.
 *
 * `/admin/keys` is the other half: it mints the API keys agents authenticate with.
 * A key's plaintext is shown on exactly one page render and never stored, so the
 * Durable Object holds nothing but its SHA-256.
 *
 * The bookmarklet copies to the clipboard rather than POSTing here directly: the
 * admin cookie is `SameSite=Lax`, so a cross-site `fetch` from
 * `members.wework.com` would not carry it, and asking the operator to paste is
 * both simpler and easier to trust than a CORS exception on this route.
 *
 * No page ever displays a stored token, only `SessionInfo` (state, source,
 * timestamps, whether a refresh token exists).
 */

import { Hono } from "hono";
import {
  type AdminEnv,
  csrfHeaders,
  issueCsrfToken,
  readFormish,
  requireAdmin,
  verifyCsrfToken,
} from "../auth/admin-session";
import { baseUrlFrom } from "../auth/guard";
import { generateApiKey } from "../auth/tokens";
import type { Scope, SessionInfo, SessionRecord } from "../core/types";
import { type Config, type Env, parseConfig } from "../env";
import { isAppError, toErrorBody } from "../errors";
import type { ApiKeySummary } from "../session/do";
import { getSessionStub } from "../session/do";
import { parseManualSession } from "../wework/auth";
import { banner, escapeHtml, htmlResponse, keyValues, page } from "./admin-html";

/** One audit row as `WeWorkSession.listAudit()` returns it. */
export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  tool: string;
  args: unknown;
  outcome: string;
  bookingId?: string;
  credits?: number;
  dryRun: boolean;
  error?: string;
}

/**
 * The slice of the `WeWorkSession` Durable Object these pages use.
 *
 * Declaring it here (rather than typing against the DO class) keeps the admin pages
 * compilable while the session module evolves, and lets a test inject a plain object
 * instead of a real stub.
 */
export interface AdminSessionStub {
  getSessionInfo(): Promise<SessionInfo>;
  setSession(record: Omit<SessionRecord, "obtainedAt">): Promise<void>;
  clearSession(): Promise<void>;
  listAudit(opts?: { limit?: number }): Promise<AuditRow[]>;
  createApiKey(input: { id: string; name: string; sha256: string; scopes: Scope[] }): Promise<void>;
  listApiKeys(): Promise<ApiKeySummary[]>;
  revokeApiKey(id: string): Promise<boolean>;
  audit(entry: {
    actor: string;
    tool: string;
    args: unknown;
    outcome: "ok" | "error" | "denied";
  }): Promise<void>;
}

/** Injectable dependencies, production defaults are the real DO stub and parser. */
export interface AdminPagesDeps {
  /** Resolves the session Durable Object stub. */
  sessionStub?: (env: Env) => AdminSessionStub;
  /** Parses whatever the operator pasted. Defaults to `parseManualSession`. */
  parseSession?: (input: string | object, now?: () => number) => Omit<SessionRecord, "obtainedAt">;
}

const MAX_PASTE_BYTES = 64 * 1024;
const DEFAULT_AUDIT_LIMIT = 50;
/** Purpose string binding a CSRF token to the two API key forms. */
const KEYS_CSRF_PURPOSE = "admin-keys";
/** Longest an API key name may be; mirrors the Durable Object's own check. */
const KEY_NAME_MAX = 64;

/**
 * `/admin`, `/admin/connect`, `/admin/session`, `/admin/session/clear`,
 * `/admin/keys`, `/admin/keys/:id/revoke`, `/admin/audit`, `/admin/status`.
 *
 * Mount at the root (paths are absolute): `app.route("/", adminPages())`.
 */
export function adminPages(deps: AdminPagesDeps = {}): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  const stubFor = deps.sessionStub ?? defaultSessionStub;
  const parse = deps.parseSession ?? parseManualSession;

  // Per-route rather than `app.use("/admin/*", ...)`: `Hono#route()` copies a
  // sub-app's middleware into the parent by path pattern, so a wildcard here would
  // also gate `/admin/login` from `adminRoutes()` and loop the sign-in redirect.

  /* ------------------------------------------------------------ dashboard */

  app.get("/admin", requireAdmin, async (c) => {
    const status = await collectStatus(c.env, stubFor);
    const flash = c.req.query("flash");
    const problem = c.req.query("error");
    return htmlResponse(
      dashboardPage({
        status,
        baseUrl: baseUrlFrom(c.req.raw, c.env),
        flash: flash ?? undefined,
        error: problem ?? undefined,
      }),
    );
  });

  /* -------------------------------------------------------------- connect */

  app.get("/admin/connect", requireAdmin, (c) => {
    const baseUrl = baseUrlFrom(c.req.raw, c.env);
    return htmlResponse(
      connectPage({
        baseUrl,
        error: c.req.query("error") ?? undefined,
        hint: c.req.query("hint") ?? undefined,
      }),
    );
  });

  /* -------------------------------------------------------------- session */

  app.post("/admin/session", requireAdmin, async (c) => {
    const wantsJson = expectsJson(c.req.raw);
    const form = await readFormish(c.req.raw);
    const pasted = (form.session ?? "").trim();

    if (!pasted) {
      return respondSessionError(c, wantsJson, {
        message: "Nothing was pasted.",
        hint: "Copy your WeWork session with the bookmarklet (or the DevTools snippet) and paste it into the box.",
        status: 400,
      });
    }
    if (pasted.length > MAX_PASTE_BYTES) {
      return respondSessionError(c, wantsJson, {
        message: "That paste is too large to be a WeWork session.",
        hint: "Paste only the @@auth0spajs@@ entries (what the bookmarklet copies), not the whole localStorage.",
        status: 413,
      });
    }

    let record: Omit<SessionRecord, "obtainedAt">;
    try {
      record = parse(pasted);
    } catch (error) {
      const body = toErrorBody(error);
      return respondSessionError(c, wantsJson, {
        message: body.error.message,
        hint: body.error.hint ?? "Check you copied the whole value.",
        status: isAppError(error) ? error.status : 400,
        code: body.error.code,
      });
    }

    await stubFor(c.env).setSession(record);
    const expires = new Date(record.expiresAt).toISOString();

    if (wantsJson) {
      const session = await stubFor(c.env).getSessionInfo();
      return c.json({ ok: true, session }, 200);
    }
    return c.redirect(
      `/admin?flash=${encodeURIComponent(`WeWork session connected, expires ${expires}`)}`,
      303,
    );
  });

  app.post("/admin/session/clear", requireAdmin, async (c) => {
    await stubFor(c.env).clearSession();
    if (expectsJson(c.req.raw)) return c.json({ ok: true, cleared: true }, 200);
    return c.redirect(
      `/admin?flash=${encodeURIComponent("Stored WeWork session cleared. It is not revoked upstream, sign out on members.wework.com too.")}`,
      303,
    );
  });

  /* ----------------------------------------------------------- api keys */

  app.get("/admin/keys", requireAdmin, async (c) => {
    const keys = await stubFor(c.env).listApiKeys();
    const { token: csrf, cookie } = await issueCsrfToken(c.env, KEYS_CSRF_PURPOSE);
    return htmlResponse(
      keysPage({
        keys,
        csrf,
        baseUrl: baseUrlFrom(c.req.raw, c.env),
        flash: c.req.query("flash") ?? undefined,
        error: c.req.query("error") ?? undefined,
      }),
      200,
      csrfHeaders(cookie),
    );
  });

  app.post("/admin/keys", requireAdmin, async (c) => {
    const submitted = await readKeyForm(c.req.raw);
    if (!(await verifyCsrfToken(c.req.raw, c.env, KEYS_CSRF_PURPOSE, submitted.csrf))) {
      return keysErrorPage(
        c,
        stubFor,
        "That form expired or was submitted from another site. Try again.",
        403,
      );
    }

    const name = submitted.name.trim();
    if (name.length < 1 || name.length > KEY_NAME_MAX) {
      return keysErrorPage(c, stubFor, `Give the key a name of 1 to ${KEY_NAME_MAX} characters.`);
    }
    if (submitted.scopes.length === 0) {
      return keysErrorPage(c, stubFor, "Tick at least one scope.");
    }

    const { token, sha256 } = await generateApiKey();
    const id = crypto.randomUUID();
    const stub = stubFor(c.env);
    await stub.createApiKey({ id, name, sha256, scopes: submitted.scopes });
    // The key itself is never audited, only that one was minted and with what scopes.
    await auditKeyChange(stub, "admin.keys.create", { id, name, scopes: submitted.scopes });

    return htmlResponse(
      keyCreatedPage({
        name,
        scopes: submitted.scopes,
        token,
        baseUrl: baseUrlFrom(c.req.raw, c.env),
      }),
    );
  });

  app.post("/admin/keys/:id/revoke", requireAdmin, async (c) => {
    const submitted = await readKeyForm(c.req.raw);
    if (!(await verifyCsrfToken(c.req.raw, c.env, KEYS_CSRF_PURPOSE, submitted.csrf))) {
      return keysErrorPage(
        c,
        stubFor,
        "That form expired or was submitted from another site. Try again.",
        403,
      );
    }

    const id = c.req.param("id");
    const stub = stubFor(c.env);
    const revoked = await stub.revokeApiKey(id);
    if (revoked) await auditKeyChange(stub, "admin.keys.revoke", { id });

    const query = revoked
      ? `flash=${encodeURIComponent("API key revoked. It stops working on the next request.")}`
      : `error=${encodeURIComponent("That key is unknown or was already revoked.")}`;
    return c.redirect(`/admin/keys?${query}`, 303);
  });

  /* ---------------------------------------------------------------- audit */

  app.get("/admin/audit", requireAdmin, async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const rows = await stubFor(c.env).listAudit({ limit });
    if (c.req.query("format") === "json") {
      return c.json({ entries: rows, limit }, 200);
    }
    return htmlResponse(auditPage(rows, limit));
  });

  /* --------------------------------------------------------------- status */

  app.get("/admin/status", requireAdmin, async (c) => {
    const status = await collectStatus(c.env, stubFor);
    return c.json(
      {
        session: status.session,
        caps: status.caps,
        writeEnabled: status.writeEnabled,
        secrets: status.secrets,
        loginStrategy: status.loginStrategy,
        configError: status.configError,
      },
      200,
    );
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* Status gathering                                                            */
/* -------------------------------------------------------------------------- */

/** Caps and switches shown on the dashboard and returned by `/admin/status`. */
export interface AdminCaps {
  maxBookingsPerDay: number | null;
  maxBookingsPerWeek: number | null;
  maxCreditsPerBooking: number | null;
}

interface AdminStatus {
  session: SessionInfo;
  caps: AdminCaps;
  writeEnabled: boolean;
  loginStrategy: string;
  secrets: {
    weworkCredentials: boolean;
    adminPassword: boolean;
    quoteKey: boolean;
    cookieKey: boolean;
  };
  configError?: string;
}

function defaultSessionStub(env: Env): AdminSessionStub {
  // The DO's RPC surface is a superset of what these pages use; the cast keeps the
  // admin module independent of the session module's type evolution.
  return getSessionStub(env) as unknown as AdminSessionStub;
}

async function collectStatus(
  env: Env,
  stubFor: (env: Env) => AdminSessionStub,
): Promise<AdminStatus> {
  let config: Config | undefined;
  let configError: string | undefined;
  try {
    config = parseConfig(env);
  } catch (error) {
    configError = toErrorBody(error).error.message;
  }

  let session: SessionInfo = { state: "none", source: "none", hasRefreshToken: false };
  try {
    session = await stubFor(env).getSessionInfo();
  } catch (error) {
    session = {
      state: "none",
      source: "none",
      hasRefreshToken: false,
      lastError: toErrorBody(error).error.message,
    };
  }

  const status: AdminStatus = {
    session,
    caps: {
      maxBookingsPerDay: config?.maxBookingsPerDay ?? null,
      maxBookingsPerWeek: config?.maxBookingsPerWeek ?? null,
      maxCreditsPerBooking: config?.maxCreditsPerBooking ?? null,
    },
    writeEnabled: config?.writeEnabled ?? false,
    loginStrategy: config?.loginStrategy ?? env.LOGIN_STRATEGY ?? "auto",
    secrets: {
      weworkCredentials: Boolean(env.WEWORK_USERNAME?.trim() && env.WEWORK_PASSWORD?.trim()),
      adminPassword: Boolean(env.ADMIN_PASSWORD?.trim()),
      quoteKey: Boolean(env.QUOTE_SIGNING_KEY?.trim()),
      cookieKey: Boolean(env.COOKIE_SIGNING_KEY?.trim()),
    },
  };
  if (configError !== undefined) status.configError = configError;
  return status;
}

function expectsJson(request: Request): boolean {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) return true;
  const accept = request.headers.get("Accept") ?? "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

function clampLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_AUDIT_LIMIT;
  return Math.min(Math.max(parsed, 1), 500);
}

function respondSessionError(
  c: {
    json: (body: unknown, status: 400) => Response;
    redirect: (url: string, status: 303) => Response;
  },
  wantsJson: boolean,
  problem: { message: string; hint: string; status: number; code?: string },
): Response {
  if (wantsJson) {
    return c.json(
      {
        error: { code: problem.code ?? "VALIDATION", message: problem.message, hint: problem.hint },
      },
      problem.status as 400,
    );
  }
  return c.redirect(
    `/admin/connect?error=${encodeURIComponent(problem.message)}&hint=${encodeURIComponent(problem.hint)}`,
    303,
  );
}

/* -------------------------------------------------------------------------- */
/* API key forms                                                               */
/* -------------------------------------------------------------------------- */

/** What the two key forms submit. Browser form posts only; there is no JSON API here. */
interface KeyForm {
  name: string;
  scopes: Scope[];
  csrf?: string;
}

/**
 * Reads a key form.
 *
 * `readFormish()` is not reused because `scopes` is a repeated field: a form post
 * carries one `scope` value per ticked checkbox, which collapsing to a
 * `Record<string, string>` would lose.
 */
async function readKeyForm(request: Request): Promise<KeyForm> {
  try {
    const form = await request.formData();
    const scopes = form
      .getAll("scope")
      .filter((value): value is string => typeof value === "string");
    const csrf = form.get("csrf");
    const name = form.get("name");
    return {
      name: typeof name === "string" ? name : "",
      scopes: normaliseScopes(scopes),
      csrf: typeof csrf === "string" ? csrf : undefined,
    };
  } catch {
    return { name: "", scopes: [] };
  }
}

/** Keeps only scopes this deployment knows, de-duplicated and in canonical order. */
function normaliseScopes(values: readonly string[]): Scope[] {
  return KEY_SCOPES.filter((scope) => values.includes(scope));
}

/** Re-renders the key list with an error banner and a fresh CSRF token. */
async function keysErrorPage(
  c: {
    env: Env;
    req: { raw: Request };
  },
  stubFor: (env: Env) => AdminSessionStub,
  message: string,
  status = 400,
): Promise<Response> {
  const keys = await stubFor(c.env).listApiKeys();
  const { token: csrf, cookie } = await issueCsrfToken(c.env, KEYS_CSRF_PURPOSE);
  return htmlResponse(
    keysPage({ keys, csrf, baseUrl: baseUrlFrom(c.req.raw, c.env), error: message }),
    status,
    csrfHeaders(cookie),
  );
}

/** Records a key change in the audit log. Never receives the key itself. */
async function auditKeyChange(
  stub: AdminSessionStub,
  tool: "admin.keys.create" | "admin.keys.revoke",
  args: Record<string, unknown>,
): Promise<void> {
  try {
    await stub.audit({ actor: "admin:cookie", tool, args, outcome: "ok" });
  } catch (error) {
    // An audit failure must not lose the operator their key, or leave a revoked key
    // looking un-revoked. Report it and carry on.
    console.warn("admin: could not write the audit entry", {
      tool,
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* The bookmarklet                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Builds the `javascript:` bookmarklet the operator drags to their bookmarks bar.
 *
 * Run on `members.wework.com`, it collects every `@@auth0spajs@@*` localStorage
 * entry into one JSON object, copies it to the clipboard (falling back to a
 * `prompt()` when the Clipboard API is unavailable or denied), and opens
 * `<baseUrl>/admin/connect` to paste it into.
 */
export function bookmarkletSource(baseUrl: string): string {
  const connectUrl = `${baseUrl.replace(/\/+$/, "")}/admin/connect`;
  return (
    "javascript:(function(){" +
    "var o={},i,k;" +
    "for(i=0;i<localStorage.length;i++){k=localStorage.key(i);" +
    "if(k&&k.indexOf('@@auth0spajs@@')===0){o[k]=localStorage.getItem(k);}}" +
    "if(!Object.keys(o).length){alert('No WeWork session found in this tab. Sign in at members.wework.com, then click this bookmarklet on that page.');return;}" +
    "var j=JSON.stringify(o);" +
    `var u='${connectUrl}';` +
    "function go(){window.open(u,'_blank');}" +
    "function manual(){window.prompt('Copy this JSON, then paste it on the connect page:',j);go();}" +
    "if(navigator.clipboard&&navigator.clipboard.writeText){" +
    "navigator.clipboard.writeText(j).then(function(){alert('WeWork session copied. Paste it on the connect page that just opened.');go();},manual);" +
    "}else{manual();}" +
    "})();"
  );
}

/** The same thing as a DevTools console snippet, for browsers that block bookmarklets. */
export function devtoolsSnippet(baseUrl: string): string {
  const connectUrl = `${baseUrl.replace(/\/+$/, "")}/admin/connect`;
  return `// Run this in the DevTools console on https://members.wework.com while signed in.
const out = {};
for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  if (k && k.startsWith("@@auth0spajs@@")) out[k] = localStorage.getItem(k);
}
const json = JSON.stringify(out);
console.log(json);                 // copy this
copy(json);                        // or let DevTools copy it for you
open("${connectUrl}");             // then paste it here`;
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

const NAV: Array<[string, string]> = [
  ["/admin", "Status"],
  ["/admin/connect", "Connect WeWork"],
  ["/admin/keys", "API keys"],
  ["/admin/audit", "Audit log"],
  ["/healthz", "Health"],
  ["/admin/logout", "Sign out"],
];

function dashboardPage(options: {
  status: AdminStatus;
  baseUrl: string;
  flash?: string;
  error?: string;
}): string {
  const { status, baseUrl } = options;
  const mcpUrl = `${baseUrl}/mcp`;

  const sessionLine = (() => {
    switch (status.session.state) {
      case "valid":
        return status.session.hasRefreshToken
          ? "Connected to WeWork. The session renews itself, so you should not need to do anything here for a while."
          : `Connected to WeWork until ${status.session.expiresAt ?? "it expires"}. There is no refresh token, so you will need to reconnect after that.`;
      case "expiring":
        return status.session.hasRefreshToken
          ? "Connected to WeWork. The session is close to expiry and will renew itself."
          : "The WeWork session expires soon and cannot renew itself. Reconnect below when it does.";
      case "expired":
        return "The WeWork session has expired. Reconnect below.";
      default:
        return "Not connected to WeWork yet. Connect below before agents can search or book.";
    }
  })();
  const sessionKind =
    status.session.state === "valid" || status.session.state === "expiring" ? "ok" : "warn";

  const creditsCap =
    status.caps.maxCreditsPerBooking === null
      ? "unknown"
      : status.caps.maxCreditsPerBooking < 0
        ? "no limit"
        : status.caps.maxCreditsPerBooking === 0
          ? "free desks only (All Access desks and cash bookings cost no credits)"
          : `${status.caps.maxCreditsPerBooking} credits`;

  return page({
    title: "Status",
    heading: "Status",
    nav: NAV,
    body: `
${options.flash ? banner("ok", options.flash) : ""}
${options.error ? banner("err", options.error) : ""}
${status.configError ? banner("err", `Configuration problem: ${status.configError}`) : ""}
${banner(sessionKind, sessionLine)}
${
  status.writeEnabled
    ? ""
    : banner(
        "warn",
        "Booking is switched off (WRITE_ENABLED is false). Agents can search but cannot book or cancel. Set WRITE_ENABLED to true and redeploy to allow bookings.",
      )
}

<h2>Connect an agent</h2>
<p>This is the address agents connect to:</p>
<pre>${escapeHtml(mcpUrl)}</pre>
<p>Agents sign in one of two ways.</p>
<ul>
<li><a href="/admin/keys">Create an API key</a> and give it to the agent as a bearer header. This works everywhere, including scripts. For Claude Code:</li>
</ul>
<pre>claude mcp add --transport http weworking ${escapeHtml(mcpUrl)} \\
  --header "Authorization: Bearer ww_..."</pre>
<ul>
<li>Or let the agent use OAuth: add the address above in the client, and it will send you back here to approve it. claude.ai and ChatGPT connectors only support this route.</li>
</ul>
<pre>claude mcp add --transport http weworking ${escapeHtml(mcpUrl)}</pre>

<h2>Connect WeWork</h2>
<p>There are two ways to give this deployment access to your WeWork account.</p>
<ul>
<li><strong>Automatic sign-in.</strong> Set the WEWORK_USERNAME and WEWORK_PASSWORD secrets and the worker signs in by itself. ${
      status.secrets.weworkCredentials ? "Those secrets are set." : "Those secrets are not set."
    }</li>
<li><strong>Paste a session.</strong> Use this if your WeWork account has two-factor authentication, if you would rather not store your password, or if automatic sign-in is refused by WeWork's bot check. You sign in to WeWork in your own browser, copy the session with a bookmarklet, and paste it on the <a href="/admin/connect">connect page</a>. It takes about a minute and lasts for weeks.</li>
</ul>
${keyValues([
  ["Status", status.session.state],
  [
    "Connected via",
    status.session.source === "login"
      ? "automatic sign-in"
      : status.session.source === "manual"
        ? "pasted session"
        : status.session.source === "refresh"
          ? "renewed automatically"
          : "not connected",
  ],
  ["Expires", status.session.expiresAt ?? "n/a"],
  ["Renews itself", status.session.hasRefreshToken ? "yes" : "no"],
  ...(status.session.lastError
    ? [["Last problem", status.session.lastError] as [string, unknown]]
    : []),
])}
<form method="post" action="/admin/session/clear">
<button type="submit" class="quiet">Forget the stored session</button>
</form>
<p class="small muted">Forgetting it here does not sign you out of WeWork. To revoke it fully, sign out on members.wework.com too.</p>

<h2>Limits</h2>
<p>Every booking an agent makes has to fit inside these. Change them in wrangler.jsonc and redeploy.</p>
${keyValues([
  ["Bookings per day", status.caps.maxBookingsPerDay ?? "unknown"],
  ["Bookings per week", status.caps.maxBookingsPerWeek ?? "unknown"],
  ["Credits per booking", creditsCap],
  ["Booking allowed", status.writeEnabled ? "yes" : "no"],
])}

<h2>Setup check</h2>
${keyValues([
  ["Admin password", status.secrets.adminPassword ? "set" : "missing"],
  ["Quote signing key", status.secrets.quoteKey ? "set" : "missing"],
  ["Cookie signing key", status.secrets.cookieKey ? "set" : "missing"],
  [
    "WeWork username and password",
    status.secrets.weworkCredentials ? "set" : "not set (paste a session instead)",
  ],
])}
<p class="small muted">Only whether each secret exists is shown. Values are never displayed. The <a href="/admin/audit">audit log</a> lists every search and booking made through this deployment.</p>`,
  });
}

function connectPage(options: { baseUrl: string; error?: string; hint?: string }): string {
  const bookmarklet = bookmarkletSource(options.baseUrl);
  return page({
    title: "Connect WeWork",
    heading: "Connect your WeWork session",
    subtitle: "Four steps. Nothing leaves this page except the session you paste.",
    nav: NAV,
    body: `
${options.error ? banner("err", options.error) : ""}
${options.hint ? banner("warn", options.hint) : ""}
<div class="card">
<h2>1. Sign in to WeWork</h2>
<p>In another tab, open <code>https://members.wework.com</code> and sign in as you normally would
(including MFA, if you have it). Leave that tab open.</p>

<h2>2. Install the copier</h2>
<p>Drag this link to your bookmarks bar, it is a bookmarklet, so it runs on the WeWork tab, not here:</p>
<p><a class="bookmarklet" href="${escapeHtml(bookmarklet)}">Copy WeWork session</a></p>
<p class="small muted">Your browser may block clicking it on this page (the page's content-security policy
forbids scripts); dragging it to the bookmarks bar is the intended use. If your browser does not allow
bookmarklets at all, use the DevTools snippet at the bottom instead.</p>

<h2>3. Click it on the WeWork tab</h2>
<p>Switch to the <code>members.wework.com</code> tab and click the bookmark. It reads the Auth0 session
entries your browser already stored (<code>localStorage</code> keys beginning
<code>@@auth0spajs@@</code>), copies them to your clipboard as JSON, and opens this page again.</p>

<h2>4. Paste it below</h2>
<p>Paste and submit. The worker decodes the token for its expiry and your
<code>https://wework.com/user_uuid</code> claim, then stores it.</p>
<form method="post" action="/admin/session">
<label for="session">Pasted session JSON (or a raw <code>{access_token, refresh_token, expires_in}</code> object, or a bare access token)</label>
<textarea id="session" name="session" required spellcheck="false" autocomplete="off"
 placeholder='{"@@auth0spajs@@::...": "{\\"body\\":{\\"access_token\\":\\"eyJ...\\"}}"}'></textarea>
<button type="submit">Store session</button>
</form>
</div>
<div class="card">
<h2>What happens to the token</h2>
<ul class="small">
<li>It is written to this worker's SQLite Durable Object, which Cloudflare stores encrypted at rest, and is never shown again, not on this page, not in <code>/healthz</code>, not in an MCP tool result, not in a log line.</li>
<li>Only <code>/admin/status</code>-style metadata is displayed: state, source, expiry, whether a refresh token came with it.</li>
<li>If the paste included a refresh token, the worker renews the session on its own (lazily on a 401, and from the daily cron when under six hours remain), so you should not need this page again for weeks.</li>
<li>Clearing the session here does not revoke it at WeWork. To fully revoke, sign out on <code>members.wework.com</code> as well.</li>
</ul>
</div>
<div class="card">
<h2>The automatic alternative</h2>
<p class="small">If you set the <code>WEWORK_USERNAME</code> and <code>WEWORK_PASSWORD</code> secrets and leave
<code>LOGIN_STRATEGY="auto"</code>, the worker performs the Auth0 login itself and you never need this page.
That often fails from Cloudflare's datacenter IPs (Auth0 answers with a bot-protection challenge n/a
<code>UPSTREAM_BLOCKED</code>) and cannot work at all on an account with MFA. Pasting a session always works,
which is why it is the recommended route. Either way, once a refresh token is stored the worker stops
logging in.</p>
</div>
<div class="card">
<h2>DevTools snippet (same thing, no bookmarklet)</h2>
<pre>${escapeHtml(devtoolsSnippet(options.baseUrl))}</pre>
</div>`,
  });
}

function keysPage(options: {
  keys: ApiKeySummary[];
  csrf: string;
  baseUrl: string;
  flash?: string;
  error?: string;
}): string {
  const rows = options.keys
    .map((key) => {
      const revoked = key.revokedAt !== undefined;
      const action = revoked
        ? `<span class="muted">n/a</span>`
        : `<form method="post" action="/admin/keys/${encodeURIComponent(key.id)}/revoke">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<button type="submit">Revoke</button>
</form>`;
      return `<tr>
<td>${escapeHtml(key.name)}</td>
<td><code>${escapeHtml(key.scopes.join(", "))}</code></td>
<td>${escapeHtml(key.createdAt)}</td>
<td>${escapeHtml(key.lastUsedAt ?? "never")}</td>
<td>${escapeHtml(revoked ? `revoked ${key.revokedAt}` : "active")}</td>
<td>${action}</td>
</tr>`;
    })
    .join("");

  const table =
    options.keys.length === 0
      ? `<p class="muted">No API keys yet. Create one below.</p>`
      : `<div class="card"><table>
<thead><tr><th>Name</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>`;

  const checkboxes = KEY_SCOPES.map(
    (scope) =>
      `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"${
        scope === "read" ? " checked" : ""
      }> <span><code>${escapeHtml(scope)}</code>: ${escapeHtml(KEY_SCOPE_DESCRIPTIONS[scope])}</span></label>`,
  ).join("");

  return page({
    title: "API keys",
    heading: "API keys",
    subtitle: "Credentials for agents and scripts. Only their SHA-256 is stored.",
    nav: NAV,
    body: `
${options.flash ? banner("ok", options.flash) : ""}
${options.error ? banner("err", options.error) : ""}
${table}
<form class="card" method="post" action="/admin/keys">
<h2>Create a key</h2>
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<label for="name">Name</label>
<input id="name" name="name" type="text" maxlength="${KEY_NAME_MAX}" required spellcheck="false"
 autocomplete="off" placeholder="claude-code">
<label>Scopes</label>
<div class="scopes">${checkboxes}</div>
<button type="submit">Create key</button>
</form>
<p class="small muted">The key is shown once, on the next page. It cannot be recovered afterwards;
mint a new one and revoke the old one if you lose it. Revoking takes effect on the next request.</p>`,
  });
}

/** Scopes a key can carry. `admin` grants nothing beyond `write`, so it is not offered. */
const KEY_SCOPES: readonly Scope[] = ["read", "write"];

/** What each scope buys, in the operator's terms. */
const KEY_SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  read: "search desks, list locations and bookings",
  write: "book and cancel desks, within the configured caps",
  admin: "nothing beyond write today; these pages need the admin password",
};

function keyCreatedPage(options: {
  name: string;
  scopes: Scope[];
  token: string;
  baseUrl: string;
}): string {
  const mcpUrl = `${options.baseUrl.replace(/\/+$/, "")}/mcp`;
  const apiUrl = `${options.baseUrl.replace(/\/+$/, "")}/api/whoami`;
  const claudeCode = `claude mcp add --transport http weworking ${mcpUrl} \\
  --header "Authorization: Bearer ${options.token}"`;
  const cursor = `{
  "mcpServers": {
    "weworking": {
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer ${options.token}" }
    }
  }
}`;
  const curl = `curl -s -H "Authorization: Bearer ${options.token}" ${apiUrl}`;

  return page({
    title: "API key created",
    heading: "Copy this key now",
    subtitle: "It is shown on this page only. Nothing here can show it to you again.",
    nav: NAV,
    body: `
${banner("warn", "This is the only time this key is displayed. Copy it before you leave the page.")}
<div class="card">
${keyValues([
  ["Name", options.name],
  ["Scopes", options.scopes.join(", ")],
])}
<label for="key">The key</label>
<pre id="key">${escapeHtml(options.token)}</pre>
</div>
<div class="card">
<h2>Claude Code</h2>
<pre>${escapeHtml(claudeCode)}</pre>
<h2>Cursor (<code>~/.cursor/mcp.json</code>)</h2>
<pre>${escapeHtml(cursor)}</pre>
<h2>curl</h2>
<pre>${escapeHtml(curl)}</pre>
<p class="small muted">The header is a plain bearer credential: <code>Authorization: Bearer &lt;key&gt;</code>.
No other header is needed.</p>
</div>
<p class="small"><a href="/admin/keys">Back to the key list</a></p>`,
  });
}

function auditPage(rows: AuditRow[], limit: number): string {
  const body =
    rows.length === 0
      ? `<p class="muted">No audit entries yet.</p>`
      : `<div class="card"><table>
<thead><tr><th>When</th><th>Actor</th><th>Tool</th><th>Outcome</th><th>Booking</th><th>Credits</th><th>Dry run</th><th>Args</th></tr></thead>
<tbody>${rows
          .map(
            (row) => `<tr>
<td>${escapeHtml(row.ts)}</td>
<td>${escapeHtml(row.actor)}</td>
<td>${escapeHtml(row.tool)}</td>
<td>${escapeHtml(row.error ? `${row.outcome}: ${row.error}` : row.outcome)}</td>
<td>${escapeHtml(row.bookingId ?? "n/a")}</td>
<td>${escapeHtml(row.credits ?? "n/a")}</td>
<td>${row.dryRun ? "yes" : "no"}</td>
<td><code>${escapeHtml(JSON.stringify(row.args))}</code></td>
</tr>`,
          )
          .join("")}</tbody></table></div>`;

  return page({
    title: "Audit log",
    heading: "Audit log",
    subtitle: `Most recent ${limit} entries. Arguments are stored already redacted.`,
    nav: NAV,
    body: `${body}<p class="small"><a href="/admin/audit?format=json&amp;limit=${limit}">Same data as JSON</a></p>`,
  });
}
