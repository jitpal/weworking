/**
 * Time helpers.
 *
 * The cases worth writing down are the ones a fixed-offset implementation gets wrong:
 * both sides of a DST transition in each hemisphere-ish zone we care about
 * (America/New_York, Europe/London), a zone with no DST at all (Asia/Tokyo), the hour
 * that happens twice, the hour that never happens, and the ISO-week edges that the
 * weekly booking cap is counted on.
 *
 * Transition dates used below (2026): US clocks go forward 08 March and back 01
 * November; UK clocks go forward 29 March and back 25 October.
 */

import { describe, expect, it } from "vitest";
import {
  addDays,
  assertDate,
  assertTime,
  ceilTo30,
  compareDates,
  floorTo30,
  formatLocalRange,
  isOn30Grid,
  isoUtc,
  isoWeekKey,
  isValidDate,
  localToUtcIso,
  localWallClock,
  offsetString,
  todayIn,
  tzOffsetMinutes,
  utcToLocal,
} from "../../src/core/time";
import { isAppError } from "../../src/errors";

describe("validation", () => {
  it("accepts real dates and rejects impossible ones", () => {
    expect(isValidDate("2026-09-21")).toBe(true);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-9-1")).toBe(false);
    expect(isValidDate("tomorrow")).toBe(false);
  });

  it("raises VALIDATION naming the field", () => {
    try {
      assertDate("nope", "date");
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("VALIDATION");
      expect(isAppError(err) && err.message).toContain("date");
    }
    expect(() => assertTime("25:00", "start_time")).toThrow(/start_time/);
    expect(() => assertTime("09:60")).toThrow();
    expect(assertTime("23:59")).toBe("23:59");
  });

  it("rejects an unknown time zone with VALIDATION, not a RangeError", () => {
    try {
      todayIn("Mars/Olympus_Mons");
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("VALIDATION");
    }
  });
});

describe("tzOffsetMinutes / offsetString", () => {
  it.each([
    ["Europe/London", "2026-01-15T12:00:00Z", 0, "+00:00"],
    ["Europe/London", "2026-07-15T12:00:00Z", 60, "+01:00"],
    ["America/New_York", "2026-01-15T12:00:00Z", -300, "-05:00"],
    ["America/New_York", "2026-07-15T12:00:00Z", -240, "-04:00"],
    ["Asia/Tokyo", "2026-01-15T12:00:00Z", 540, "+09:00"],
    ["Asia/Tokyo", "2026-07-15T12:00:00Z", 540, "+09:00"],
    ["Asia/Kolkata", "2026-07-15T12:00:00Z", 330, "+05:30"],
  ])("%s at %s is %i minutes (%s)", (tz, instant, minutes, formatted) => {
    expect(tzOffsetMinutes(Date.parse(instant), tz)).toBe(minutes);
    expect(offsetString(Date.parse(instant), tz)).toBe(formatted);
  });

  it("changes offset across a DST boundary within the same day", () => {
    // UK clocks go forward at 01:00 UTC on 29 March 2026.
    expect(tzOffsetMinutes(Date.parse("2026-03-29T00:59:00Z"), "Europe/London")).toBe(0);
    expect(tzOffsetMinutes(Date.parse("2026-03-29T01:01:00Z"), "Europe/London")).toBe(60);
  });
});

describe("localToUtcIso", () => {
  it.each([
    ["Europe/London", "2026-09-21", "09:00", "2026-09-21T08:00:00Z"],
    ["Europe/London", "2026-12-21", "09:00", "2026-12-21T09:00:00Z"],
    ["America/New_York", "2026-09-21", "09:00", "2026-09-21T13:00:00Z"],
    ["America/New_York", "2026-12-21", "09:00", "2026-12-21T14:00:00Z"],
    ["Asia/Tokyo", "2026-09-21", "09:00", "2026-09-21T00:00:00Z"],
    ["Asia/Tokyo", "2026-12-21", "09:00", "2026-12-21T00:00:00Z"],
  ])("%s %s %s -> %s", (tz, date, time, expected) => {
    expect(localToUtcIso(date, time, tz)).toBe(expected);
  });

  it("handles the day clocks go forward in New York (09 March has no 02:30 local)", () => {
    // 08 March 2026, 02:00 local does not exist; 01:30 is EST and 03:30 is EDT.
    expect(localToUtcIso("2026-03-08", "01:30", "America/New_York")).toBe("2026-03-08T06:30:00Z");
    expect(localToUtcIso("2026-03-08", "03:30", "America/New_York")).toBe("2026-03-08T07:30:00Z");
    // The skipped hour resolves forward past the gap rather than throwing.
    expect(localToUtcIso("2026-03-08", "02:30", "America/New_York")).toBe("2026-03-08T07:30:00Z");
  });

  it("handles the day clocks go back in New York (01:30 happens twice)", () => {
    // 01 November 2026: 01:30 local occurs at 05:30Z (EDT) and again at 06:30Z (EST).
    // The earlier occurrence is the documented resolution.
    expect(localToUtcIso("2026-11-01", "01:30", "America/New_York")).toBe("2026-11-01T05:30:00Z");
    expect(localToUtcIso("2026-11-01", "00:30", "America/New_York")).toBe("2026-11-01T04:30:00Z");
    expect(localToUtcIso("2026-11-01", "03:00", "America/New_York")).toBe("2026-11-01T08:00:00Z");
  });

  it("handles both London transitions", () => {
    // Forward: 29 March 2026 at 01:00 local.
    expect(localToUtcIso("2026-03-29", "00:30", "Europe/London")).toBe("2026-03-29T00:30:00Z");
    expect(localToUtcIso("2026-03-29", "09:00", "Europe/London")).toBe("2026-03-29T08:00:00Z");
    // Back: 25 October 2026 at 02:00 local.
    expect(localToUtcIso("2026-10-25", "09:00", "Europe/London")).toBe("2026-10-25T09:00:00Z");
    expect(localToUtcIso("2026-10-24", "09:00", "Europe/London")).toBe("2026-10-24T08:00:00Z");
  });

  it("Tokyo never shifts, so a booking window is stable all year", () => {
    expect(localToUtcIso("2026-03-29", "09:00", "Asia/Tokyo")).toBe("2026-03-29T00:00:00Z");
    expect(localToUtcIso("2026-11-01", "09:00", "Asia/Tokyo")).toBe("2026-11-01T00:00:00Z");
  });

  it("treats 24:00 as midnight ending the date", () => {
    expect(localToUtcIso("2026-09-21", "24:00", "Asia/Tokyo")).toBe("2026-09-21T15:00:00Z");
  });

  it("round-trips through utcToLocal across a DST boundary", () => {
    for (const date of ["2026-03-28", "2026-03-29", "2026-03-30", "2026-10-25"]) {
      const utc = localToUtcIso(date, "09:00", "Europe/London");
      const local = utcToLocal(utc, "Europe/London");
      expect(local.date).toBe(date);
      expect(local.time).toBe("09:00");
    }
  });
});

describe("utcToLocal / labels", () => {
  it("renders the local date, time and a human label", () => {
    expect(utcToLocal("2026-09-21T08:00:00Z", "Europe/London")).toEqual({
      date: "2026-09-21",
      time: "09:00",
      label: "Mon 21 Sep 09:00",
    });
  });

  it("crosses the date line correctly for Tokyo", () => {
    const local = utcToLocal("2026-09-21T16:00:00Z", "Asia/Tokyo");
    expect(local.date).toBe("2026-09-22");
    expect(local.time).toBe("01:00");
  });

  it("formats a same-day range compactly and a midnight-crossing one in full", () => {
    expect(formatLocalRange("2026-09-21T08:00:00Z", "2026-09-21T16:00:00Z", "Europe/London")).toBe(
      "Mon 21 Sep 09:00-17:00",
    );
    expect(formatLocalRange("2026-09-21T13:00:00Z", "2026-09-21T16:00:00Z", "Asia/Tokyo")).toBe(
      "Mon 21 Sep 22:00 - Tue 22 Sep 01:00",
    );
  });

  it("normalises instants to second precision with a Z suffix", () => {
    expect(isoUtc(Date.parse("2026-09-21T08:00:00.456Z"))).toBe("2026-09-21T08:00:00Z");
  });

  it("builds zone-less wall-clock strings the domain types use", () => {
    expect(localWallClock("2026-09-21", "09:00")).toBe("2026-09-21T09:00:00");
  });
});

describe("the 30-minute grid", () => {
  it.each([
    ["09:00", "09:00", "09:00", true],
    ["09:29", "09:00", "09:30", false],
    ["09:30", "09:30", "09:30", true],
    ["09:31", "09:30", "10:00", false],
    ["00:01", "00:00", "00:30", false],
    ["23:30", "23:30", "23:30", true],
  ])("%s floors to %s, ceils to %s", (time, floored, ceiled, onGrid) => {
    expect(floorTo30(time)).toBe(floored);
    expect(ceilTo30(time)).toBe(ceiled);
    expect(isOn30Grid(time)).toBe(onGrid);
  });

  it("ceils past the end of the day to the 24:00 sentinel", () => {
    expect(ceilTo30("23:45")).toBe("24:00");
    expect(ceilTo30("23:59")).toBe("24:00");
  });
});

describe("calendar arithmetic", () => {
  it("adds and subtracts days across month and year ends", () => {
    expect(addDays("2026-09-21", 1)).toBe("2026-09-22");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("compares dates lexicographically", () => {
    expect(compareDates("2026-09-21", "2026-09-22")).toBe(-1);
    expect(compareDates("2026-09-22", "2026-09-21")).toBe(1);
    expect(compareDates("2026-09-21", "2026-09-21")).toBe(0);
  });

  it("reports today in the building's zone, not the server's", () => {
    // 23:00 UTC on the 21st is already the 22nd in Tokyo and still the 21st in New York.
    const instant = Date.parse("2026-09-21T23:00:00Z");
    expect(todayIn("Asia/Tokyo", instant)).toBe("2026-09-22");
    expect(todayIn("America/New_York", instant)).toBe("2026-09-21");
    expect(todayIn("UTC", instant)).toBe("2026-09-21");
  });

  it.each([
    ["2026-01-01", "2026-W01"],
    ["2026-01-04", "2026-W01"],
    ["2026-01-05", "2026-W02"],
    ["2026-09-21", "2026-W39"],
    ["2026-12-31", "2026-W53"],
    ["2027-01-01", "2026-W53"],
    ["2027-01-04", "2027-W01"],
    ["2024-12-30", "2025-W01"],
  ])("isoWeekKey(%s) is %s", (date, key) => {
    expect(isoWeekKey(date)).toBe(key);
  });

  it("gives Monday and Sunday of the same ISO week the same key", () => {
    expect(isoWeekKey("2026-09-21")).toBe(isoWeekKey("2026-09-27"));
    expect(isoWeekKey("2026-09-27")).not.toBe(isoWeekKey("2026-09-28"));
  });
});
