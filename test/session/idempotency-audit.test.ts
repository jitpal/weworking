/**
 * `WeWorkSession`: the idempotency table and the audit log.
 *
 * Two invariants are load-bearing here:
 *   - a replayed `create_booking` finds its stored result instead of booking twice,
 *     and the record disappears once its TTL passes;
 *   - nothing credential-shaped ever reaches the audit log, whatever key it arrived
 *     under. `redact()` only knows key names, so the Durable Object also scrubs by
 *     shape before persisting.
 */

import { describe, expect, it, vi } from "vitest";
import { freshSession, queryCount, rejection, setClock } from "./helpers";

vi.mock("../../src/wework/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/wework/auth")>()),
  createHeadlessLoginStrategy: () => ({
    name: "headless" as const,
    login: () => Promise.reject(new Error("no login in audit tests")),
  }),
  refreshSession: () => Promise.reject(new Error("no refresh in audit tests")),
}));

/** A JWT-shaped string: three base64url segments. Must never survive the audit log. */
const JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdXRoMHwxMjMiLCJleHAiOjE5MDAwMDAwMDB9.c2lnbmF0dXJlLXRoYXQtbG9va3MtcmVhbC1lbm91Z2g";

describe("idempotency", () => {
  it("round-trips a JSON result", async () => {
    const stub = freshSession("idem-roundtrip");
    await stub.idempotencyPut("booking:abc", { bookingId: "WW-1", credits: 4, dryRun: false });
    await expect(stub.idempotencyGet("booking:abc")).resolves.toEqual({
      bookingId: "WW-1",
      credits: 4,
      dryRun: false,
    });
  });

  it("returns undefined for an unknown key", async () => {
    const stub = freshSession("idem-unknown");
    await expect(stub.idempotencyGet("nope")).resolves.toBeUndefined();
  });

  it("overwrites the stored value for the same key", async () => {
    const stub = freshSession("idem-overwrite");
    await stub.idempotencyPut("k", { attempt: 1 });
    await stub.idempotencyPut("k", { attempt: 2 });
    await expect(stub.idempotencyGet("k")).resolves.toEqual({ attempt: 2 });
    await expect(queryCount(stub, "SELECT COUNT(*) AS n FROM idempotency")).resolves.toBe(1);
  });

  it("expires a record once its TTL passes, and drops the row", async () => {
    const stub = freshSession("idem-ttl");
    const start = Date.now();
    await setClock(stub, start);
    await stub.idempotencyPut("short", { ok: true }, 60);

    await setClock(stub, start + 59_000);
    await expect(stub.idempotencyGet("short")).resolves.toEqual({ ok: true });

    await setClock(stub, start + 61_000);
    await expect(stub.idempotencyGet("short")).resolves.toBeUndefined();
    await expect(queryCount(stub, "SELECT COUNT(*) AS n FROM idempotency")).resolves.toBe(0);
  });

  it("defaults to a 24-hour TTL", async () => {
    const stub = freshSession("idem-default-ttl");
    const start = Date.now();
    await setClock(stub, start);
    await stub.idempotencyPut("day", { ok: true });

    await setClock(stub, start + 23 * 3_600_000);
    await expect(stub.idempotencyGet("day")).resolves.toEqual({ ok: true });
    await setClock(stub, start + 25 * 3_600_000);
    await expect(stub.idempotencyGet("day")).resolves.toBeUndefined();
  });

  it("rejects an empty key", async () => {
    const stub = freshSession("idem-empty-key");
    await expect(rejection(stub.idempotencyPut("", { a: 1 }))).resolves.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("audit", () => {
  it("stores an entry and reads it back", async () => {
    const stub = freshSession("audit-basic");
    await stub.audit({
      actor: "claude-code",
      tool: "create_booking",
      args: { date: "2026-09-07", locationId: "loc-1" },
      outcome: "ok",
      bookingId: "WW-1",
      credits: 4,
      dryRun: false,
    });

    const [entry] = await stub.listAudit();
    expect(entry).toMatchObject({
      id: 1,
      actor: "claude-code",
      tool: "create_booking",
      args: { date: "2026-09-07", locationId: "loc-1" },
      outcome: "ok",
      bookingId: "WW-1",
      credits: 4,
      dryRun: false,
    });
    expect(entry?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry?.error).toBeUndefined();
  });

  it("redacts credentials by key and by shape", async () => {
    const stub = freshSession("audit-redaction");
    await stub.audit({
      actor: "admin",
      tool: "set_session",
      args: {
        accessToken: "by-key-access-token",
        password: "by-key-password",
        // Sensible-looking keys that `redact()` cannot know about:
        session: JWT,
        pasted: { value: JWT },
        note: "Desk for Tuesday, please",
      },
      outcome: "ok",
    });

    const entries = await stub.listAudit();
    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain("by-key-access-token");
    expect(serialised).not.toContain("by-key-password");
    expect(serialised).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(serialised).not.toContain(JWT.slice(0, 40));
    // …while ordinary arguments survive, or the log would be useless.
    expect(serialised).toContain("Desk for Tuesday, please");
    expect(entries[0]?.args).toMatchObject({
      accessToken: "[redacted]",
      password: "[redacted]",
      session: "[redacted]",
      pasted: { value: "[redacted]" },
    });
  });

  it("keeps the raw token out of SQLite itself, not just the RPC result", async () => {
    const stub = freshSession("audit-storage");
    await stub.audit({ actor: "admin", tool: "set_session", args: { blob: JWT }, outcome: "ok" });
    await expect(
      queryCount(stub, "SELECT COUNT(*) AS n FROM audit WHERE args_redacted LIKE ?", "%eyJ%"),
    ).resolves.toBe(0);
  });

  it("records failures with their reason", async () => {
    const stub = freshSession("audit-error");
    await stub.audit({
      actor: "claude-code",
      tool: "cancel_booking",
      args: { bookingId: "WW-2" },
      outcome: "error",
      error: "UPSTREAM_ERROR: WeWork returned 500",
    });
    await expect(stub.listAudit()).resolves.toMatchObject([
      { outcome: "error", error: "UPSTREAM_ERROR: WeWork returned 500", dryRun: false },
    ]);
  });

  it("returns the newest entries first and honours the limit", async () => {
    const stub = freshSession("audit-order");
    for (const tool of ["first", "second", "third"]) {
      await stub.audit({ actor: "a", tool, args: {}, outcome: "ok" });
    }
    await expect(stub.listAudit()).resolves.toMatchObject([
      { tool: "third" },
      { tool: "second" },
      { tool: "first" },
    ]);
    const limited = await stub.listAudit({ limit: 2 });
    expect(limited.map((e) => e.tool)).toEqual(["third", "second"]);
  });

  it("handles entries with no arguments", async () => {
    const stub = freshSession("audit-no-args");
    await stub.audit({ actor: "a", tool: "whoami", args: undefined, outcome: "ok" });
    const [entry] = await stub.listAudit();
    expect(entry?.args).toBeUndefined();
  });
});
