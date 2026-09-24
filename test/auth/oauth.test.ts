/**
 * The OAuth approval screen and the landing page, driven against a fake
 * `env.OAUTH_PROVIDER` so no KV or real provider is involved.
 *
 * What matters here is the policy around `completeAuthorization`: the password (or
 * the admin cookie standing in for it), the CSRF binding, the scope narrowing, and
 * the props the grant ends up carrying — those props become the `Actor` on every
 * later `/mcp` call.
 */

import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_COOKIE } from "../../src/auth/admin-session";
import {
  callbackSource,
  grantableScopes,
  landingRoutes,
  normaliseScopes,
  oauthRoutes,
} from "../../src/auth/oauth";
import { clearFailures } from "../../src/auth/rate-limit";
import {
  ADMIN_PASSWORD,
  adminJar,
  cookieHeader,
  cookiesFrom,
  fakeEnv,
  HTML_HEADERS,
  hiddenField,
} from "./helpers";

const app = oauthRoutes();

const AUTH_REQUEST: AuthRequest = {
  responseType: "code",
  clientId: "client-123",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: ["read", "write"],
  state: "state-abc",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
};

const CLIENT: ClientInfo = {
  clientId: "client-123",
  redirectUris: [AUTH_REQUEST.redirectUri],
  clientName: "Claude <script>alert(1)</script>",
  clientUri: "https://claude.ai",
  tokenEndpointAuthMethod: "none",
};

/** A stand-in for the helper object the provider injects as `env.OAUTH_PROVIDER`. */
function fakeProvider(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    parseAuthRequest: vi.fn(async () => AUTH_REQUEST),
    lookupClient: vi.fn(async () => CLIENT),
    completeAuthorization: vi.fn(async () => ({
      redirectTo: `${AUTH_REQUEST.redirectUri}?code=abc&state=state-abc`,
    })),
    ...overrides,
  };
}

function envWith(provider: unknown, overrides: Partial<Record<string, unknown>> = {}) {
  return fakeEnv({ OAUTH_PROVIDER: provider, ...overrides });
}

/** Renders the approval page and returns the CSRF pair plus the sealed auth request. */
async function loadApprovePage(provider = fakeProvider(), overrides = {}) {
  const env = envWith(provider, overrides);
  const response = await app.request(
    "/oauth/authorize?response_type=code&client_id=client-123",
    { headers: HTML_HEADERS },
    env,
  );
  const html = await response.text();
  return {
    env,
    provider,
    response,
    html,
    csrf: hiddenField(html, "csrf"),
    sealed: hiddenField(html, "auth_request"),
    jar: cookiesFrom(response),
  };
}

async function approve(options: {
  password: string;
  scopes?: string[];
  provider?: ReturnType<typeof fakeProvider>;
  ip?: string;
  tamperCsrf?: boolean;
}) {
  const form = await loadApprovePage(options.provider ?? fakeProvider());
  const body = new URLSearchParams();
  body.set("password", options.password);
  body.set("csrf", options.tamperCsrf ? "forged" : form.csrf);
  body.set("auth_request", form.sealed);
  for (const scope of options.scopes ?? ["read", "write"]) body.append("scope", scope);
  const response = await app.request(
    "/oauth/authorize",
    {
      method: "POST",
      headers: {
        ...HTML_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(form.jar),
        "CF-Connecting-IP": options.ip ?? "203.0.113.9",
      },
      body,
    },
    form.env,
  );
  return { response, provider: form.provider, form };
}

/** First argument of the first `completeAuthorization()` call, untyped by design. */
function firstCall(provider: ReturnType<typeof fakeProvider>): unknown {
  return (provider.completeAuthorization.mock.calls as unknown as unknown[][])[0]?.[0];
}

beforeEach(() => {
  clearFailures();
});

describe("GET /oauth/authorize", () => {
  it("shows the client, the redirect host and the requested scopes", async () => {
    const { response, html } = await loadApprovePage();
    expect(response.status).toBe(200);
    expect(html).toContain("Claude");
    expect(html).toContain("claude.ai");
    // read is pre-ticked; write is offered but the operator has to tick it.
    expect(html).toContain('name="scope" value="read" checked');
    expect(html).toContain('name="scope" value="write"> <span>');
    expect(html).not.toContain('name="scope" value="write" checked');
    expect(html).toContain("Admin password");
  });

  it("sends the clickjacking headers with the approval screen", async () => {
    const { response } = await loadApprovePage();
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("lets the redirect after Approve reach the client's callback", async () => {
    // Chrome applies form-action to the redirect that follows the post, so 'self'
    // alone blocks the hop to the client. Both copies of the policy allow it.
    const { response, html } = await loadApprovePage();
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' https://claude.ai;",
    );
    const meta = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(meta).toContain("form-action &#39;self&#39; https://claude.ai");
    expect(meta).not.toContain("frame-ancestors");
  });

  it("escapes the client name rather than rendering its markup", async () => {
    const { html } = await loadApprovePage();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("pre-ticks read only when the client asks for no scopes", async () => {
    const provider = fakeProvider({
      parseAuthRequest: vi.fn(async () => ({ ...AUTH_REQUEST, scope: [] })),
    });
    const { html } = await loadApprovePage(provider);
    expect(html).toContain('name="scope" value="read" checked');
    expect(html).toContain('name="scope" value="write"> <span>');
    expect(html).toContain('name="scope" value="admin"> <span>');
  });

  it("pre-ticks nothing when the client asked only for write", async () => {
    const provider = fakeProvider({
      parseAuthRequest: vi.fn(async () => ({ ...AUTH_REQUEST, scope: ["write"] })),
    });
    const { html } = await loadApprovePage(provider);
    expect(html).not.toContain(" checked");
    expect(html).toContain('name="scope" value="write"> <span>');
  });

  it("answers 503 when ADMIN_PASSWORD is unset", async () => {
    const response = await app.request(
      "/oauth/authorize",
      { headers: HTML_HEADERS },
      envWith(fakeProvider(), { ADMIN_PASSWORD: undefined }),
    );
    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toContain("ADMIN_PASSWORD secret not set");
  });

  it("renders a local 400 for an unknown client", async () => {
    const provider = fakeProvider({ lookupClient: vi.fn(async () => null) });
    const { response, html } = await loadApprovePage(provider);
    expect(response.status).toBe(400);
    expect(html).toContain("Unknown OAuth client");
  });

  it("renders an AuthorizationError locally when there is no validated redirect URI", async () => {
    const provider = fakeProvider({
      parseAuthRequest: vi.fn(async () => {
        throw new AuthorizationError("invalid_request", { description: "Missing response_type" });
      }),
    });
    const { response, html } = await loadApprovePage(provider);
    expect(response.status).toBe(400);
    expect(html).toContain("Missing response_type");
  });

  it("redirects the error to the client when the redirect URI was validated", async () => {
    const provider = fakeProvider({
      parseAuthRequest: vi.fn(async () => {
        throw new AuthorizationError("invalid_scope", {
          description: "Unsupported scope",
          redirectUri: "https://claude.ai/cb",
          state: "state-abc",
        });
      }),
    });
    const { response } = await loadApprovePage(provider);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe("https://claude.ai/cb");
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("state")).toBe("state-abc");
  });

  it("reports a missing provider binding instead of throwing", async () => {
    const response = await app.request("/oauth/authorize", { headers: HTML_HEADERS }, fakeEnv());
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("OAuth provider not wired up");
  });
});

describe("POST /oauth/authorize", () => {
  it("completes the authorization and redirects to the client", async () => {
    const { response, provider } = await approve({ password: ADMIN_PASSWORD });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("code=abc");

    expect(provider.completeAuthorization).toHaveBeenCalledTimes(1);
    const call = firstCall(provider) as {
      request: AuthRequest;
      userId: string;
      scope: string[];
      metadata: { label: string };
      props: { name: string; scopes: string[]; accountId: string; kind: string };
    };
    expect(call.userId).toBe("admin");
    expect(call.request.clientId).toBe("client-123");
    expect(call.scope).toEqual(["read", "write"]);
    expect(call.metadata.label).toBe(CLIENT.clientName);
    expect(call.props).toMatchObject({
      kind: "oauth",
      name: CLIENT.clientName,
      scopes: ["read", "write"],
      accountId: "default",
    });
  });

  it("grants only the ticked scopes", async () => {
    const { response, provider } = await approve({ password: ADMIN_PASSWORD, scopes: ["read"] });
    expect(response.status).toBe(302);
    const call = firstCall(provider) as { scope: string[] };
    expect(call.scope).toEqual(["read"]);
  });

  it("never grants a scope the client did not request", async () => {
    const { provider } = await approve({
      password: ADMIN_PASSWORD,
      scopes: ["read", "write", "admin"],
    });
    const call = firstCall(provider) as { scope: string[] };
    expect(call.scope).toEqual(["read", "write"]);
  });

  it("re-renders the form on a wrong password and grants nothing", async () => {
    const { response, provider } = await approve({ password: "nope" });
    expect(response.status).toBe(401);
    const html = await response.text();
    expect(html).toContain("Incorrect password");
    expect(html).toContain("Admin password");
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("keeps the callback allowed on the re-rendered form", async () => {
    const { response } = await approve({ password: "nope" });
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' https://claude.ai;",
    );
  });

  it("rejects a forged CSRF token", async () => {
    const { response, provider } = await approve({ password: ADMIN_PASSWORD, tamperCsrf: true });
    expect(response.status).toBe(403);
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a tampered auth_request, so the redirect URI cannot be swapped", async () => {
    const form = await loadApprovePage();
    const forged = btoa(
      JSON.stringify({ ...AUTH_REQUEST, redirectUri: "https://evil.example/steal" }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const body = new URLSearchParams({
      password: ADMIN_PASSWORD,
      csrf: form.csrf,
      auth_request: `${forged}.${"0".repeat(64)}`,
    });
    body.append("scope", "read");
    const response = await app.request(
      "/oauth/authorize",
      {
        method: "POST",
        headers: {
          ...HTML_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader(form.jar),
        },
        body,
      },
      form.env,
    );
    expect(response.status).toBe(400);
    expect(form.provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("asks again when no scope is ticked", async () => {
    const { response, provider } = await approve({ password: ADMIN_PASSWORD, scopes: [] });
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Tick at least one scope");
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rate-limits password guessing per IP", async () => {
    const ip = "198.51.100.77";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { response } = await approve({ password: "nope", ip });
      expect(response.status).toBe(401);
    }
    const { response, provider } = await approve({ password: ADMIN_PASSWORD, ip });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTypeOf("string");
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });
});

describe("the operator's browser session", () => {
  it("asks for the password when the browser is not signed in", async () => {
    const { html } = await loadApprovePage();
    expect(html).toContain('name="password"');
    expect(html).not.toContain("Signed in as the operator");
  });

  it("signs the browser in when the password is accepted", async () => {
    const { response } = await approve({ password: ADMIN_PASSWORD });
    expect(response.status).toBe(302);
    expect(cookiesFrom(response)[ADMIN_COOKIE]).toBeTypeOf("string");
    expect(cookiesFrom(response)[ADMIN_COOKIE]).not.toBe("");
  });

  it("does not ask a signed-in browser for the password again", async () => {
    const env = envWith(fakeProvider());
    const response = await app.request(
      "/oauth/authorize?response_type=code&client_id=client-123",
      { headers: { ...HTML_HEADERS, Cookie: cookieHeader(await adminJar(env)) } },
      env,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain('name="password"');
    expect(html).toContain("Signed in as the operator");
    expect(html).toContain("Approve");
  });

  it("approves on the cookie alone, with no password in the form", async () => {
    const provider = fakeProvider();
    const env = envWith(provider);
    const session = cookieHeader(await adminJar(env));
    const page = await app.request(
      "/oauth/authorize?response_type=code&client_id=client-123",
      { headers: { ...HTML_HEADERS, Cookie: session } },
      env,
    );
    const html = await page.text();
    const body = new URLSearchParams({
      csrf: hiddenField(html, "csrf"),
      auth_request: hiddenField(html, "auth_request"),
    });
    body.append("scope", "read");

    const response = await app.request(
      "/oauth/authorize",
      {
        method: "POST",
        headers: {
          ...HTML_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `${cookieHeader(cookiesFrom(page))}; ${session}`,
        },
        body,
      },
      env,
    );
    expect(response.status).toBe(302);
    expect(provider.completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("still requires the CSRF token from a signed-in browser", async () => {
    const provider = fakeProvider();
    const env = envWith(provider);
    const session = cookieHeader(await adminJar(env));
    const page = await app.request(
      "/oauth/authorize?response_type=code&client_id=client-123",
      { headers: { ...HTML_HEADERS, Cookie: session } },
      env,
    );
    const html = await page.text();
    const body = new URLSearchParams({
      csrf: "forged",
      auth_request: hiddenField(html, "auth_request"),
    });
    body.append("scope", "read");

    const response = await app.request(
      "/oauth/authorize",
      {
        method: "POST",
        headers: {
          ...HTML_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `${cookieHeader(cookiesFrom(page))}; ${session}`,
        },
        body,
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });
});

describe("scope helpers", () => {
  it("normalises to the supported set in canonical order", () => {
    expect(normaliseScopes(["write", "read", "root"])).toEqual(["read", "write"]);
    expect(normaliseScopes(undefined)).toEqual([]);
  });

  it("narrows the grant to the intersection, defaulting to all when nothing was requested", () => {
    expect(grantableScopes(["read", "write"], ["write", "admin"])).toEqual(["write"]);
    expect(grantableScopes([], ["admin"])).toEqual(["admin"]);
    expect(grantableScopes(["read"], [])).toEqual([]);
  });
});

describe("landingRoutes", () => {
  it("serves a minimal landing page: name, disclaimer, repo link, operator sign-in", async () => {
    const response = await landingRoutes().request("/", { headers: HTML_HEADERS }, fakeEnv());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>weworking</h1>");
    expect(html).toContain("Unofficial");
    expect(html).toContain('href="https://github.com/jitpal/weworking"');
    expect(html).toContain('href="/admin"');
    expect(html).toContain("default-src &#39;none&#39;");
    // Nothing that belongs in the docs is repeated here.
    expect(html).not.toContain("docs/");
    expect(html).not.toContain("/api/openapi.json");
    expect(html).not.toContain("/healthz");
  });
});

describe("callbackSource", () => {
  it("allows the callback's origin, or an app's scheme", () => {
    expect(callbackSource("https://agent.meta.ai/oauth/callback?x=1")).toBe(
      "https://agent.meta.ai",
    );
    expect(callbackSource("http://localhost:33418/callback")).toBe("http://localhost:33418");
    expect(callbackSource("cursor://anysphere.cursor-mcp/oauth/callback")).toBe("cursor:");
    expect(callbackSource("not a url")).toBeNull();
  });
});
