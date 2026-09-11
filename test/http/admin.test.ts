/**
 * The operator pages in `src/http/admin.ts`.
 *
 * The Durable Object is replaced by a plain object (the pages use a handful of RPC
 * methods, declared as `AdminSessionStub`), and `parseManualSession` is mocked at
 * the module boundary the admin pages import it through — so this file exercises the
 * page logic, not the WeWork parser or the DO.
 *
 * Every request carries the signed admin cookie, because that is the only credential
 * `requireAdmin` accepts.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const parseManualSession = vi.fn();
vi.mock("../../src/auth/_manual-shim", () => ({
  parseManualSession: (input: string | object, now?: () => number) =>
    parseManualSession(input, now),
  decodeJwtPayload: () => ({}),
}));

import { adminRoutes } from "../../src/auth/admin-session";
import { oauthRoutes } from "../../src/auth/oauth";
import { sha256Hex } from "../../src/auth/tokens";
import type { SessionInfo, SessionRecord } from "../../src/core/types";
import { AppError } from "../../src/errors";
import {
  type AdminSessionStub,
  adminPages,
  bookmarkletSource,
  devtoolsSnippet,
} from "../../src/http/admin";
import type { ApiKeySummary } from "../../src/session/do";
import {
  adminCookie,
  cookieHeader,
  cookiesFrom,
  fakeEnv,
  HTML_HEADERS,
  hiddenField,
} from "../auth/helpers";

const VALID_SESSION: SessionInfo = {
  state: "valid",
  source: "manual",
  obtainedAt: "2026-09-11T08:00:00.000Z",
  expiresAt: "2026-09-11T20:00:00.000Z",
  hasRefreshToken: true,
};

const KEY: ApiKeySummary = {
  id: "key-1",
  name: "claude-code",
  scopes: ["read", "write"],
  createdAt: "2026-09-10T12:00:00.000Z",
  lastUsedAt: "2026-09-11T08:15:00.000Z",
};

/** Records what the pages asked the Durable Object to do. */
function fakeStub(overrides: Partial<AdminSessionStub> = {}) {
  const stub = {
    getSessionInfo: vi.fn(async () => VALID_SESSION),
    setSession: vi.fn(async (_record: Omit<SessionRecord, "obtainedAt">) => {}),
    clearSession: vi.fn(async () => {}),
    createApiKey: vi.fn(async (_input: unknown) => {}),
    listApiKeys: vi.fn(async (): Promise<ApiKeySummary[]> => [KEY]),
    revokeApiKey: vi.fn(async (_id: string) => true),
    audit: vi.fn(async (_entry: unknown) => {}),
    listAudit: vi.fn(async () => [
      {
        id: 2,
        ts: "2026-09-11T09:30:00.000Z",
        actor: "bearer:<script>alert(1)</script>",
        tool: "create_booking",
        args: { quote: "[redacted]" },
        outcome: "ok",
        bookingId: "bk-1",
        credits: 1,
        dryRun: false,
      },
    ]),
    ...overrides,
  };
  return stub as AdminSessionStub & typeof stub;
}

async function adminEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return fakeEnv(overrides);
}

/** The `Cookie` header a signed-in operator's browser sends. */
const AUTH = { Cookie: await adminCookie() };

beforeEach(() => {
  parseManualSession.mockReset();
});

describe("authentication", () => {
  it("redirects an unauthenticated browser to the login form", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request("/admin", { headers: HTML_HEADERS }, await adminEnv());
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/admin/login?next=%2Fadmin");
  });

  it("answers an unauthenticated API caller with 401 and the OAuth challenge", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request(
      "/admin/status",
      { headers: { Accept: "application/json" } },
      await adminEnv(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  });

  it("lets the signed-in operator through", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request("/admin/status", { headers: AUTH }, await adminEnv());
    expect(response.status).toBe(200);
  });

  it("refuses an agent credential, whatever its scopes", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request(
      "/admin/status",
      { headers: { Authorization: "Bearer ww_anything", Accept: "application/json" } },
      await adminEnv(),
    );
    expect(response.status).toBe(401);
  });
});

describe("GET /admin", () => {
  it("renders the session state, the caps and the links", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const response = await app.request(
      "/admin",
      { headers: { ...AUTH, ...HTML_HEADERS } },
      await adminEnv(),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Connected to WeWork");
    expect(html).toContain("valid");
    expect(html).toContain("2026-09-11T20:00:00.000Z");
    expect(html).toContain("Bookings per day");
    expect(html).toContain("/mcp</pre>");
    expect(html).toContain('href="/admin/keys"');
    expect(html).toContain('href="/admin/connect"');
    expect(html).toContain('href="/admin/audit"');
    expect(html).toContain("https://desk.example.com/mcp");
    expect(html).toContain("Content-Security-Policy");
    expect(stub.getSessionInfo).toHaveBeenCalled();
  });

  it("shows a prompt to connect when nothing is stored", async () => {
    const stub = fakeStub({
      getSessionInfo: vi.fn(async () => ({
        state: "none" as const,
        source: "none" as const,
        hasRefreshToken: false,
      })),
    });
    const app = adminPages({ sessionStub: () => stub });
    const response = await app.request(
      "/admin",
      { headers: { ...AUTH, ...HTML_HEADERS } },
      await adminEnv(),
    );
    await expect(response.text()).resolves.toContain("Not connected to WeWork yet");
  });

  it("surfaces a flash message from the query string, escaped", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request(
      `/admin?flash=${encodeURIComponent("connected, expires <2026>")}`,
      { headers: { ...AUTH, ...HTML_HEADERS } },
      await adminEnv(),
    );
    const html = await response.text();
    expect(html).toContain("connected, expires &lt;2026&gt;");
    expect(html).not.toContain("expires <2026>");
  });

  it("reports a configuration problem instead of failing", async () => {
    const env = await adminEnv({ QUOTE_SIGNING_KEY: "too-short" });
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request("/admin", { headers: { ...AUTH, ...HTML_HEADERS } }, env);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Configuration problem");
  });
});

describe("GET /admin/connect", () => {
  it("explains the four steps, the bookmarklet and the storage promise", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request(
      "/admin/connect",
      { headers: { ...AUTH, ...HTML_HEADERS } },
      await adminEnv(),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("members.wework.com");
    expect(html).toContain("bookmarks bar");
    expect(html).toContain("clipboard");
    expect(html).toContain("@@auth0spajs@@");
    expect(html).toContain("encrypted at rest");
    expect(html).toContain("never shown again");
    expect(html).toContain("LOGIN_STRATEGY");
    expect(html).toContain('<textarea id="session" name="session"');
    expect(html).toContain('action="/admin/session"');
    expect(html).toContain("DevTools");
  });

  it("embeds a bookmarklet that collects the Auth0 cache and opens this deployment", () => {
    const source = bookmarkletSource("https://desk.example.com/");
    expect(source.startsWith("javascript:(function(){")).toBe(true);
    expect(source).toContain("localStorage");
    expect(source).toContain("@@auth0spajs@@");
    expect(source).toContain("navigator.clipboard");
    expect(source).toContain("window.prompt");
    expect(source).toContain("https://desk.example.com/admin/connect");
    expect(source).not.toContain("//admin/connect");
    expect(devtoolsSnippet("https://desk.example.com")).toContain("localStorage.key(i)");
  });

  it("escapes the bookmarklet into the href rather than emitting raw quotes", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const html = await (
      await app.request(
        "/admin/connect",
        { headers: { ...AUTH, ...HTML_HEADERS } },
        await adminEnv(),
      )
    ).text();
    expect(html).toContain("&#39;@@auth0spajs@@&#39;");
  });

  it("shows the error and hint a failed paste redirected with", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const html = await (
      await app.request(
        "/admin/connect?error=No%20access%20token&hint=Paste%20the%20whole%20entry",
        { headers: { ...AUTH, ...HTML_HEADERS } },
        await adminEnv(),
      )
    ).text();
    expect(html).toContain("No access token");
    expect(html).toContain("Paste the whole entry");
  });
});

describe("POST /admin/session", () => {
  const RECORD: Omit<SessionRecord, "obtainedAt"> = {
    accessToken: "eyJ-access",
    refreshToken: "refresh-1",
    expiresAt: Date.parse("2026-09-11T20:00:00.000Z"),
    source: "manual",
    userUuid: "user-uuid-1",
  };

  it("stores what the parser returned and redirects with an expiry flash", async () => {
    parseManualSession.mockReturnValue(RECORD);
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const response = await app.request(
      "/admin/session",
      {
        method: "POST",
        headers: { ...AUTH, ...HTML_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ session: '{"@@auth0spajs@@::x":"{}"}' }),
      },
      await adminEnv(),
    );
    expect(response.status).toBe(303);
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith("/admin?flash=")).toBe(true);
    expect(decodeURIComponent(location)).toContain("connected");
    expect(decodeURIComponent(location)).toContain("2026-09-11T20:00:00.000Z");
    expect(stub.setSession).toHaveBeenCalledWith(RECORD);
    expect(parseManualSession).toHaveBeenCalledWith('{"@@auth0spajs@@::x":"{}"}', undefined);
  });

  it("accepts a JSON body and answers with the new session info", async () => {
    parseManualSession.mockReturnValue(RECORD);
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const response = await app.request(
      "/admin/session",
      {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ session: "eyJ-a-bare-jwt" }),
      },
      await adminEnv(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, session: VALID_SESSION });
    expect(stub.setSession).toHaveBeenCalledWith(RECORD);
  });

  it("sends an HTML caller back to the connect page with the parser's hint", async () => {
    parseManualSession.mockImplementation(() => {
      throw new AppError("VALIDATION", "No access token was found in the pasted value.", {
        hint: "Paste the @@auth0spajs@@ entry.",
      });
    });
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const response = await app.request(
      "/admin/session",
      {
        method: "POST",
        headers: { ...AUTH, ...HTML_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ session: "garbage" }),
      },
      await adminEnv(),
    );
    expect(response.status).toBe(303);
    const location = decodeURIComponent(response.headers.get("Location") ?? "");
    expect(location.startsWith("/admin/connect?error=")).toBe(true);
    expect(location).toContain("No access token was found");
    expect(location).toContain("Paste the @@auth0spajs@@ entry.");
    expect(stub.setSession).not.toHaveBeenCalled();
  });

  it("returns the error envelope to a JSON caller", async () => {
    parseManualSession.mockImplementation(() => {
      throw new AppError("VALIDATION", "Unparseable.", { hint: "Try again." });
    });
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request(
      "/admin/session",
      {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ session: "garbage" }),
      },
      await adminEnv(),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; hint: string } };
    expect(body.error).toMatchObject({ code: "VALIDATION", hint: "Try again." });
  });

  it("rejects an empty paste before calling the parser", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request(
      "/admin/session",
      {
        method: "POST",
        headers: { ...AUTH, ...HTML_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ session: "   " }),
      },
      await adminEnv(),
    );
    expect(response.status).toBe(303);
    expect(decodeURIComponent(response.headers.get("Location") ?? "")).toContain(
      "Nothing was pasted",
    );
    expect(parseManualSession).not.toHaveBeenCalled();
  });

  it("refuses an absurdly large paste", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request(
      "/admin/session",
      {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ session: "x".repeat(70_000) }),
      },
      await adminEnv(),
    );
    expect(response.status).toBe(413);
    expect(parseManualSession).not.toHaveBeenCalled();
  });
});

describe("POST /admin/session/clear", () => {
  it("clears the stored session and warns that WeWork still has it", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const response = await app.request(
      "/admin/session/clear",
      { method: "POST", headers: { ...AUTH, ...HTML_HEADERS } },
      await adminEnv(),
    );
    expect(response.status).toBe(303);
    expect(decodeURIComponent(response.headers.get("Location") ?? "")).toContain("cleared");
    expect(stub.clearSession).toHaveBeenCalledTimes(1);
  });

  it("answers JSON callers with a result object", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const response = await app.request(
      "/admin/session/clear",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" } },
      await adminEnv(),
    );
    await expect(response.json()).resolves.toEqual({ ok: true, cleared: true });
  });
});

describe("GET /admin/audit", () => {
  it("renders a table and escapes every cell", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const response = await app.request(
      "/admin/audit?limit=10",
      { headers: { ...AUTH, ...HTML_HEADERS } },
      await adminEnv(),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<table>");
    expect(html).toContain("create_booking");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(stub.listAudit).toHaveBeenCalledWith({ limit: 10 });
  });

  it("serves the same data as JSON with ?format=json", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request(
      "/admin/audit?format=json&limit=3",
      { headers: AUTH },
      await adminEnv(),
    );
    const body = (await response.json()) as { entries: Array<{ tool: string }>; limit: number };
    expect(body.limit).toBe(3);
    expect(body.entries[0]?.tool).toBe("create_booking");
  });

  it("clamps a silly limit", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    await app.request("/admin/audit?limit=100000", { headers: AUTH }, await adminEnv());
    expect(stub.listAudit).toHaveBeenCalledWith({ limit: 500 });
    await app.request("/admin/audit?limit=nonsense", { headers: AUTH }, await adminEnv());
    expect(stub.listAudit).toHaveBeenLastCalledWith({ limit: 50 });
  });

  it("says so when the log is empty", async () => {
    const app = adminPages({ sessionStub: () => fakeStub({ listAudit: vi.fn(async () => []) }) });
    const html = await (
      await app.request("/admin/audit", { headers: { ...AUTH, ...HTML_HEADERS } }, await adminEnv())
    ).text();
    expect(html).toContain("No audit entries yet");
  });
});

describe("GET /admin/status", () => {
  it("returns the session, caps, switches and secret presence", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request("/admin/status", { headers: AUTH }, await adminEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: SessionInfo;
      caps: Record<string, number>;
      writeEnabled: boolean;
      secrets: Record<string, unknown>;
    };
    expect(body.session).toEqual(VALID_SESSION);
    expect(body.caps).toEqual({
      maxBookingsPerDay: 1,
      maxBookingsPerWeek: 5,
      maxCreditsPerBooking: 0,
    });
    expect(body.writeEnabled).toBe(true);
    expect(body.secrets).toEqual({
      weworkCredentials: false,
      adminPassword: true,
      quoteKey: true,
      cookieKey: true,
    });
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("still answers when the Durable Object call fails", async () => {
    const app = adminPages({
      sessionStub: () =>
        fakeStub({
          getSessionInfo: vi.fn(async () => {
            throw new AppError("SESSION_MISSING", "No session.");
          }),
        }),
    });
    const response = await app.request("/admin/status", { headers: AUTH }, await adminEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: SessionInfo };
    expect(body.session.state).toBe("none");
    expect(body.session.lastError).toContain("No session.");
  });
});

describe("/admin/keys", () => {
  /** Loads the list page and returns the CSRF pair a browser would hold. */
  async function loadKeys(
    app: ReturnType<typeof adminPages>,
    env: Awaited<ReturnType<typeof adminEnv>>,
  ) {
    const response = await app.request(
      "/admin/keys",
      { headers: { ...AUTH, ...HTML_HEADERS } },
      env,
    );
    const html = await response.text();
    const jar = { ...cookiesFrom(response) };
    return { response, html, csrf: hiddenField(html, "csrf"), jar };
  }

  /** Submits a key form the way a browser would: CSRF cookie plus matching field. */
  function post(
    app: ReturnType<typeof adminPages>,
    env: Awaited<ReturnType<typeof adminEnv>>,
    path: string,
    fields: Record<string, string>,
    scopes: string[],
    jar: Record<string, string>,
  ) {
    const body = new URLSearchParams(fields);
    for (const scope of scopes) body.append("scope", scope);
    return app.request(
      path,
      {
        method: "POST",
        headers: {
          ...HTML_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `${cookieHeader(jar)}; ${AUTH.Cookie}`,
        },
        body,
      },
      env,
    );
  }

  it("lists each key with its scopes, timestamps and status", async () => {
    const stub = fakeStub({
      listApiKeys: vi.fn(
        async (): Promise<ApiKeySummary[]> => [
          KEY,
          {
            id: "key-0",
            name: "retired",
            scopes: ["read"],
            createdAt: "2026-09-01T09:00:00.000Z",
            revokedAt: "2026-09-05T09:00:00.000Z",
          },
        ],
      ),
    });
    const app = adminPages({ sessionStub: () => stub });
    const { response, html } = await loadKeys(app, await adminEnv());

    expect(response.status).toBe(200);
    expect(html).toContain("claude-code");
    expect(html).toContain("read, write");
    expect(html).toContain("2026-09-10T12:00:00.000Z");
    expect(html).toContain("2026-09-11T08:15:00.000Z");
    expect(html).toContain("active");
    expect(html).toContain("revoked 2026-09-05T09:00:00.000Z");
    expect(html).toContain('action="/admin/keys/key-1/revoke"');
    // No revoke button for a key that is already revoked.
    expect(html).not.toContain('action="/admin/keys/key-0/revoke"');
    expect(html).toContain("Create key");
    expect(response.headers.getSetCookie().join(";")).toContain("ww_csrf=");
  });

  it("ticks read by default, offers write, and does not offer admin", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const { html } = await loadKeys(app, await adminEnv());
    expect(html).toContain('<input type="checkbox" name="scope" value="read" checked>');
    expect(html).toContain('<input type="checkbox" name="scope" value="write">');
    expect(html).not.toContain('name="scope" value="admin"');
  });

  it("says so when there are no keys yet", async () => {
    const app = adminPages({ sessionStub: () => fakeStub({ listApiKeys: vi.fn(async () => []) }) });
    const { html } = await loadKeys(app, await adminEnv());
    expect(html).toContain("No API keys yet");
  });

  it("escapes a name that came back from the Durable Object", async () => {
    const app = adminPages({
      sessionStub: () =>
        fakeStub({
          listApiKeys: vi.fn(async () => [{ ...KEY, name: "<script>alert(1)</script>" }]),
        }),
    });
    const { html } = await loadKeys(app, await adminEnv());
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("creates a key, shows it once, and stores only its hash", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const env = await adminEnv();
    const { csrf, jar } = await loadKeys(app, env);

    const response = await post(
      app,
      env,
      "/admin/keys",
      { csrf, name: "laptop" },
      ["read", "write"],
      jar,
    );
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(stub.createApiKey).toHaveBeenCalledTimes(1);
    const stored = vi.mocked(stub.createApiKey).mock.calls[0]?.[0] as {
      id: string;
      name: string;
      sha256: string;
      scopes: string[];
    };
    expect(stored.name).toBe("laptop");
    expect(stored.scopes).toEqual(["read", "write"]);
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The plaintext is on this page and nowhere else.
    const shown = /ww_[A-Za-z0-9_-]{43}/.exec(html)?.[0] ?? "";
    expect(shown).not.toBe("");
    expect(await sha256Hex(shown)).toBe(stored.sha256);
    expect(html).toContain("only time this key is displayed");
    expect(html).toContain(`Authorization: Bearer ${shown}`);
    expect(html).toContain(
      "claude mcp add --transport http weworking https://desk.example.com/mcp",
    );
    expect(html).toContain("curl -s -H");
    expect(html).toContain("mcpServers");

    // …and the list page afterwards knows the name, not the key.
    const listing = await app.request(
      "/admin/keys",
      { headers: { ...AUTH, ...HTML_HEADERS } },
      env,
    );
    const listHtml = await listing.text();
    expect(listHtml).toContain("claude-code");
    expect(listHtml).not.toContain(shown);
    expect(listHtml).not.toContain("ww_");
  });

  it("audits the creation without the key", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const env = await adminEnv();
    const { csrf, jar } = await loadKeys(app, env);
    const response = await post(app, env, "/admin/keys", { csrf, name: "laptop" }, ["read"], jar);
    const html = await response.text();
    const shown = /ww_[A-Za-z0-9_-]{43}/.exec(html)?.[0] ?? "";

    expect(stub.audit).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(stub.audit).mock.calls[0]?.[0] as {
      tool: string;
      args: unknown;
      outcome: string;
    };
    expect(entry.tool).toBe("admin.keys.create");
    expect(entry.outcome).toBe("ok");
    expect(JSON.stringify(entry)).not.toContain(shown);
    expect(JSON.stringify(entry.args)).toContain("laptop");
  });

  it("rejects a create without a valid CSRF token", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const env = await adminEnv();
    const { jar } = await loadKeys(app, env);

    const forged = await post(
      app,
      env,
      "/admin/keys",
      { csrf: "not-the-token", name: "x" },
      ["read"],
      jar,
    );
    expect(forged.status).toBe(403);
    await expect(forged.text()).resolves.toContain("submitted from another site");

    const missing = await post(app, env, "/admin/keys", { name: "x" }, ["read"], {});
    expect(missing.status).toBe(403);
    expect(stub.createApiKey).not.toHaveBeenCalled();
  });

  it("asks again for an empty name, a name that is too long, or no scopes", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const env = await adminEnv();

    for (const [fields, scopes, expected] of [
      [{ name: "  " }, ["read"], "1 to 64 characters"],
      [{ name: "x".repeat(65) }, ["read"], "1 to 64 characters"],
      [{ name: "fine" }, [], "Tick at least one scope"],
    ] as Array<[Record<string, string>, string[], string]>) {
      const { csrf, jar } = await loadKeys(app, env);
      const response = await post(app, env, "/admin/keys", { csrf, ...fields }, scopes, jar);
      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toContain(expected);
    }
    expect(stub.createApiKey).not.toHaveBeenCalled();
  });

  it("revokes a key and says so on the way back", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const env = await adminEnv();
    const { csrf, jar } = await loadKeys(app, env);

    const response = await post(app, env, "/admin/keys/key-1/revoke", { csrf }, [], jar);
    expect(response.status).toBe(303);
    const location = decodeURIComponent(response.headers.get("Location") ?? "");
    expect(location.startsWith("/admin/keys?flash=")).toBe(true);
    expect(location).toContain("revoked");
    expect(stub.revokeApiKey).toHaveBeenCalledWith("key-1");
    expect(stub.audit).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "admin.keys.revoke", outcome: "ok" }),
    );
  });

  it("reports an unknown key instead of claiming success", async () => {
    const stub = fakeStub({ revokeApiKey: vi.fn(async () => false) });
    const app = adminPages({ sessionStub: () => stub });
    const env = await adminEnv();
    const { csrf, jar } = await loadKeys(app, env);

    const response = await post(app, env, "/admin/keys/gone/revoke", { csrf }, [], jar);
    expect(response.status).toBe(303);
    expect(decodeURIComponent(response.headers.get("Location") ?? "")).toContain("unknown");
    expect(stub.audit).not.toHaveBeenCalled();
  });

  it("rejects a revoke without a valid CSRF token", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const env = await adminEnv();
    const { jar } = await loadKeys(app, env);

    const response = await post(app, env, "/admin/keys/key-1/revoke", { csrf: "forged" }, [], jar);
    expect(response.status).toBe(403);
    expect(stub.revokeApiKey).not.toHaveBeenCalled();
  });

  it("is closed to anyone without the admin cookie", async () => {
    const stub = fakeStub();
    const app = adminPages({ sessionStub: () => stub });
    const env = await adminEnv();

    const list = await app.request("/admin/keys", { headers: HTML_HEADERS }, env);
    expect(list.status).toBe(303);
    expect(list.headers.get("Location")).toBe("/admin/login?next=%2Fadmin%2Fkeys");

    const create = await app.request(
      "/admin/keys",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ name: "x" }),
      },
      env,
    );
    expect(create.status).toBe(401);
    expect(stub.createApiKey).not.toHaveBeenCalled();
  });
});

describe("composition with the other route groups", () => {
  it("does not gate /admin/login when both groups are mounted on one app", async () => {
    // `Hono#route()` copies a sub-app's middleware into the parent by path pattern,
    // so a wildcard `app.use("/admin/*", requireAdmin)` inside adminPages() would
    // also guard the login form and loop the redirect. This is the regression test
    // for how src/index.ts mounts them.
    const parent = new Hono<{ Bindings: ReturnType<typeof fakeEnv> }>();
    parent.route("/", adminPages({ sessionStub: () => fakeStub() }));
    parent.route("/", adminRoutes());
    parent.route("/", oauthRoutes());

    const env = await adminEnv();
    const login = await parent.request("/admin/login", { headers: HTML_HEADERS }, env);
    expect(login.status).toBe(200);
    await expect(login.text()).resolves.toContain("Admin password");

    const logout = await parent.request("/admin/logout", { headers: HTML_HEADERS }, env);
    expect(logout.status).toBe(303);

    // …while the pages themselves are still gated.
    const dashboard = await parent.request("/admin", { headers: HTML_HEADERS }, env);
    expect(dashboard.status).toBe(303);
    expect(dashboard.headers.get("Location")).toBe("/admin/login?next=%2Fadmin");

    // …and reachable once signed in.
    const authed = await parent.request("/admin", { headers: { ...AUTH, ...HTML_HEADERS } }, env);
    expect(authed.status).toBe(200);
  });

  it("leaves the OAuth approval page reachable without the admin cookie", async () => {
    const parent = new Hono<{ Bindings: ReturnType<typeof fakeEnv> }>();
    parent.route("/", adminPages({ sessionStub: () => fakeStub() }));
    parent.route("/", oauthRoutes());
    const response = await parent.request(
      "/oauth/authorize",
      { headers: HTML_HEADERS },
      await adminEnv(),
    );
    // 500 = our "provider not wired up" page: it reached the handler, not a redirect.
    expect(response.status).toBe(500);
  });
});
