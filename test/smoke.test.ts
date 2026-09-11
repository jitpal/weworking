/**
 * Scaffold smoke test: proves the toolchain itself works before anyone builds on it.
 *
 * It checks the three things that break first in a Workers project:
 *   1. the worker boots and `SELF.fetch` routes (Hono + the entry point);
 *   2. the Durable Object binding resolves, the SQLite migration applies, and RPC
 *      round-trips (`env.SESSION`);
 *   3. the test bindings from vitest.config.ts reach the worker.
 *
 * Keep it fast and dependency-free — module owners add their own test files.
 */

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getSessionStub, SESSION_DO_NAME } from "../src/session/do";

describe("worker front door", () => {
  it("serves GET /healthz", async () => {
    const response = await SELF.fetch("http://x/healthz");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, version: "0.1.0" });
  });

  it("returns a structured 404 for unknown routes", async () => {
    const response = await SELF.fetch("http://x/nope");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; hint?: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.hint).toBeTypeOf("string");
  });
});

describe("WeWorkSession durable object", () => {
  it("resolves the binding and answers a ping over RPC", async () => {
    const stub = env.SESSION.get(env.SESSION.idFromName(SESSION_DO_NAME));
    const result = await stub.ping();
    expect(result.ok).toBe(true);
    expect(result.now).toBeGreaterThan(0);
  });

  it("getSessionStub() returns the same single instance", async () => {
    const direct = env.SESSION.idFromName(SESSION_DO_NAME);
    const viaHelper = getSessionStub(env);
    expect(viaHelper.id.toString()).toBe(direct.toString());
    await expect(viaHelper.ping()).resolves.toMatchObject({ ok: true });
  });
});

describe("test environment", () => {
  it("receives the deterministic bindings from vitest.config.ts", () => {
    expect(env.WRITE_ENABLED).toBe("true");
    expect(env.QUOTE_SIGNING_KEY).toHaveLength(64);
    expect(env.LOGIN_STRATEGY).toBe("manual");
  });
});
