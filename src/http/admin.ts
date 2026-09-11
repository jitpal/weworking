/**
 * The operator's pages: status, connect, audit.
 *
 * Everything here is behind {@link requireAdmin} (the `ww_admin` cookie, or an
 * `admin`-scoped token for scripted use). Three of these pages exist because the
 * interesting failure mode of this project is *not* code — it is "Auth0 refused an
 * automated login", which only a human with a browser can fix. `/admin/connect` is
 * that fix: a bookmarklet copies the Auth0 SPA cache out of `members.wework.com`,
 * the operator pastes it here, and the token lands in the Durable Object.
 *
 * The bookmarklet copies to the clipboard rather than POSTing here directly: the
 * admin cookie is `SameSite=Lax`, so a cross-site `fetch` from
 * `members.wework.com` would not carry it, and asking the operator to paste is
 * both simpler and easier to trust than a CORS exception on this route.
 *
 * No page ever displays a stored token — only `SessionInfo` (state, source,
 * timestamps, whether a refresh token exists).
 */

import { Hono } from "hono";
// TEMP: replace at integration — re-exports src/wework/auth (§11.1).
import { parseManualSession } from "../auth/_manual-shim";
import { type AdminEnv, readFormish, requireAdmin } from "../auth/admin-session";
import { baseUrlFrom } from "../auth/guard";
import type { SessionInfo, SessionRecord } from "../core/types";
import { type Config, type Env, parseConfig } from "../env";
import { isAppError, toErrorBody } from "../errors";
import { getSessionStub } from "../session/do";
import { banner, escapeHtml, htmlResponse, keyValues, page } from "./admin-html";

/** One audit row as `WeWorkSession.listAudit()` returns it (§11.2). */
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
}

/** Injectable dependencies — production defaults are the real DO stub and parser. */
export interface AdminPagesDeps {
  /** Resolves the session Durable Object stub. */
  sessionStub?: (env: Env) => AdminSessionStub;
  /** Parses whatever the operator pasted (§11.1 `parseManualSession`). */
  parseSession?: (input: string | object, now?: () => number) => Omit<SessionRecord, "obtainedAt">;
}

const MAX_PASTE_BYTES = 64 * 1024;
const DEFAULT_AUDIT_LIMIT = 50;

/**
 * `/admin`, `/admin/connect`, `/admin/session`, `/admin/session/clear`,
 * `/admin/audit`, `/admin/status`.
 *
 * Mount at the root (paths are absolute): `app.route("/", adminPages())`.
 */
export function adminPages(deps: AdminPagesDeps = {}): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  const stubFor = deps.sessionStub ?? defaultSessionStub;
  const parse = deps.parseSession ?? parseManualSession;

  app.use("/admin", requireAdmin);
  app.use("/admin/*", requireAdmin);

  /* ------------------------------------------------------------ dashboard */

  app.get("/admin", async (c) => {
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

  app.get("/admin/connect", (c) => {
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

  app.post("/admin/session", async (c) => {
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
      `/admin?flash=${encodeURIComponent(`WeWork session connected — expires ${expires}`)}`,
      303,
    );
  });

  app.post("/admin/session/clear", async (c) => {
    await stubFor(c.env).clearSession();
    if (expectsJson(c.req.raw)) return c.json({ ok: true, cleared: true }, 200);
    return c.redirect(
      `/admin?flash=${encodeURIComponent("Stored WeWork session cleared. It is not revoked upstream — sign out on members.wework.com too.")}`,
      303,
    );
  });

  /* ---------------------------------------------------------------- audit */

  app.get("/admin/audit", async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const rows = await stubFor(c.env).listAudit({ limit });
    if (c.req.query("format") === "json") {
      return c.json({ entries: rows, limit }, 200);
    }
    return htmlResponse(auditPage(rows, limit));
  });

  /* --------------------------------------------------------------- status */

  app.get("/admin/status", async (c) => {
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
  quoteTtlSeconds: number | null;
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
    authTokens: number;
  };
  configError?: string;
}

function defaultSessionStub(env: Env): AdminSessionStub {
  // The DO's RPC surface (§11.2) is a superset of what these pages use; the cast
  // keeps the admin module independent of the session module's type evolution.
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
      quoteTtlSeconds: config?.quoteTtlSeconds ?? null,
    },
    writeEnabled: config?.writeEnabled ?? false,
    loginStrategy: config?.loginStrategy ?? env.LOGIN_STRATEGY ?? "auto",
    secrets: {
      weworkCredentials: Boolean(env.WEWORK_USERNAME?.trim() && env.WEWORK_PASSWORD?.trim()),
      adminPassword: Boolean(env.ADMIN_PASSWORD?.trim()),
      quoteKey: Boolean(env.QUOTE_SIGNING_KEY?.trim()),
      cookieKey: Boolean(env.COOKIE_SIGNING_KEY?.trim()),
      authTokens: config?.authTokens.length ?? 0,
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
  const { status } = options;
  const sessionBanner =
    status.session.state === "valid"
      ? banner("ok", "WeWork session connected.")
      : status.session.state === "expiring"
        ? banner(
            "warn",
            "WeWork session expires soon; it will refresh itself if it has a refresh token.",
          )
        : status.session.state === "expired"
          ? banner("err", "WeWork session expired. Reconnect below.")
          : banner("warn", "No WeWork session stored yet. Connect one to use the API.");

  return page({
    title: "Admin",
    heading: "weworking admin",
    subtitle: options.baseUrl,
    nav: NAV,
    body: `
${options.flash ? banner("ok", options.flash) : ""}
${options.error ? banner("err", options.error) : ""}
${status.configError ? banner("err", `Configuration problem: ${status.configError}`) : ""}
${sessionBanner}
<div class="card">
<h2>WeWork session</h2>
${keyValues([
  ["State", status.session.state],
  ["Source", status.session.source],
  ["Obtained", status.session.obtainedAt ?? "—"],
  ["Expires", status.session.expiresAt ?? "—"],
  ["Refresh token", status.session.hasRefreshToken ? "yes" : "no"],
  ["Last error", status.session.lastError ?? "—"],
])}
<form method="post" action="/admin/session/clear">
<button type="submit">Clear stored session</button>
</form>
<p class="small muted">Clearing removes it from the Durable Object. It does not revoke it at WeWork — sign out there as well.</p>
</div>
<div class="card">
<h2>Safety configuration</h2>
${keyValues([
  ["Writes enabled", status.writeEnabled ? "yes" : "no (WRITE_ENABLED=false)"],
  ["Max bookings / day", status.caps.maxBookingsPerDay ?? "—"],
  ["Max bookings / week", status.caps.maxBookingsPerWeek ?? "—"],
  [
    "Max credits / booking",
    status.caps.maxCreditsPerBooking === 0
      ? "unlimited"
      : (status.caps.maxCreditsPerBooking ?? "—"),
  ],
  ["Quote TTL (s)", status.caps.quoteTtlSeconds ?? "—"],
  ["Login strategy", status.loginStrategy],
])}
</div>
<div class="card">
<h2>Secrets present</h2>
${keyValues([
  ["WeWork credentials", status.secrets.weworkCredentials ? "yes" : "no (paste a session instead)"],
  ["ADMIN_PASSWORD", status.secrets.adminPassword ? "yes" : "no"],
  ["QUOTE_SIGNING_KEY", status.secrets.quoteKey ? "yes" : "no"],
  ["COOKIE_SIGNING_KEY", status.secrets.cookieKey ? "yes" : "no"],
  ["Static tokens (AUTH_TOKENS)", status.secrets.authTokens],
])}
<p class="small muted">Presence only — no secret value is ever shown here.</p>
</div>
<div class="card">
<h2>Links</h2>
<ul class="small">
<li><a href="/admin/connect">Connect a WeWork session</a></li>
<li><a href="/admin/audit">Audit log</a> (<a href="/admin/audit?format=json">JSON</a>)</li>
<li><a href="/admin/status">This page as JSON</a></li>
<li><a href="/healthz">/healthz</a> · <a href="/api/openapi.json">/api/openapi.json</a></li>
<li><code>${escapeHtml(options.baseUrl)}/mcp</code> — the MCP endpoint for your client</li>
</ul>
</div>`,
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
<p>Drag this link to your bookmarks bar — it is a bookmarklet, so it runs on the WeWork tab, not here:</p>
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
<li>It is written to this worker's SQLite Durable Object, which Cloudflare stores encrypted at rest, and is never shown again — not on this page, not in <code>/healthz</code>, not in an MCP tool result, not in a log line.</li>
<li>Only <code>/admin/status</code>-style metadata is displayed: state, source, expiry, whether a refresh token came with it.</li>
<li>If the paste included a refresh token, the worker renews the session on its own (lazily on a 401, and from the daily cron when under six hours remain), so you should not need this page again for weeks.</li>
<li>Clearing the session here does not revoke it at WeWork. To fully revoke, sign out on <code>members.wework.com</code> as well.</li>
</ul>
</div>
<div class="card">
<h2>The automatic alternative</h2>
<p class="small">If you set the <code>WEWORK_USERNAME</code> and <code>WEWORK_PASSWORD</code> secrets and leave
<code>LOGIN_STRATEGY="auto"</code>, the worker performs the Auth0 login itself and you never need this page.
That often fails from Cloudflare's datacenter IPs (Auth0 answers with a bot-protection challenge —
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
<td>${escapeHtml(row.bookingId ?? "—")}</td>
<td>${escapeHtml(row.credits ?? "—")}</td>
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
