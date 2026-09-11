/**
 * `WeWorkSession`: the booking ledger and the caps it enforces.
 *
 * The caps are the safety net that makes this deployment harmless to an agent that
 * loops: every booking passes through `reserveBooking()` first, and only confirmed or
 * freshly-reserved non-dry-run rows count. The pool's bindings give the defaults
 * `MAX_BOOKINGS_PER_DAY=1`, `MAX_BOOKINGS_PER_WEEK=5`, `MAX_CREDITS_PER_BOOKING=0`
 * (unlimited); tests that need other limits patch the config seam.
 */

import { describe, expect, it, vi } from "vitest";
import { isoWeekKey, STALE_RESERVATION_MS } from "../../src/session/do";
import { freshSession, patchConfig, queryCount, rejection, setClock } from "./helpers";

vi.mock("../../src/wework/auth", () => ({
  createHeadlessLoginStrategy: () => ({
    name: "headless" as const,
    login: () => Promise.reject(new Error("no login in ledger tests")),
  }),
  refreshSession: () => Promise.reject(new Error("no refresh in ledger tests")),
}));

/** Monday, Tuesday, Wednesday, Sunday of the same ISO week, then the next Monday. */
const MON = "2026-09-07";
const TUE = "2026-09-08";
const WED = "2026-09-09";
const SUN = "2026-09-13";
const NEXT_MON = "2026-09-14";

describe("isoWeekKey", () => {
  it("groups Monday to Sunday into one key", () => {
    expect(isoWeekKey(MON)).toBe(isoWeekKey(SUN));
    expect(isoWeekKey(MON)).toBe("2026-W37");
    expect(isoWeekKey(NEXT_MON)).toBe("2026-W38");
  });

  it("follows the ISO year at the turn of the year", () => {
    // 2026-01-01 is a Thursday, so it belongs to 2026-W01…
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01");
    // …and the Sunday before it belongs to the last week of 2025.
    expect(isoWeekKey("2025-12-28")).toBe("2025-W52");
    expect(isoWeekKey("2025-12-29")).toBe("2026-W01");
  });

  it("rejects anything that is not a calendar date", async () => {
    const stub = freshSession("caps-bad-date");
    const err = await rejection(stub.capsRemaining("next tuesday"));
    expect(err.code).toBe("VALIDATION");
  });
});

describe("reserveBooking — day cap", () => {
  it("reserves the first booking of the day and reports what is left", async () => {
    const stub = freshSession("caps-day-first");
    const result = await stub.reserveBooking({
      bookingKey: "key-1",
      date: MON,
      credits: 4,
      actor: "claude-code",
      dryRun: false,
    });
    expect(result).toEqual({ ok: true, capsRemaining: { day: 0, week: 4 } });
    await expect(stub.capsRemaining(MON)).resolves.toEqual({ day: 0, week: 4 });
  });

  it("refuses a second booking on the same day", async () => {
    const stub = freshSession("caps-day-second");
    await stub.reserveBooking({
      bookingKey: "key-1",
      date: MON,
      credits: 4,
      actor: "a",
      dryRun: false,
    });
    const result = await stub.reserveBooking({
      bookingKey: "key-2",
      date: MON,
      credits: 4,
      actor: "a",
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("CAP_EXCEEDED");
    expect(result.message).toContain("MAX_BOOKINGS_PER_DAY=1");
    expect(result.capsRemaining).toEqual({ day: 0, week: 4 });
    // Nothing was written for the refused attempt.
    await expect(queryCount(stub, "SELECT COUNT(*) AS n FROM bookings_ledger")).resolves.toBe(1);
  });

  it("lets the same bookingKey re-reserve (a retried create_booking)", async () => {
    const stub = freshSession("caps-day-retry");
    const args = { bookingKey: "key-1", date: MON, credits: 4, actor: "a", dryRun: false };
    await expect(stub.reserveBooking(args)).resolves.toMatchObject({ ok: true });
    await expect(stub.reserveBooking(args)).resolves.toMatchObject({ ok: true });
    await expect(queryCount(stub, "SELECT COUNT(*) AS n FROM bookings_ledger")).resolves.toBe(1);
  });

  it("counts each day separately", async () => {
    const stub = freshSession("caps-day-separate");
    await stub.reserveBooking({
      bookingKey: "k1",
      date: MON,
      credits: 1,
      actor: "a",
      dryRun: false,
    });
    await expect(
      stub.reserveBooking({ bookingKey: "k2", date: TUE, credits: 1, actor: "a", dryRun: false }),
    ).resolves.toMatchObject({ ok: true, capsRemaining: { day: 0, week: 3 } });
  });
});

describe("reserveBooking — week cap", () => {
  it("refuses once the ISO week is full, and frees up on the next Monday", async () => {
    const stub = freshSession("caps-week");
    await patchConfig(stub, { maxBookingsPerDay: 5, maxBookingsPerWeek: 2 });

    await expect(
      stub.reserveBooking({ bookingKey: "k1", date: MON, credits: 1, actor: "a", dryRun: false }),
    ).resolves.toMatchObject({ ok: true, capsRemaining: { day: 4, week: 1 } });
    await expect(
      stub.reserveBooking({ bookingKey: "k2", date: SUN, credits: 1, actor: "a", dryRun: false }),
    ).resolves.toMatchObject({ ok: true, capsRemaining: { week: 0 } });

    const refused = await stub.reserveBooking({
      bookingKey: "k3",
      date: WED,
      credits: 1,
      actor: "a",
      dryRun: false,
    });
    expect(refused).toMatchObject({
      ok: false,
      code: "CAP_EXCEEDED",
      capsRemaining: { week: 0 },
    });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.message).toContain("2026-W37");

    await expect(
      stub.reserveBooking({
        bookingKey: "k4",
        date: NEXT_MON,
        credits: 1,
        actor: "a",
        dryRun: false,
      }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("reserveBooking — credits cap", () => {
  it("treats MAX_CREDITS_PER_BOOKING=0 as unlimited", async () => {
    const stub = freshSession("caps-credits-unlimited");
    await expect(
      stub.reserveBooking({
        bookingKey: "k1",
        date: MON,
        credits: 9_999,
        actor: "a",
        dryRun: false,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("refuses a booking over the per-booking credit limit", async () => {
    const stub = freshSession("caps-credits-limit");
    await patchConfig(stub, { maxCreditsPerBooking: 10 });

    await expect(
      stub.reserveBooking({ bookingKey: "k1", date: MON, credits: 10, actor: "a", dryRun: false }),
    ).resolves.toMatchObject({ ok: true });

    const refused = await stub.reserveBooking({
      bookingKey: "k2",
      date: TUE,
      credits: 11,
      actor: "a",
      dryRun: false,
    });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.code).toBe("CAP_EXCEEDED");
    expect(refused.message).toContain("MAX_CREDITS_PER_BOOKING is 10");
  });
});

describe("reserveBooking — dry runs", () => {
  it("records dry runs but never counts them towards a cap", async () => {
    const stub = freshSession("caps-dry-run");
    await expect(
      stub.reserveBooking({ bookingKey: "dry-1", date: MON, credits: 3, actor: "a", dryRun: true }),
    ).resolves.toEqual({ ok: true, capsRemaining: { day: 1, week: 5 } });

    // The row exists…
    await expect(
      queryCount(stub, "SELECT COUNT(*) AS n FROM bookings_ledger WHERE dry_run = 1"),
    ).resolves.toBe(1);
    // …and a real booking on the same day is still allowed.
    await expect(
      stub.reserveBooking({
        bookingKey: "real-1",
        date: MON,
        credits: 3,
        actor: "a",
        dryRun: false,
      }),
    ).resolves.toEqual({ ok: true, capsRemaining: { day: 0, week: 4 } });
  });

  it("still reports CAP_EXCEEDED for a dry run that would not fit", async () => {
    const stub = freshSession("caps-dry-run-refused");
    await stub.reserveBooking({
      bookingKey: "real-1",
      date: MON,
      credits: 1,
      actor: "a",
      dryRun: false,
    });
    await expect(
      stub.reserveBooking({ bookingKey: "dry-1", date: MON, credits: 1, actor: "a", dryRun: true }),
    ).resolves.toMatchObject({ ok: false, code: "CAP_EXCEEDED" });
  });
});

describe("ledger transitions", () => {
  it("confirmBooking records the upstream id and keeps the slot used", async () => {
    const stub = freshSession("ledger-confirm");
    await stub.reserveBooking({
      bookingKey: "key-1",
      date: MON,
      credits: 2,
      actor: "a",
      dryRun: false,
    });
    await stub.confirmBooking({ bookingKey: "key-1", bookingId: "WW-123" });

    await expect(
      queryCount(
        stub,
        "SELECT COUNT(*) AS n FROM bookings_ledger WHERE status = 'confirmed' AND booking_id = ?",
        "WW-123",
      ),
    ).resolves.toBe(1);
    await expect(stub.capsRemaining(MON)).resolves.toEqual({ day: 0, week: 4 });
  });

  it("releaseBooking frees the slot when the upstream booking fails", async () => {
    const stub = freshSession("ledger-release");
    await stub.reserveBooking({
      bookingKey: "key-1",
      date: MON,
      credits: 2,
      actor: "a",
      dryRun: false,
    });
    await stub.releaseBooking({ bookingKey: "key-1" });

    await expect(stub.capsRemaining(MON)).resolves.toEqual({ day: 1, week: 5 });
    await expect(queryCount(stub, "SELECT COUNT(*) AS n FROM bookings_ledger")).resolves.toBe(0);
  });

  it("releaseBooking leaves a confirmed booking alone", async () => {
    const stub = freshSession("ledger-release-confirmed");
    await stub.reserveBooking({
      bookingKey: "key-1",
      date: MON,
      credits: 2,
      actor: "a",
      dryRun: false,
    });
    await stub.confirmBooking({ bookingKey: "key-1", bookingId: "WW-123" });
    await stub.releaseBooking({ bookingKey: "key-1" });
    await expect(stub.capsRemaining(MON)).resolves.toEqual({ day: 0, week: 4 });
  });

  it("cancelLedger frees the day again", async () => {
    const stub = freshSession("ledger-cancel");
    await stub.reserveBooking({
      bookingKey: "key-1",
      date: MON,
      credits: 2,
      actor: "a",
      dryRun: false,
    });
    await stub.confirmBooking({ bookingKey: "key-1", bookingId: "WW-123" });
    await stub.cancelLedger({ bookingId: "WW-123" });

    await expect(stub.capsRemaining(MON)).resolves.toEqual({ day: 1, week: 5 });
    await expect(
      stub.reserveBooking({
        bookingKey: "key-2",
        date: MON,
        credits: 2,
        actor: "a",
        dryRun: false,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("ignores a reservation nobody confirmed within ten minutes", async () => {
    const stub = freshSession("ledger-stale");
    const start = Date.now();
    await setClock(stub, start);
    await stub.reserveBooking({
      bookingKey: "abandoned",
      date: MON,
      credits: 2,
      actor: "a",
      dryRun: false,
    });
    await expect(stub.capsRemaining(MON)).resolves.toEqual({ day: 0, week: 4 });

    await setClock(stub, start + STALE_RESERVATION_MS + 1_000);
    await expect(stub.capsRemaining(MON)).resolves.toEqual({ day: 1, week: 5 });
    await expect(
      stub.reserveBooking({ bookingKey: "real", date: MON, credits: 2, actor: "a", dryRun: false }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("keeps counting a stale reservation once it is confirmed", async () => {
    const stub = freshSession("ledger-stale-confirmed");
    const start = Date.now();
    await setClock(stub, start);
    await stub.reserveBooking({
      bookingKey: "slow",
      date: MON,
      credits: 2,
      actor: "a",
      dryRun: false,
    });
    await stub.confirmBooking({ bookingKey: "slow", bookingId: "WW-9" });

    await setClock(stub, start + STALE_RESERVATION_MS * 10);
    await expect(stub.capsRemaining(MON)).resolves.toEqual({ day: 0, week: 4 });
  });

  it("validates its arguments", async () => {
    const stub = freshSession("ledger-validation");
    await expect(
      rejection(stub.confirmBooking({ bookingKey: "", bookingId: "WW-1" })),
    ).resolves.toMatchObject({ code: "VALIDATION" });
    await expect(rejection(stub.cancelLedger({ bookingId: "" }))).resolves.toMatchObject({
      code: "VALIDATION",
    });
  });
});
