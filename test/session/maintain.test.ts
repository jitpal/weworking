/**
 * `WeWorkSession.maintain()` — the daily cron pass.
 *
 * Two jobs: keep the token alive while the user is away (refresh inside the six-hour
 * window), and keep the SQLite tables from growing without bound. A failed refresh
 * must never stop the prune and must never throw out of the cron handler.
 *
 * Old rows are produced by winding the object's clock back with `setClock()` and
 * calling the ordinary RPC methods — the same path production takes — then winding it
 * forward again, so no test-only insert API is needed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors";
import { AUDIT_RETENTION_MS, STALE_RESERVATION_MS } from "../../src/session/do";
import {
  freshSession,
  loginResult,
  queryCount,
  resetClock,
  sessionRecord,
  setClock,
} from "./helpers";

const auth = vi.hoisted(() => ({ login: vi.fn(), refresh: vi.fn() }));

vi.mock("../../src/wework/auth", () => ({
  createHeadlessLoginStrategy: () => ({ name: "headless" as const, login: auth.login }),
  refreshSession: auth.refresh,
}));

beforeEach(() => {
  auth.login.mockReset();
  auth.refresh.mockReset();
});

describe("maintain — refresh", () => {
  it("refreshes a token that expires inside the six-hour window", async () => {
    const stub = freshSession("maintain-refresh");
    await stub.setSession(sessionRecord({ accessToken: "about-to-die", hoursLeft: 3 }));
    auth.refresh.mockResolvedValue(
      loginResult({ accessToken: "renewed", source: "refresh", expiresAt: Date.now() + 8.64e7 }),
    );

    const summary = await stub.maintain();
    expect(summary.refreshed).toBe(true);
    expect(summary.error).toBeUndefined();
    expect(summary.session).toMatchObject({ state: "valid", source: "refresh" });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(summary)).not.toContain("renewed");
  });

  it("leaves a healthy token alone", async () => {
    const stub = freshSession("maintain-healthy");
    await stub.setSession(sessionRecord({ hoursLeft: 30 }));

    await expect(stub.maintain()).resolves.toMatchObject({ refreshed: false });
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it("does nothing when there is no session at all", async () => {
    const stub = freshSession("maintain-empty");
    await expect(stub.maintain()).resolves.toEqual({
      refreshed: false,
      pruned: 0,
      session: { state: "none", source: "none", hasRefreshToken: false },
    });
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it("skips a session that has no refresh token", async () => {
    const stub = freshSession("maintain-no-refresh-token");
    await stub.setSession(sessionRecord({ hoursLeft: 1, refreshToken: undefined }));
    await expect(stub.maintain()).resolves.toMatchObject({ refreshed: false });
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it("swallows a refresh failure, records it, and still prunes", async () => {
    const stub = freshSession("maintain-refresh-fails");
    const start = Date.now();
    await stub.setSession(sessionRecord({ hoursLeft: 2 }));
    auth.refresh.mockImplementation(async () => {
      throw new AppError("UPSTREAM_AUTH", "invalid_grant");
    });

    await setClock(stub, start - 2 * 3_600_000);
    await stub.idempotencyPut("stale", { ok: true }, 60);
    await resetClock(stub);

    const summary = await stub.maintain();
    expect(summary).toMatchObject({ refreshed: false, pruned: 1 });
    expect(summary.error).toBe("UPSTREAM_AUTH: invalid_grant");
    await expect(stub.getSessionInfo()).resolves.toMatchObject({
      lastError: "UPSTREAM_AUTH: invalid_grant",
    });
  });
});

describe("maintain — pruning", () => {
  it("prunes expired idempotency rows, old audit rows and abandoned reservations", async () => {
    const stub = freshSession("maintain-prune");
    const now = Date.now();

    // Wind the clock back and use the ordinary RPCs to create genuinely old rows.
    await setClock(stub, now - AUDIT_RETENTION_MS - 86_400_000);
    await stub.audit({ actor: "a", tool: "search_availability", args: {}, outcome: "ok" });
    await stub.idempotencyPut("ancient", { ok: true }, 3_600);
    await stub.reserveBooking({
      bookingKey: "abandoned",
      date: "2026-09-07",
      credits: 1,
      actor: "a",
      dryRun: false,
    });

    // …and something recent, which must survive.
    await setClock(stub, now);
    await stub.audit({ actor: "a", tool: "whoami", args: {}, outcome: "ok" });
    await stub.idempotencyPut("recent", { ok: true });
    await stub.reserveBooking({
      bookingKey: "live",
      date: "2026-09-08",
      credits: 1,
      actor: "a",
      dryRun: false,
    });

    const summary = await stub.maintain();
    expect(summary.pruned).toBe(3);
    await expect(stub.listAudit()).resolves.toMatchObject([{ tool: "whoami" }]);
    await expect(stub.idempotencyGet("ancient")).resolves.toBeUndefined();
    await expect(stub.idempotencyGet("recent")).resolves.toEqual({ ok: true });
    await expect(
      queryCount(stub, "SELECT COUNT(*) AS n FROM bookings_ledger WHERE booking_key = ?", "live"),
    ).resolves.toBe(1);
    await expect(
      queryCount(
        stub,
        "SELECT COUNT(*) AS n FROM bookings_ledger WHERE booking_key = ?",
        "abandoned",
      ),
    ).resolves.toBe(0);
  });

  it("keeps a confirmed booking no matter how old it is", async () => {
    const stub = freshSession("maintain-keep-confirmed");
    const now = Date.now();
    await setClock(stub, now - STALE_RESERVATION_MS * 100);
    await stub.reserveBooking({
      bookingKey: "old-but-real",
      date: "2026-09-07",
      credits: 1,
      actor: "a",
      dryRun: false,
    });
    await stub.confirmBooking({ bookingKey: "old-but-real", bookingId: "WW-7" });

    await setClock(stub, now);
    await expect(stub.maintain()).resolves.toMatchObject({ pruned: 0 });
    await expect(
      queryCount(stub, "SELECT COUNT(*) AS n FROM bookings_ledger WHERE status = 'confirmed'"),
    ).resolves.toBe(1);
  });

  it("reports nothing to prune on a clean object", async () => {
    const stub = freshSession("maintain-nothing");
    await expect(stub.maintain()).resolves.toMatchObject({ pruned: 0 });
  });
});
