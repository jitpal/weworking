/**
 * Actor resolution, scope enforcement and the 401 challenge.
 *
 * `resolveActor` has to behave identically whether it is called from inside the
 * OAuth provider's `apiHandler` (props already decrypted) or from middleware on a
 * raw request, because `src/index.ts` may do either.
 *
 * The Durable Object is a fake `SESSION` binding: `getSessionStub()` only calls
 * `idFromName()` and `get()`, so a plain object is enough to pin down what the guard
 * does with a match, a miss and a failure.
 */

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  actorMiddleware,
  baseUrlFrom,
  bearerToken,
  hasScope,
  isOAuthActorProps,
  matchApiKey,
  propsFromContext,
  requireScope,
  resolveActor,
  unauthorizedResponse,
} from "../../src/auth/guard";
import { sha256Hex } from "../../src/auth/tokens";
import type { Actor, Scope } from "../../src/core/types";
import type { Env } from "../../src/env";
import { isAppError } from "../../src/errors";
import type { ApiKeyMatch } from "../../src/session/do";

/** A key shaped like the real thing; only its digest ever reaches the fake stub. */
const TOKEN = "ww_Ux3Wm7Kd0pQvRt5YbN2cLh8ZfA1sJe4GiOu6VnT9xMk";

type MatchResult = ApiKeyMatch | undefined;

/** An `Env` whose session Durable Object answers `matchApiKey` with `result`. */
function envWithKey(result: MatchResult | (() => MatchResult), matchApiKeySpy = vi.fn()): Env {
  const stub = {
    matchApiKey: async (digest: string) => {
      matchApiKeySpy(digest);
      return typeof result === "function" ? result() : result;
    },
  };
  return {
    SESSION: { idFromName: (name: string) => name, get: () => stub },
  } as unknown as Env;
}

/** The match a live `read`+`write` key produces. */
function liveKey(scopes: Scope[] = ["read", "write"]): ApiKeyMatch {
  return { id: "key-1", name: "claude-code", scopes };
}

async function envWithToken(scopes: Scope[] = ["read", "write"]): Promise<Env> {
  return envWithKey(liveKey(scopes));
}

function request(
  headers: Record<string, string> = {},
  url = "https://worker.example/mcp",
): Request {
  return new Request(url, { headers });
}

function actor(scopes: Actor["scopes"]): Actor {
  return { kind: "bearer", name: "t", scopes, accountId: "default" };
}

describe("bearerToken", () => {
  it("reads the token case-insensitively and ignores anything else", () => {
    expect(bearerToken(request({ Authorization: "Bearer abc" }))).toBe("abc");
    expect(bearerToken(request({ Authorization: "bearer   abc  " }))).toBe("abc");
    expect(bearerToken(request({ Authorization: "Basic abc" }))).toBeNull();
    expect(bearerToken(request({ Authorization: "Bearer" }))).toBeNull();
    expect(bearerToken(request())).toBeNull();
  });
});

describe("isOAuthActorProps", () => {
  it("accepts the shape completeAuthorization stores", () => {
    expect(isOAuthActorProps({ name: "claude.ai", scopes: ["read"] })).toBe(true);
    expect(isOAuthActorProps({ name: "x", scopes: ["read"], accountId: "default" })).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isOAuthActorProps(undefined)).toBe(false);
    expect(isOAuthActorProps({})).toBe(false);
    expect(isOAuthActorProps({ name: "", scopes: ["read"] })).toBe(false);
    expect(isOAuthActorProps({ name: "x", scopes: [] })).toBe(false);
    expect(isOAuthActorProps({ name: "x", scopes: ["root"] })).toBe(false);
    expect(isOAuthActorProps({ name: "x", scopes: ["read"], accountId: 7 })).toBe(false);
  });
});

describe("resolveActor", () => {
  it("prefers valid OAuth props and defaults the accountId", async () => {
    const env = await envWithToken();
    await expect(
      resolveActor(request(), env, { name: "claude.ai", scopes: ["read", "write"] }),
    ).resolves.toEqual({
      kind: "oauth",
      name: "claude.ai",
      scopes: ["read", "write"],
      accountId: "default",
    });
  });

  it("keeps the kind from props when the provider validated an API key", async () => {
    const env = await envWithToken();
    await expect(
      resolveActor(request(), env, {
        kind: "bearer",
        name: "claude-code",
        scopes: ["read"],
        accountId: "default",
      }),
    ).resolves.toMatchObject({ kind: "bearer", name: "claude-code" });
  });

  it("falls back to the Authorization header when props are absent or malformed", async () => {
    const env = await envWithToken();
    const req = request({ Authorization: `Bearer ${TOKEN}` });
    await expect(resolveActor(req, env)).resolves.toMatchObject({
      kind: "bearer",
      name: "claude-code",
      scopes: ["read", "write"],
    });
    await expect(resolveActor(req, env, { scopes: [] })).resolves.toMatchObject({ kind: "bearer" });
  });

  it("returns null with no credential and for a key the Durable Object does not know", async () => {
    await expect(resolveActor(request(), await envWithToken())).resolves.toBeNull();
    await expect(
      resolveActor(request({ Authorization: `Bearer ${TOKEN}` }), envWithKey(undefined)),
    ).resolves.toBeNull();
  });
});

describe("matchApiKey", () => {
  it("gives the key's own scopes to the actor", async () => {
    await expect(matchApiKey(envWithKey(liveKey(["read"])), TOKEN)).resolves.toEqual({
      kind: "bearer",
      name: "claude-code",
      scopes: ["read"],
      accountId: "default",
    });
    await expect(matchApiKey(envWithKey(liveKey(["admin"])), TOKEN)).resolves.toMatchObject({
      scopes: ["admin"],
    });
  });

  it("looks the key up by SHA-256, never by its plaintext", async () => {
    const spy = vi.fn();
    await matchApiKey(envWithKey(liveKey(), spy), TOKEN);
    expect(spy).toHaveBeenCalledWith(await sha256Hex(TOKEN));
    expect(spy).not.toHaveBeenCalledWith(TOKEN);
  });

  it("returns null for a revoked key (the Durable Object stops matching it)", async () => {
    await expect(matchApiKey(envWithKey(undefined), TOKEN)).resolves.toBeNull();
  });

  it("treats a Durable Object failure as no match rather than an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = envWithKey(() => {
      throw new Error("session store unreachable");
    });
    await expect(matchApiKey(env, TOKEN)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    warn.mockRestore();
  });

  it("skips the Durable Object entirely for anything without the ww_ prefix", async () => {
    const spy = vi.fn();
    const env = envWithKey(liveKey(), spy);
    await expect(matchApiKey(env, "an-oauth-access-token")).resolves.toBeNull();
    await expect(matchApiKey(env, "ww_")).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("requireScope", () => {
  it("passes when the scope is held", () => {
    expect(() => requireScope(actor(["read"]), "read")).not.toThrow();
    expect(() => requireScope(actor(["read", "write"]), "write")).not.toThrow();
  });

  it("treats admin as a superset", () => {
    expect(hasScope(actor(["admin"]), "read")).toBe(true);
    expect(hasScope(actor(["admin"]), "write")).toBe(true);
    expect(() => requireScope(actor(["admin"]), "write")).not.toThrow();
  });

  it("does not let write imply read (scopes are explicit)", () => {
    expect(hasScope(actor(["write"]), "read")).toBe(false);
  });

  it("throws FORBIDDEN_SCOPE naming the missing scope", () => {
    try {
      requireScope(actor(["read"]), "write");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.code).toBe("FORBIDDEN_SCOPE");
      expect(error.status).toBe(403);
      expect(error.message).toContain("write");
      expect(error.hint).toBeTypeOf("string");
    }
  });
});

describe("unauthorizedResponse", () => {
  it("is a 401 JSON body with the resource_metadata challenge", async () => {
    const response = unauthorizedResponse("https://desk.example.com");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="OAuth", resource_metadata="https://desk.example.com/.well-known/oauth-protected-resource"',
    );
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = (await response.json()) as { error: { code: string; hint?: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.hint).toBeTypeOf("string");
  });

  it("does not double up the slash when the base URL has a trailing one", () => {
    const header = unauthorizedResponse("https://x.example/").headers.get("WWW-Authenticate");
    expect(header).toContain('"https://x.example/.well-known/oauth-protected-resource"');
  });
});

describe("baseUrlFrom", () => {
  it("honours PUBLIC_BASE_URL", () => {
    const env = { PUBLIC_BASE_URL: "https://desk.example.com/ignored/path" } as unknown as Env;
    expect(baseUrlFrom(request({}, "https://worker.workers.dev/mcp"), env)).toBe(
      "https://desk.example.com",
    );
  });

  it("falls back to the request origin when unset or unparseable", () => {
    expect(baseUrlFrom(request({}, "https://worker.workers.dev/mcp"), {} as Env)).toBe(
      "https://worker.workers.dev",
    );
    expect(
      baseUrlFrom(request({}, "https://worker.workers.dev/mcp"), {
        PUBLIC_BASE_URL: "not a url",
      } as unknown as Env),
    ).toBe("https://worker.workers.dev");
  });
});

describe("actorMiddleware", () => {
  it("sets the actor from an API key and lets the route run", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { actor?: Actor } }>();
    app.use("/mcp", actorMiddleware());
    app.get("/mcp", (c) => c.json({ actor: c.get("actor") }));
    const response = await app.request(
      "/mcp",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      await envWithToken(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { actor: Actor };
    expect(body.actor).toMatchObject({ kind: "bearer", name: "claude-code" });
  });

  it("answers 401 with the challenge when no credential is presented", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { actor?: Actor } }>();
    app.use("/mcp", actorMiddleware());
    app.get("/mcp", (c) => c.json({ ok: true }));
    const response = await app.request("/mcp", {}, await envWithToken());
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  });

  it("reads props off an execution context without assuming it has any", () => {
    expect(propsFromContext({ props: { name: "x" } })).toEqual({ name: "x" });
    expect(propsFromContext({})).toBeUndefined();
    expect(propsFromContext(undefined)).toBeUndefined();
  });
});
