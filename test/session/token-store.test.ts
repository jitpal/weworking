/**
 * The worker-side adapters: `DurableTokenStore` and the cron entry point.
 *
 * `DurableTokenStore` is deliberately dumb — its whole job is to translate the
 * `TokenStore` interface (`forceRefresh`, `clear`) into the Durable Object's RPC
 * vocabulary (`force`, `clearSession`). These tests pin that translation, because the
 * `WeWorkClient` relies on `forceRefresh` actually forcing a refresh after a 401.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduled } from "../../src/session/cron";
import { getSessionStub } from "../../src/session/do";
import { DurableTokenStore, MemoryTokenStore } from "../../src/session/token-store";
import { freshSession, loginResult, sessionRecord, testEnv } from "./helpers";

const auth = vi.hoisted(() => ({ login: vi.fn(), refresh: vi.fn() }));

vi.mock("../../src/wework/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/wework/auth")>()),
  createHeadlessLoginStrategy: () => ({ name: "headless" as const, login: auth.login }),
  refreshSession: auth.refresh,
}));

beforeEach(() => {
  auth.login.mockReset();
  auth.refresh.mockReset();
});

describe("DurableTokenStore", () => {
  it("forwards setSession, getAccessToken and getSessionInfo", async () => {
    const stub = freshSession("store-forward");
    const store = new DurableTokenStore(stub);

    await store.setSession(sessionRecord({ accessToken: "via-store", hoursLeft: 12 }));
    await expect(store.getAccessToken()).resolves.toEqual({
      accessToken: "via-store",
      userUuid: "user-uuid-1",
    });
    await expect(store.getSessionInfo()).resolves.toMatchObject({
      state: "valid",
      source: "manual",
      hasRefreshToken: true,
    });
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it("maps forceRefresh to the Durable Object's force flag", async () => {
    const stub = freshSession("store-force");
    const store = new DurableTokenStore(stub);
    await store.setSession(sessionRecord({ accessToken: "stale-but-valid", hoursLeft: 12 }));
    auth.refresh.mockResolvedValue(loginResult({ accessToken: "after-401", source: "refresh" }));

    await expect(store.getAccessToken({ forceRefresh: true })).resolves.toMatchObject({
      accessToken: "after-401",
    });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it("maps clear() to clearSession()", async () => {
    const stub = freshSession("store-clear");
    const store = new DurableTokenStore(stub);
    await store.setSession(sessionRecord());
    await store.clear();
    await expect(store.getSessionInfo()).resolves.toMatchObject({ state: "none" });
  });

  it("reports the same states as MemoryTokenStore for the same record", async () => {
    const record = sessionRecord({ hoursLeft: 2 });
    const memory = new MemoryTokenStore(record);
    const stub = freshSession("store-parity");
    const durable = new DurableTokenStore(stub);
    await durable.setSession(record);

    const [a, b] = await Promise.all([memory.getSessionInfo(), durable.getSessionInfo()]);
    expect(b.state).toBe(a.state);
    expect(b.source).toBe(a.source);
    expect(b.hasRefreshToken).toBe(a.hasRefreshToken);
  });
});

describe("runScheduled", () => {
  it("runs maintenance on the default session object and logs a redacted summary", async () => {
    const stub = getSessionStub(testEnv);
    await stub.setSession(sessionRecord({ accessToken: "cron-secret-token", hoursLeft: 3 }));
    auth.refresh.mockResolvedValue(
      loginResult({ accessToken: "cron-renewed-token", source: "refresh" }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runScheduled(testEnv);

    expect(auth.refresh).toHaveBeenCalledTimes(1);
    const line = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(line).toContain("session:maintain");
    expect(line).toContain('"renewed":true');
    expect(line).toContain('"state":"valid"');
    expect(line).not.toContain("cron-secret-token");
    expect(line).not.toContain("cron-renewed-token");
    log.mockRestore();
  });

  it("never throws when maintenance fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // A binding with no Durable Object namespace: getSessionStub() itself blows up.
    const broken = { ...env, SESSION: undefined } as unknown as typeof testEnv;

    await expect(runScheduled(broken)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    log.mockRestore();
    error.mockRestore();
  });
});
