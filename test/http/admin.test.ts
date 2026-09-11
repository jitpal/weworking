/**
 * The operator pages in `src/http/admin.ts`.
 *
 * The Durable Object is replaced by a plain object (the pages only use four RPC
 * methods, declared as `AdminSessionStub`), and `parseManualSession` is mocked at
 * the module boundary the admin pages import it through — so this file exercises the
 * page logic, not the WeWork parser or the DO.
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
import { fakeEnv, HTML_HEADERS } from "../auth/helpers";

const ADMIN_TOKEN = "ops-token";

const VALID_SESSION: SessionInfo = {
  state: "valid",
  source: "manual",
  obtainedAt: "2026-09-11T08:00:00.000Z",
  expiresAt: "2026-09-11T20:00:00.000Z",
  hasRefreshToken: true,
};

/** Records what the pages asked the Durable Object to do. */
function fakeStub(overrides: Partial<AdminSessionStub> = {}) {
  const stub = {
    getSessionInfo: vi.fn(async () => VALID_SESSION),
    setSession: vi.fn(async (_record: Omit<SessionRecord, "obtainedAt">) => {}),
    clearSession: vi.fn(async () => {}),
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
  const digest = await sha256Hex(ADMIN_TOKEN);
  return fakeEnv({
    AUTH_TOKENS: JSON.stringify([{ name: "ops", sha256: digest, scopes: ["admin"] }]),
    ...overrides,
  });
}

const AUTH = { Authorization: `Bearer ${ADMIN_TOKEN}` };

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

  it("lets an admin-scoped bearer token through", async () => {
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request("/admin/status", { headers: AUTH }, await adminEnv());
    expect(response.status).toBe(200);
  });

  it("refuses a write-scoped token", async () => {
    const digest = await sha256Hex("writer");
    const env = await adminEnv({
      AUTH_TOKENS: JSON.stringify([{ name: "w", sha256: digest, scopes: ["read", "write"] }]),
    });
    const app = adminPages({ sessionStub: () => fakeStub() });
    const response = await app.request(
      "/admin/status",
      { headers: { Authorization: "Bearer writer", Accept: "application/json" } },
      env,
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
    expect(html).toContain("WeWork session");
    expect(html).toContain("valid");
    expect(html).toContain("2026-09-11T20:00:00.000Z");
    expect(html).toContain("Max bookings / day");
    expect(html).toContain("unlimited");
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
    await expect(response.text()).resolves.toContain("No WeWork session stored yet");
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
      quoteTtlSeconds: 600,
    });
    expect(body.writeEnabled).toBe(true);
    expect(body.secrets).toEqual({
      weworkCredentials: false,
      adminPassword: true,
      quoteKey: true,
      cookieKey: true,
      authTokens: 1,
    });
    expect(JSON.stringify(body)).not.toContain("ops-token");
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

    // …and reachable with an admin token.
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
