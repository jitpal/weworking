/**
 * `WeWorkSession`: the token lifecycle — store, report, refresh, log in, coalesce.
 *
 * The WeWork auth module is mocked (`src/wework/auth`): these tests assert the Durable Object's
 * *strategy order and bookkeeping*, never Auth0 behaviour. Nothing here touches the
 * network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors";
import {
  freshSession,
  loginResult,
  patchConfig,
  rejection,
  sessionRecord,
  withHeadlessCredentials,
} from "./helpers";

const auth = vi.hoisted(() => ({
  login: vi.fn(),
  refresh: vi.fn(),
  strategyOptions: vi.fn(),
}));

vi.mock("../../src/wework/auth", () => ({
  createHeadlessLoginStrategy: (opts: unknown) => {
    auth.strategyOptions(opts);
    return { name: "headless" as const, login: auth.login };
  },
  refreshSession: auth.refresh,
}));

beforeEach(() => {
  auth.login.mockReset();
  auth.refresh.mockReset();
  auth.strategyOptions.mockReset();
});

describe("session state", () => {
  it("reports no session before anything is stored", async () => {
    const stub = freshSession("state-none");
    await expect(stub.getSessionInfo()).resolves.toEqual({
      state: "none",
      source: "none",
      hasRefreshToken: false,
    });
  });

  it("stores a manual session and reports it without leaking the token", async () => {
    const stub = freshSession("state-manual");
    await stub.setSession(sessionRecord({ accessToken: "secret-token-value", hoursLeft: 20 }));

    const info = await stub.getSessionInfo();
    expect(info).toMatchObject({ state: "valid", source: "manual", hasRefreshToken: true });
    expect(info.obtainedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(info.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(info)).not.toContain("secret-token-value");
    expect(JSON.stringify(info)).not.toContain("stored-refresh-token");
  });

  it("reports 'expiring' inside the six-hour refresh window and 'expired' after", async () => {
    const expiring = freshSession("state-expiring");
    await expiring.setSession(sessionRecord({ hoursLeft: 2 }));
    await expect(expiring.getSessionInfo()).resolves.toMatchObject({ state: "expiring" });

    const expired = freshSession("state-expired");
    await expired.setSession(sessionRecord({ hoursLeft: -1 }));
    await expect(expired.getSessionInfo()).resolves.toMatchObject({ state: "expired" });
  });

  it("clearSession forgets the record", async () => {
    const stub = freshSession("state-clear");
    await stub.setSession(sessionRecord());
    await stub.clearSession();
    await expect(stub.getSessionInfo()).resolves.toMatchObject({ state: "none" });
  });

  it("rejects a record without an access token", async () => {
    const stub = freshSession("state-invalid");
    const err = await rejection(stub.setSession(sessionRecord({ accessToken: "  " })));
    expect(err.code).toBe("VALIDATION");
  });
});

describe("getAccessToken", () => {
  it("returns the stored token without calling upstream when it is fresh enough", async () => {
    const stub = freshSession("token-fresh");
    await stub.setSession(sessionRecord({ accessToken: "live-token", hoursLeft: 5 }));

    await expect(stub.getAccessToken()).resolves.toEqual({
      accessToken: "live-token",
      userUuid: "user-uuid-1",
    });
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(auth.login).not.toHaveBeenCalled();
  });

  it("refreshes when the token has less than minTtlSec left", async () => {
    const stub = freshSession("token-minttl");
    await stub.setSession(sessionRecord({ accessToken: "nearly-dead", hoursLeft: 0.01 }));
    auth.refresh.mockResolvedValue(loginResult({ accessToken: "after-refresh" }));

    await expect(stub.getAccessToken({ minTtlSec: 120 })).resolves.toMatchObject({
      accessToken: "after-refresh",
    });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it("force bypasses a perfectly valid token", async () => {
    const stub = freshSession("token-force");
    await stub.setSession(sessionRecord({ accessToken: "still-good", hoursLeft: 20 }));
    auth.refresh.mockResolvedValue(loginResult({ accessToken: "forced-refresh" }));

    await expect(stub.getAccessToken({ force: true })).resolves.toMatchObject({
      accessToken: "forced-refresh",
    });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it("prefers the refresh token over a headless login", async () => {
    const stub = freshSession("token-prefers-refresh");
    await patchConfig(stub, withHeadlessCredentials());
    await stub.setSession(sessionRecord({ hoursLeft: -1 }));
    auth.refresh.mockResolvedValue(loginResult({ accessToken: "by-refresh", source: "refresh" }));
    auth.login.mockResolvedValue(loginResult({ accessToken: "by-login" }));

    await expect(stub.getAccessToken()).resolves.toMatchObject({ accessToken: "by-refresh" });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(auth.login).not.toHaveBeenCalled();
    await expect(stub.getSessionInfo()).resolves.toMatchObject({ source: "refresh" });
  });

  it("falls through to the headless login when the refresh token is rejected", async () => {
    const stub = freshSession("token-invalid-grant");
    await patchConfig(stub, withHeadlessCredentials());
    await stub.setSession(sessionRecord({ hoursLeft: -1 }));
    auth.refresh.mockImplementation(async () => {
      throw new AppError("UPSTREAM_AUTH", "invalid_grant: refresh token rejected");
    });
    auth.login.mockResolvedValue(loginResult({ accessToken: "after-login" }));

    await expect(stub.getAccessToken()).resolves.toMatchObject({ accessToken: "after-login" });
    expect(auth.login).toHaveBeenCalledTimes(1);
    // The successful login clears the recorded failure.
    const info = await stub.getSessionInfo();
    expect(info).toMatchObject({ state: "valid", source: "login" });
    expect(info.lastError).toBeUndefined();
  });

  it("passes the configured credentials and a fetch to the login strategy", async () => {
    const stub = freshSession("token-strategy-opts");
    await patchConfig(stub, withHeadlessCredentials());
    auth.login.mockResolvedValue(loginResult());

    await stub.getAccessToken();
    expect(auth.strategyOptions).toHaveBeenCalledTimes(1);
    const opts = auth.strategyOptions.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.username).toBe("member@example.test");
    expect(opts.password).toBe("hunter2");
    expect(typeof opts.fetch).toBe("function");
    expect(typeof opts.now).toBe("function");
  });

  it("does not attempt a login when LOGIN_STRATEGY is manual", async () => {
    const stub = freshSession("token-manual-strategy");
    await patchConfig(stub, { ...withHeadlessCredentials(), loginStrategy: "manual" });

    const err = await rejection(stub.getAccessToken());
    expect(err.code).toBe("SESSION_MISSING");
    expect(auth.login).not.toHaveBeenCalled();
  });

  it("throws SESSION_MISSING with a connect hint when nothing is stored", async () => {
    const stub = freshSession("token-missing");
    const err = await rejection(stub.getAccessToken());
    expect(err.code).toBe("SESSION_MISSING");
    expect(err.name).toBe("AppError");
    expect(err.hint).toContain("/admin/connect");
  });

  it("throws SESSION_EXPIRED when a stale record cannot be renewed", async () => {
    const stub = freshSession("token-expired");
    await stub.setSession(sessionRecord({ hoursLeft: -2, refreshToken: undefined }));

    const err = await rejection(stub.getAccessToken());
    expect(err.code).toBe("SESSION_EXPIRED");
    expect(err.hint).toContain("/admin/connect");
    await expect(stub.getSessionInfo()).resolves.toMatchObject({
      state: "expired",
      lastError:
        "SESSION_EXPIRED: The stored WeWork session has expired and cannot be renewed automatically.",
    });
  });

  it("propagates a non-auth refresh failure unchanged and never logs in", async () => {
    const stub = freshSession("token-rate-limited");
    await patchConfig(stub, withHeadlessCredentials());
    await stub.setSession(sessionRecord({ hoursLeft: -1 }));
    auth.refresh.mockImplementation(async () => {
      throw new AppError("UPSTREAM_RATE_LIMITED", "slow down");
    });

    const err = await rejection(stub.getAccessToken());
    expect(err.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(auth.login).not.toHaveBeenCalled();
    await expect(stub.getSessionInfo()).resolves.toMatchObject({
      lastError: "UPSTREAM_RATE_LIMITED: slow down",
    });
  });

  it("propagates UPSTREAM_BLOCKED from the login and records it", async () => {
    const stub = freshSession("token-blocked");
    await patchConfig(stub, withHeadlessCredentials());
    await stub.setSession(sessionRecord({ hoursLeft: -1 }));
    auth.refresh.mockImplementation(async () => {
      throw new AppError("UPSTREAM_AUTH", "invalid_grant");
    });
    auth.login.mockImplementation(async () => {
      throw new AppError("UPSTREAM_BLOCKED", "Auth0 requires verification for this login.");
    });

    const err = await rejection(stub.getAccessToken());
    expect(err.code).toBe("UPSTREAM_BLOCKED");
    expect(err.hint).toContain("/admin/connect");
    await expect(stub.getSessionInfo()).resolves.toMatchObject({
      lastError: "UPSTREAM_BLOCKED: Auth0 requires verification for this login.",
    });
  });

  it("coalesces concurrent callers onto a single login", async () => {
    const stub = freshSession("token-coalesce");
    await patchConfig(stub, withHeadlessCredentials());
    // A login that takes a moment: the second caller must join the first attempt
    // rather than starting its own.
    auth.login.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return loginResult({ accessToken: "one-login-only" });
    });

    const results = await Promise.all([stub.getAccessToken(), stub.getAccessToken()]);

    expect(results).toEqual([
      { accessToken: "one-login-only", userUuid: "user-uuid-1" },
      { accessToken: "one-login-only", userUuid: "user-uuid-1" },
    ]);
    expect(auth.login).toHaveBeenCalledTimes(1);
  });

  it("starts a new attempt after the coalesced one settles", async () => {
    const stub = freshSession("token-coalesce-reset");
    await patchConfig(stub, withHeadlessCredentials());
    auth.login.mockImplementation(async () => {
      throw new AppError("UPSTREAM_ERROR", "upstream hiccup");
    });

    await expect(rejection(stub.getAccessToken())).resolves.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    auth.login.mockResolvedValue(loginResult({ accessToken: "second-attempt" }));
    await expect(stub.getAccessToken()).resolves.toMatchObject({ accessToken: "second-attempt" });
    expect(auth.login).toHaveBeenCalledTimes(2);
  });
});
