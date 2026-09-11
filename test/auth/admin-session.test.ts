/**
 * The admin sign-in form, the signed cookie it mints, and the `requireAdmin` gate.
 *
 * Driven through `app.request()` on the route group itself — never through
 * `src/index.ts`.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_COOKIE,
  adminRoutes,
  CSRF_COOKIE,
  hasAdminCookie,
  requireAdmin,
  safeNextPath,
} from "../../src/auth/admin-session";
import { clearFailures } from "../../src/auth/rate-limit";
import {
  ADMIN_PASSWORD,
  adminCookie,
  cookieHeader,
  cookiesFrom,
  fakeEnv,
  HTML_HEADERS,
  hiddenField,
} from "./helpers";

const app = adminRoutes();

/** Loads the login form and returns the CSRF pair a browser would hold. */
async function loadLoginForm(env = fakeEnv(), next = "/admin") {
  const response = await app.request(
    `/admin/login?next=${encodeURIComponent(next)}`,
    { headers: HTML_HEADERS },
    env,
  );
  const html = await response.text();
  return { response, html, csrf: hiddenField(html, "csrf"), jar: cookiesFrom(response) };
}

async function submitLogin(
  password: string,
  options: { env?: Env_; next?: string; ip?: string } = {},
) {
  const env = options.env ?? fakeEnv();
  const form = await loadLoginForm(env, options.next ?? "/admin");
  const body = new URLSearchParams({
    password,
    csrf: form.csrf,
    next: options.next ?? "/admin",
  });
  return app.request(
    "/admin/login",
    {
      method: "POST",
      headers: {
        ...HTML_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(form.jar),
        "CF-Connecting-IP": options.ip ?? "203.0.113.7",
      },
      body,
    },
    env,
  );
}

type Env_ = ReturnType<typeof fakeEnv>;

beforeEach(() => {
  clearFailures();
});

describe("GET /admin/login", () => {
  it("renders the password form and sets a CSRF cookie", async () => {
    const { response, html, csrf, jar } = await loadLoginForm();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(html).toContain("Admin password");
    expect(html).toContain('action="/admin/login"');
    expect(csrf).not.toBe("");
    expect(jar[CSRF_COOKIE]).toBeTypeOf("string");
    const setCookie = response.headers.getSetCookie().join(";");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("carries a safe ?next= through the form and rejects an off-site one", async () => {
    const { html } = await loadLoginForm(fakeEnv(), "/admin/connect");
    expect(hiddenField(html, "next")).toBe("/admin/connect");
    const evil = await loadLoginForm(fakeEnv(), "//evil.example/steal");
    expect(hiddenField(evil.html, "next")).toBe("/admin");
    expect(safeNextPath("https://evil.example")).toBe("/admin");
    expect(safeNextPath(undefined)).toBe("/admin");
    expect(safeNextPath("/admin/audit?limit=10")).toBe("/admin/audit?limit=10");
  });

  it("answers 503 naming the missing secret when ADMIN_PASSWORD is unset", async () => {
    const response = await app.request(
      "/admin/login",
      { headers: HTML_HEADERS },
      fakeEnv({ ADMIN_PASSWORD: undefined }),
    );
    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toContain("ADMIN_PASSWORD secret not set");
  });
});

describe("POST /admin/login", () => {
  it("sets a signed 12h cookie and redirects to ?next= on the right password", async () => {
    const response = await submitLogin(ADMIN_PASSWORD, { next: "/admin/connect" });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/admin/connect");
    const setCookie = response.headers.getSetCookie().join(" ;; ");
    expect(setCookie).toContain(`${ADMIN_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=43200");

    const jar = cookiesFrom(response);
    const cookieRequest = new Request("https://desk.example.com/admin", {
      headers: { Cookie: cookieHeader({ [ADMIN_COOKIE]: jar[ADMIN_COOKIE] ?? "" }) },
    });
    await expect(hasAdminCookie(cookieRequest, fakeEnv())).resolves.toBe(true);
  });

  it("rejects a wrong password with 401 and no cookie", async () => {
    const response = await submitLogin("wrong-password");
    expect(response.status).toBe(401);
    const html = await response.text();
    expect(html).toContain("Incorrect password");
    expect(cookiesFrom(response)[ADMIN_COOKIE]).toBeUndefined();
  });

  it("rejects a missing or foreign CSRF token with 403", async () => {
    const env = fakeEnv();
    const response = await app.request(
      "/admin/login",
      {
        method: "POST",
        headers: { ...HTML_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: ADMIN_PASSWORD, csrf: "forged", next: "/admin" }),
      },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("expired");
  });

  it("locks the IP out after five failures", async () => {
    const ip = "198.51.100.4";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await submitLogin("wrong-password", { ip });
      expect(response.status).toBe(401);
    }
    const limited = await submitLogin("wrong-password", { ip });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    await expect(limited.text()).resolves.toContain("Too many failed attempts");

    // Even the correct password is refused while the bucket is locked…
    const correct = await submitLogin(ADMIN_PASSWORD, { ip });
    expect(correct.status).toBe(429);
    // …and a different IP is unaffected.
    const other = await submitLogin(ADMIN_PASSWORD, { ip: "198.51.100.5" });
    expect(other.status).toBe(303);
  });

  it("answers 503 when ADMIN_PASSWORD is unset", async () => {
    const env = fakeEnv({ ADMIN_PASSWORD: "" });
    const form = await loadLoginForm(fakeEnv());
    const response = await app.request(
      "/admin/login",
      {
        method: "POST",
        headers: {
          ...HTML_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader(form.jar),
        },
        body: new URLSearchParams({ password: "anything", csrf: form.csrf, next: "/admin" }),
      },
      env,
    );
    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toContain("ADMIN_PASSWORD secret not set");
  });
});

describe("GET /admin/logout", () => {
  it("clears the cookie and sends the operator back to the form", async () => {
    const response = await app.request("/admin/logout", { headers: HTML_HEADERS }, fakeEnv());
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/admin/login");
    expect(response.headers.getSetCookie().join(";")).toContain(`${ADMIN_COOKIE}=`);
  });
});

describe("requireAdmin", () => {
  const guarded = new Hono<{ Bindings: Env_; Variables: { actor?: never } }>();
  guarded.use("/guarded", requireAdmin);
  guarded.get("/guarded", (c) => c.json({ ok: true }));

  async function adminCookieJar() {
    const response = await submitLogin(ADMIN_PASSWORD);
    const jar = cookiesFrom(response);
    return { [ADMIN_COOKIE]: jar[ADMIN_COOKIE] ?? "" };
  }

  it("accepts the admin cookie", async () => {
    const jar = await adminCookieJar();
    const response = await guarded.request(
      "/guarded",
      { headers: { ...HTML_HEADERS, Cookie: cookieHeader(jar) } },
      fakeEnv(),
    );
    expect(response.status).toBe(200);
  });

  it("accepts the cookie however it was minted", async () => {
    const response = await guarded.request(
      "/guarded",
      { headers: { ...HTML_HEADERS, Cookie: await adminCookie() } },
      fakeEnv(),
    );
    expect(response.status).toBe(200);
  });

  it("refuses an agent credential: /admin is a browser surface", async () => {
    // The cookie is the only way in. An API key authenticates /mcp and /api/*, and
    // an actor another middleware resolved is not a substitute either.
    const withActor = new Hono<{ Bindings: Env_; Variables: { actor?: unknown } }>();
    withActor.use("/guarded", async (c, next) => {
      c.set("actor", { kind: "bearer", name: "ops", scopes: ["admin"], accountId: "default" });
      await next();
    });
    withActor.use("/guarded", requireAdmin);
    withActor.get("/guarded", (c) => c.json({ ok: true }));

    const withProps = await withActor.request(
      "/guarded",
      { headers: { Accept: "application/json" } },
      fakeEnv(),
    );
    expect(withProps.status).toBe(401);

    const withHeader = await guarded.request(
      "/guarded",
      { headers: { Accept: "application/json", Authorization: "Bearer ww_whatever" } },
      fakeEnv(),
    );
    expect(withHeader.status).toBe(401);
    expect(withHeader.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  });

  it("redirects an unauthenticated browser to the login form with ?next=", async () => {
    const response = await guarded.request("/guarded", { headers: HTML_HEADERS }, fakeEnv());
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/admin/login?next=%2Fguarded");
  });

  it("answers JSON callers with a 401 and the OAuth challenge", async () => {
    const response = await guarded.request(
      "/guarded",
      { headers: { Accept: "application/json" } },
      fakeEnv(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      "https://desk.example.com/.well-known/oauth-protected-resource",
    );
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("ignores a cookie signed with a different key", async () => {
    const jar = await adminCookieJar();
    const response = await guarded.request(
      "/guarded",
      { headers: { Accept: "application/json", Cookie: cookieHeader(jar) } },
      fakeEnv({ COOKIE_SIGNING_KEY: "aa".repeat(32) }),
    );
    expect(response.status).toBe(401);
  });
});
