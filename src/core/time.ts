/**
 * Time helpers: IANA time zones, 30-minute grids, and the local/UTC round trip.
 *
 * WeWork's booking API is strict in two ways that make naive date handling wrong:
 *
 *  1. Every instant it accepts is **true UTC on a 30-minute boundary** (`...:00:00Z`
 *     or `...:30:00Z`), while everything a user says ("Monday at 9") is **local wall
 *     clock at the building**. A building's offset is not a constant — London is
 *     `+01:00` in September and `+00:00` in December — so the conversion must be
 *     done per instant, in the building's own IANA zone.
 *  2. Its bookings list stamps local wall-clock times with a `Z` suffix, so those
 *     strings must never be parsed as instants.
 *
 * Everything here is built on `Intl.DateTimeFormat` — no date library, no offset
 * table. The trick used throughout (`zonedParts` → `Date.UTC` → subtract) is the
 * standard way to recover a zone's offset at an instant from the platform's own
 * tzdata, which Workers ships with full ICU.
 *
 * Conventions in this file:
 * - `date` is `"YYYY-MM-DD"` (a local calendar date at the building).
 * - `time` is `"HH:MM"`, 24-hour local wall clock.
 * - `isoUtc` is `"YYYY-MM-DDTHH:MM:SSZ"` — a true instant, milliseconds stripped.
 * - A *local wall clock* string is `"YYYY-MM-DDTHH:MM:SS"` with **no** zone suffix,
 *   matching `SpaceAvailability.startLocal` / `Booking.startLocal`.
 */

import { AppError } from "../errors";

/** `"YYYY-MM-DD"`. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `"HH:MM"`, 24-hour. */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** The grid WeWork quantises every bookable slot to. */
export const SLOT_MINUTES = 30;

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** True when `date` is a well-formed *and* real calendar date (rejects `2026-02-30`). */
export function isValidDate(date: string): boolean {
  const match = DATE_RE.exec(date);
  if (!match) return false;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day
  );
}

/** True when `time` is a well-formed 24-hour `"HH:MM"`. */
export function isValidTime(time: string): boolean {
  return TIME_RE.test(time);
}

/**
 * Validates a date, raising the caller-facing error the agent should see.
 *
 * @param field the parameter name to name in the message, e.g. `"date"`.
 * @throws {AppError} `VALIDATION`
 */
export function assertDate(date: string, field = "date"): string {
  if (!isValidDate(date)) {
    throw new AppError("VALIDATION", `${field} must be a real calendar date in YYYY-MM-DD form.`, {
      hint: `Pass ${field} as a local calendar date at the building, e.g. "2026-09-21".`,
    });
  }
  return date;
}

/**
 * Validates a wall-clock time.
 *
 * @throws {AppError} `VALIDATION`
 */
export function assertTime(time: string, field = "time"): string {
  if (!isValidTime(time)) {
    throw new AppError("VALIDATION", `${field} must be a 24-hour local time in HH:MM form.`, {
      hint: `Pass ${field} as local wall clock at the building, e.g. "09:00".`,
    });
  }
  return time;
}

/* -------------------------------------------------------------------------- */
/* Zone offsets                                                                */
/* -------------------------------------------------------------------------- */

/** `Intl.DateTimeFormat` construction is not free; one formatter per zone is. */
const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const labelFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  const cached = partsFormatters.get(tz);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new AppError("VALIDATION", `Unknown IANA time zone "${tz}".`, {
      hint: "Use the timezone reported on the location, e.g. 'Europe/London'.",
    });
  }
  partsFormatters.set(tz, formatter);
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock field values `tz` shows at `instantMs`. */
function zonedParts(instantMs: number, tz: string): ZonedParts {
  const parts = partsFormatter(tz).formatToParts(new Date(instantMs));
  const found: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") found[part.type] = Number(part.value);
  }
  return {
    year: found.year ?? 0,
    month: found.month ?? 1,
    day: found.day ?? 1,
    hour: found.hour ?? 0,
    minute: found.minute ?? 0,
    second: found.second ?? 0,
  };
}

/**
 * The UTC offset of `tz` at `instantMs`, in minutes east of UTC.
 *
 * @example
 * tzOffsetMinutes(Date.parse("2026-07-01T12:00:00Z"), "America/New_York"); // -240
 * tzOffsetMinutes(Date.parse("2026-12-01T12:00:00Z"), "America/New_York"); // -300
 */
export function tzOffsetMinutes(instantMs: number, tz: string): number {
  const p = zonedParts(instantMs, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = instantMs - (instantMs % 1000);
  return Math.round((asIfUtc - whole) / MINUTE_MS);
}

/**
 * The fixed-offset string WeWork's `UTCOffset` field wants, for `tz` at `instantMs`.
 *
 * @example offsetString(Date.parse("2026-09-21T08:00:00Z"), "Europe/London") // "+01:00"
 */
export function offsetString(instantMs: number, tz: string): string {
  const minutes = tzOffsetMinutes(instantMs, tz);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/* -------------------------------------------------------------------------- */
/* Local <-> UTC                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Converts a local wall-clock date+time at `tz` into a true UTC instant string.
 *
 * Two passes are needed: the first guesses the offset from the wall-clock value
 * read as if it were UTC, the second re-reads it at the candidate instant, which
 * is what makes the hour either side of a DST transition come out right.
 *
 * Ambiguous times (the repeated hour when clocks go back) resolve to the *first*
 * occurrence; non-existent times (the skipped hour when clocks go forward) resolve
 * forward past the gap, exactly as a calendar app does.
 *
 * @example localToUtcIso("2026-09-21", "09:00", "Europe/London") // "2026-09-21T08:00:00Z"
 *
 * @param date local calendar date `"YYYY-MM-DD"`
 * @param time local wall clock `"HH:MM"`
 * @param tz IANA zone name
 * @returns `"YYYY-MM-DDTHH:MM:SSZ"`
 * @throws {AppError} `VALIDATION` on a malformed date/time or unknown zone
 */
export function localToUtcIso(date: string, time: string, tz: string): string {
  return isoUtc(localToUtcMs(date, time, tz));
}

/** {@link localToUtcIso} as epoch milliseconds. */
export function localToUtcMs(date: string, time: string, tz: string): number {
  assertDate(date);
  // `"24:00"` — the end-of-day sentinel {@link ceilTo30} can produce — means
  // midnight at the *end* of `date`, i.e. 00:00 on the following day.
  if (time === "24:00") return localToUtcMs(addDays(date, 1), "00:00", tz);
  assertTime(time);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm, 0);

  // Pass 1: offset read at the wall-clock value taken as UTC.
  const offsetGuess = tzOffsetMinutes(wallAsUtc, tz);
  const first = wallAsUtc - offsetGuess * MINUTE_MS;
  // Pass 2: offset read at the candidate instant. Away from a transition the two
  // agree and we are done.
  const offsetAtFirst = tzOffsetMinutes(first, tz);
  if (offsetAtFirst === offsetGuess) return first;

  // Within an hour of a transition the two offsets differ, so there are two
  // candidates and at most one of them actually shows the requested wall clock.
  const second = wallAsUtc - offsetAtFirst * MINUTE_MS;
  const firstMatches = showsWallClock(first, tz, wallAsUtc);
  const secondMatches = showsWallClock(second, tz, wallAsUtc);
  if (firstMatches && secondMatches) return Math.min(first, second); // ambiguous: first occurrence
  if (firstMatches) return first;
  if (secondMatches) return second;
  // Neither: the wall clock does not exist (the skipped hour). Resolve forward past
  // the gap, which is what a calendar app does with "02:30" on a spring-forward day.
  return Math.max(first, second);
}

/** True when `instantMs`, rendered in `tz`, shows exactly the wall clock encoded in `wallAsUtc`. */
function showsWallClock(instantMs: number, tz: string, wallAsUtc: number): boolean {
  const p = zonedParts(instantMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0) === wallAsUtc;
}

/** The local view of a UTC instant: calendar date, wall-clock time, and a human label. */
export interface LocalInstant {
  /** `"YYYY-MM-DD"` in `tz`. */
  date: string;
  /** `"HH:MM"` in `tz`. */
  time: string;
  /** Short human label, e.g. `"Mon 21 Sep 09:00"`. */
  label: string;
}

/**
 * Renders a UTC instant in a building's zone.
 *
 * @param isoUtcInstant any string `Date` can parse, normally `"...Z"`
 * @throws {AppError} `VALIDATION` on an unparseable instant or unknown zone
 */
export function utcToLocal(isoUtcInstant: string, tz: string): LocalInstant {
  const ms = Date.parse(isoUtcInstant);
  if (Number.isNaN(ms)) {
    throw new AppError(
      "VALIDATION",
      "Expected an ISO-8601 UTC instant such as 2026-09-21T08:00:00Z.",
    );
  }
  const p = zonedParts(ms, tz);
  return {
    date: `${String(p.year).padStart(4, "0")}-${pad2(p.month)}-${pad2(p.day)}`,
    time: `${pad2(p.hour)}:${pad2(p.minute)}`,
    label: localLabel(ms, tz),
  };
}

/** `"YYYY-MM-DDTHH:MM:SS"` — the zone-less wall-clock form the domain types use. */
export function localWallClock(date: string, time: string): string {
  return `${date}T${time}:00`;
}

/** Normalises an instant to `"YYYY-MM-DDTHH:MM:SSZ"` (milliseconds dropped). */
export function isoUtc(ms: number): string {
  return new Date(ms - (ms % 1000)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/* -------------------------------------------------------------------------- */
/* The 30-minute grid                                                          */
/* -------------------------------------------------------------------------- */

/** True when `time` already sits on a 30-minute boundary. */
export function isOn30Grid(time: string): boolean {
  assertTime(time);
  return Number(time.slice(3, 5)) % SLOT_MINUTES === 0;
}

/**
 * Rounds a wall-clock time **down** to the 30-minute grid.
 *
 * @example floorTo30("09:44") // "09:30"
 */
export function floorTo30(time: string): string {
  assertTime(time);
  const minutes = toMinutes(time);
  return fromMinutes(minutes - (minutes % SLOT_MINUTES));
}

/**
 * Rounds a wall-clock time **up** to the 30-minute grid.
 *
 * Anything after `23:30` becomes the end-of-day sentinel `"24:00"`: it is the only
 * way to express "midnight at the end of this date" as a closing time, and the
 * callers that consume it ({@link localToUtcIso} via a day rollover) handle it.
 *
 * @example ceilTo30("09:01") // "09:30"
 * @example ceilTo30("23:45") // "24:00"
 */
export function ceilTo30(time: string): string {
  assertTime(time);
  const minutes = toMinutes(time);
  const remainder = minutes % SLOT_MINUTES;
  const rounded = remainder === 0 ? minutes : minutes + (SLOT_MINUTES - remainder);
  if (rounded >= 24 * 60) return "24:00";
  return fromMinutes(rounded);
}

/* -------------------------------------------------------------------------- */
/* Calendar arithmetic                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Today's local calendar date in `tz`.
 *
 * @param nowMs injected clock, so callers stay testable
 */
export function todayIn(tz: string, nowMs: number = Date.now()): string {
  const p = zonedParts(nowMs, tz);
  return `${String(p.year).padStart(4, "0")}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** `date` shifted by whole days, staying a calendar date (no zone involved). */
export function addDays(date: string, days: number): string {
  assertDate(date);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${pad2(
    shifted.getUTCMonth() + 1,
  )}-${pad2(shifted.getUTCDate())}`;
}

/** `-1`, `0` or `1`, comparing two `"YYYY-MM-DD"` dates. Lexicographic order is date order. */
export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The ISO-8601 week a calendar date falls in, as `"YYYY-Www"`.
 *
 * This is the key the weekly booking cap is counted under, so it must follow the
 * ISO rules exactly: weeks start on Monday, and week 1 is the one containing the
 * first Thursday — which is why `2027-01-01` is `"2026-W53"`.
 *
 * @example isoWeekKey("2026-09-21") // "2026-W39"
 */
export function isoWeekKey(date: string): string {
  assertDate(date);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1, d));
  // ISO weekday, Monday = 1 … Sunday = 7.
  const weekday = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  // Shift onto the Thursday of this ISO week; its calendar year is the ISO year.
  target.setUTCDate(target.getUTCDate() + 4 - weekday);
  const isoYear = target.getUTCFullYear();
  const firstThursday = Date.UTC(isoYear, 0, 4);
  const firstWeekday =
    new Date(firstThursday).getUTCDay() === 0 ? 7 : new Date(firstThursday).getUTCDay();
  const week1Monday = firstThursday - (firstWeekday - 1) * DAY_MS;
  const week = Math.round((target.getTime() - week1Monday) / (7 * DAY_MS)) + 1;
  return `${isoYear}-W${pad2(week)}`;
}

/* -------------------------------------------------------------------------- */
/* Human labels                                                                */
/* -------------------------------------------------------------------------- */

function labelFormatter(tz: string): Intl.DateTimeFormat {
  const cached = labelFormatters.get(tz);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    throw new AppError("VALIDATION", `Unknown IANA time zone "${tz}".`);
  }
  labelFormatters.set(tz, formatter);
  return formatter;
}

/** `"Mon 21 Sep 09:00"` — the instant as a human reads it at the building. */
export function localLabel(instantMs: number, tz: string): string {
  const parts = labelFormatter(tz).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday").replace(/,$/, "");
  // en-GB renders September as "Sept"; trimming to three letters keeps every month the
  // same width, which is what docs/API.md's example summaries show.
  const month = get("month").slice(0, 3);
  return `${weekday} ${get("day")} ${month} ${get("hour")}:${get("minute")}`;
}

/**
 * `"Mon 21 Sep 09:00-17:00"` for a same-day range, and
 * `"Mon 21 Sep 22:00 - Tue 22 Sep 02:00"` when it crosses midnight locally.
 *
 * This is the string every agent-facing `summary` embeds, so the user always hears
 * local times at the building rather than UTC.
 */
export function formatLocalRange(startUtcIso: string, endUtcIso: string, tz: string): string {
  const startMs = Date.parse(startUtcIso);
  const endMs = Date.parse(endUtcIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new AppError("VALIDATION", "formatLocalRange needs two ISO-8601 UTC instants.");
  }
  const start = utcToLocal(startUtcIso, tz);
  const end = utcToLocal(endUtcIso, tz);
  if (start.date === end.date) return `${start.label}-${end.time}`;
  return `${start.label} - ${end.label}`;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function fromMinutes(total: number): string {
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}
