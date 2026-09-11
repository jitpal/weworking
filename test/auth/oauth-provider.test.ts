/**
 * One end-to-end pass through the **real** `@cloudflare/workers-oauth-provider`,
 * using the `OAUTH_KV` binding from `cloudflare:test`: dynamic client registration,
 * our approval page, the token endpoint, and a protected route that reads
 * `ctx.props`.
 *
 * This is the only test that proves the three halves fit together — the props we
 * pass to `completeAuthorization()`, the props the provider hands the API handler,
 * and the `Actor` `resolveActor()` builds from them. It also covers the
 * `resolveExternalToken` seam with a real key in a real Durable Object, which is
 * what lets an API key reach `/mcp` through the provider instead of being rejected
 * as an unknown token.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { resolveActor } from "../../src/auth/guard";
import { createOAuthProvider, landingRoutes, oauthRoutes } from "../../src/auth/oauth";
import { generateApiKey } from "../../src/auth/tokens";
import type { Env } from "../../src/env";
import { getSessionStub } from "../../src/session/do";
import { cookieHeader, cookiesFrom, hiddenField } from "./helpers";

const BASE = "https://weworking.test";
const REDIRECT_URI = "https://client.example/callback";
const ADMIN_PASSWORD = "test-admin-password"; // from vitest.config.ts bindings

/** The protected handler: echoes the Actor the provider's props resolve to. */
const apiHandler = async (request: Request, workerEnv: Env, ctx: ExecutionContext) => {
  const props = (ctx as ExecutionContext & { props?: unknown }).props;
  const actor = await resolveActor(request, workerEnv, props);
  return Response.json({ actor, props });
};

function defaultHandler() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", landingRoutes());
  app.route("/", oauthRoutes());
  return { fetch: app.fetch } as ExportedHandler<Env>;
}

const provider = createOAuthProvider({
  apiHandler,
  defaultHandler: defaultHandler(),
  // CIMD would need `global_fetch_strictly_public`; this test registers a client via DCR.
  clientIdMetadataDocumentEnabled: false,
});

async function testEnv(): Promise<Env> {
  return env as unknown as Env;
}

/** Mints a real key in the real session Durable Object and returns its plaintext. */
async function mintKey(workerEnv: Env, name = "integration"): Promise<string> {
  const { token, sha256 } = await generateApiKey();
  await getSessionStub(workerEnv).createApiKey({
    id: crypto.randomUUID(),
    name,
    sha256,
    scopes: ["read", "write"],
  });
  return token;
}

/** Sends one request through the provider, as the Worker's `fetch` would. */
async function fetchThroughProvider(request: Request, workerEnv: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await provider.fetch(request, workerEnv as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

describe("workers-oauth-provider integration", () => {
  it("serves the protected-resource metadata the 401 challenge advertises", async () => {
    const workerEnv = await testEnv();
    const unauthorized = await fetchThroughProvider(new Request(`${BASE}/mcp`), workerEnv);
    expect(unauthorized.status).toBe(401);
    const challenge = unauthorized.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain("resource_metadata=");

    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
    const metadata = await fetchThroughProvider(new Request(metadataUrl), workerEnv);
    expect(metadata.status).toBe(200);
    const document = (await metadata.json()) as {
      scopes_supported: string[];
      resource_name: string;
      authorization_servers: string[];
    };
    expect(document.scopes_supported).toEqual(["read", "write", "admin"]);
    expect(document.resource_name).toContain("weworking");
  });

  it("advertises our endpoints in the authorization server metadata", async () => {
    const workerEnv = await testEnv();
    const response = await fetchThroughProvider(
      new Request(`${BASE}/.well-known/oauth-authorization-server`),
      workerEnv,
    );
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      scopes_supported: string[];
    };
    expect(document.authorization_endpoint).toBe(`${BASE}/oauth/authorize`);
    expect(document.token_endpoint).toBe(`${BASE}/oauth/token`);
    expect(document.registration_endpoint).toBe(`${BASE}/oauth/register`);
    expect(document.scopes_supported).toContain("write");
  });

  it("registers a client, approves it, mints a token and authenticates /mcp", async () => {
    const workerEnv = await testEnv();

    // 1. Dynamic client registration (what claude.ai does).
    const registration = await fetchThroughProvider(
      new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Integration Client",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      }),
      workerEnv,
    );
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };
    expect(client.client_id).toBeTypeOf("string");

    // 2. The authorization request lands on our approval page.
    const { verifier, challenge } = await pkcePair();
    const authorizeUrl = new URL(`${BASE}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("scope", "read write");
    authorizeUrl.searchParams.set("state", "state-xyz");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const formPage = await fetchThroughProvider(
      new Request(authorizeUrl, { headers: { Accept: "text/html" } }),
      workerEnv,
    );
    expect(formPage.status).toBe(200);
    const html = await formPage.text();
    expect(html).toContain("Integration Client");
    const csrf = hiddenField(html, "csrf");
    const sealed = hiddenField(html, "auth_request");
    const jar = cookiesFrom(formPage);

    // 3. Approve with the admin password.
    const body = new URLSearchParams({ password: ADMIN_PASSWORD, csrf, auth_request: sealed });
    body.append("scope", "read");
    body.append("scope", "write");
    const approved = await fetchThroughProvider(
      new Request(`${BASE}/oauth/authorize`, {
        method: "POST",
        headers: {
          Accept: "text/html",
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader(jar),
        },
        body,
      }),
      workerEnv,
    );
    expect(approved.status).toBe(302);
    const redirect = new URL(approved.headers.get("Location") ?? "");
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe("state-xyz");
    const code = redirect.searchParams.get("code") ?? "";
    expect(code).not.toBe("");

    // 4. Exchange the code for an access token.
    const tokenResponse = await fetchThroughProvider(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: client.client_id,
          code_verifier: verifier,
        }),
      }),
      workerEnv,
    );
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { access_token: string; scope?: string };
    expect(tokens.access_token).toBeTypeOf("string");

    // 5. The protected route sees the Actor we put in the grant's props.
    const protectedResponse = await fetchThroughProvider(
      new Request(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }),
      workerEnv,
    );
    expect(protectedResponse.status).toBe(200);
    const result = (await protectedResponse.json()) as {
      actor: { kind: string; name: string; scopes: string[]; accountId: string };
    };
    expect(result.actor).toEqual({
      kind: "oauth",
      name: "Integration Client",
      scopes: ["read", "write"],
      accountId: "default",
    });
  });

  it("accepts an API key on a protected route via resolveExternalToken", async () => {
    const workerEnv = await testEnv();
    const key = await mintKey(workerEnv);
    const response = await fetchThroughProvider(
      new Request(`${BASE}/api/whoami`, { headers: { Authorization: `Bearer ${key}` } }),
      workerEnv,
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { actor: { kind: string; name: string } };
    expect(result.actor).toEqual({
      kind: "bearer",
      name: "integration",
      scopes: ["read", "write"],
      accountId: "default",
    });
  });

  it("rejects the same key once it is revoked", async () => {
    const workerEnv = await testEnv();
    const { token, sha256 } = await generateApiKey();
    const id = crypto.randomUUID();
    const session = getSessionStub(workerEnv);
    await session.createApiKey({ id, name: "short-lived", sha256, scopes: ["read"] });

    const allowed = await fetchThroughProvider(
      new Request(`${BASE}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } }),
      workerEnv,
    );
    expect(allowed.status).toBe(200);

    await session.revokeApiKey(id);
    const refused = await fetchThroughProvider(
      new Request(`${BASE}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } }),
      workerEnv,
    );
    expect(refused.status).toBe(401);
    expect(refused.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  });

  it("still rejects an unknown bearer token with the challenge", async () => {
    const workerEnv = await testEnv();
    const response = await fetchThroughProvider(
      new Request(`${BASE}/mcp`, { headers: { Authorization: "Bearer not-a-real-token" } }),
      workerEnv,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  });

  it("passes unprotected paths to the default handler", async () => {
    const workerEnv = await testEnv();
    const response = await fetchThroughProvider(new Request(`${BASE}/`), workerEnv);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("weworking");
  });
});
