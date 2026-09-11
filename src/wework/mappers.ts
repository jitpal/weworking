/**
 * Raw upstream JSON -> domain types, plus the time arithmetic that goes with it.
 *
 * All the upstream weirdness is absorbed here so that nothing above
 * `src/wework/` has to know about it:
 *
 * - **Times are not zero-padded.** `openTime` comes back as `"9:00"`, sometimes
 *   `"9:0"`, occasionally `"09:00:00"`. {@link padTime} normalises to `"HH:MM"`.
 * - **Offsets are not consistent.** `timezoneOffset` is usually `"+02:00"`, but
 *   `"+2:00"`, `"GMT+02:00"` and a signed minute count have all been seen.
 *   {@link normaliseOffset} produces `"+HH:MM"`.
 * - **The bookings list stamps local wall clock with `Z`.** `"2026-09-14T09:00:00Z"`
 *   for a Berlin desk means 09:00 *in Berlin*. Calling `new Date(...)` on it and
 *   formatting in the location's zone shifts it by the offset — the single most
 *   common bug in every client that talks to this API. {@link wallClockFromLocalZStamp}
 *   re-anchors it by discarding the bogus `Z`; nothing is ever converted.
 * - **True local -> UTC conversion uses the IANA zone, not the fixed offset.**
 *   {@link zonedWallClockToUtcIso} asks `Intl` for the offset *at that instant*, so a
 *   booking on the far side of a DST transition is right. The fixed
 *   `timezoneOffset` string is only a fallback, and is what goes into the upstream
 *   `UTCOffset` field because that is what upstream expects there.
 *
 * Every mapper is defensive: a missing or wrong-typed field yields a sensible
 * default or `undefined`, never a throw. The one exception is
 * {@link assertOnGrid}, which is a validation, not a mapping.
 */

import type { Booking, Credits, Location, Profile, SpaceAvailability } from "../core/types";
import { AppError } from "../errors";
import type {
  RawCity,
  RawLocation,
  RawMonthlyCreditsResponse,
  RawProfileResponse,
  RawUpcomingBooking,
  RawWorkspace,
} from "./raw-types";

/** Bookings are only ever accepted on a 30-minute grid. */
export const GRID_MINUTES = 30;

/** Default window when a location reports no opening hours: the whole day. */
export const DEFAULT_OPEN_TIME = "00:00";
/** Floored to the grid, so `23:59` becomes the last bookable boundary. */
export const DEFAULT_CLOSE_TIME = "23:30";

/** Mean Earth radius, for the haversine distance. */
const EARTH_RADIUS_KM = 6371;

/* -------------------------------------------------------------------------- */
/* Scalar coercion                                                             */
/* -------------------------------------------------------------------------- */

/** A trimmed non-empty string, or `undefined`. */
export function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value.trim() : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** A finite number, accepting the numeric strings upstream sometimes returns. */
export function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A boolean, accepting `"true"`, `"1"`, `1`. */
export function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (normalised === "true" || normalised === "1" || normalised === "yes") return true;
    if (normalised === "false" || normalised === "0" || normalised === "no") return false;
  }
  return undefined;
}

/** First defined value, for the several spellings upstream uses per field. */
export function first<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
}

/**
 * Pulls an array out of a response, trying each key in turn.
 *
 * Returns `[]` rather than throwing: an empty list and a shape change should both
 * read as "no results" to the caller, with the shape change visible in the tests.
 */
export function arrayAt(source: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(source)) return source;
  if (typeof source !== "object" || source === null) return [];
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Time normalisation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Normalises an upstream clock time to `"HH:MM"`.
 *
 * @example
 * padTime("9:00");     // "09:00"
 * padTime("9:0");      // "09:00"
 * padTime("09:00:00"); // "09:00"
 * padTime("7 PM");     // "19:00"
 */
export function padTime(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;

  const meridiem = /\b(am|pm)\b/i.exec(raw);
  const digits = /(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?/.exec(raw);
  if (!digits) return undefined;

  let hours = Number.parseInt(digits[1] ?? "", 10);
  const minutes = Number.parseInt(digits[2] ?? "0", 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;

  if (meridiem) {
    const isPm = meridiem[1]?.toLowerCase() === "pm";
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
  }
  if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59) return undefined;
  if (hours === 24) hours = 0;

  return `${pad2(hours)}:${pad2(minutes)}`;
}

/**
 * Normalises a UTC offset to `"+HH:MM"`.
 *
 * Accepts `"+02:00"`, `"+2:00"`, `"02:00"`, `"GMT+02:00"`, `"Z"`, `120` (minutes)
 * and `-300`.
 */
export function normaliseOffset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return offsetFromMinutes(value);
  }
  const raw = str(value);
  if (!raw) return undefined;
  if (/^z$/i.test(raw) || /^utc$/i.test(raw) || /^gmt$/i.test(raw)) return "+00:00";

  if (/^[+-]?\d{1,4}$/.test(raw)) {
    const asNumber = Number.parseInt(raw, 10);
    // A bare 3-4 digit value is HHMM; 1-2 digits is a minute count of hours.
    if (Math.abs(asNumber) >= 100) {
      const sign = asNumber < 0 ? -1 : 1;
      const absolute = Math.abs(asNumber);
      return offsetFromMinutes(sign * (Math.floor(absolute / 100) * 60 + (absolute % 100)));
    }
    return offsetFromMinutes(asNumber);
  }

  const match = /([+-])?\s*(\d{1,2}):(\d{2})/.exec(raw);
  if (!match) return undefined;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  return offsetFromMinutes(sign * (hours * 60 + minutes));
}

/** `"+HH:MM"` from a signed minute count. */
export function offsetFromMinutes(minutes: number): string {
  const rounded = Math.round(minutes);
  const sign = rounded < 0 ? "-" : "+";
  const absolute = Math.abs(rounded);
  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

/** Minutes from a `"+HH:MM"` offset string, or `undefined`. */
export function offsetToMinutes(offset: string): number | undefined {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim());
  if (!match) return undefined;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number.parseInt(match[2] ?? "0", 10) * 60 + Number.parseInt(match[3] ?? "0", 10));
}

/**
 * Re-anchors a local-wall-clock-stamped-`Z` timestamp by dropping the false zone.
 *
 * This is the fix for the bookings list: the value is already in the location's
 * wall clock, so the only correct operation is to stop pretending it is UTC.
 * Nothing is converted and no zone is consulted.
 *
 * @example
 * wallClockFromLocalZStamp("2026-09-14T09:00:00Z");     // "2026-09-14T09:00:00"
 * wallClockFromLocalZStamp("2026-09-14T09:00:00.000Z"); // "2026-09-14T09:00:00"
 */
export function wallClockFromLocalZStamp(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!match) return undefined;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`;
}

/** `"YYYY-MM-DDTHH:MM:SS"` from a date and an `"HH:MM"` time. */
export function wallClock(date: string, time: string): string {
  return `${date}T${time}:00`;
}

/** Epoch ms for a wall clock read as if it were UTC. The basis for all arithmetic. */
export function wallClockToPseudoUtcMs(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!match) return undefined;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? "0"),
  );
}

/** Inverse of {@link wallClockToPseudoUtcMs}. */
export function pseudoUtcMsToWallClock(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/**
 * The UTC offset, in minutes, in force in `timeZone` at `utcMs`.
 *
 * Works by formatting the instant in the zone and reading the result back as if it
 * were UTC; the difference is the offset. Returns `undefined` for an unknown zone.
 */
export function zoneOffsetMinutesAt(utcMs: number, timeZone: string): number | undefined {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs));
  } catch {
    return undefined;
  }

  const lookup: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") lookup[part.type] = part.value;
  const year = Number(lookup.year);
  const month = Number(lookup.month);
  const day = Number(lookup.day);
  const hour = Number(lookup.hour) % 24;
  const minute = Number(lookup.minute);
  const second = Number(lookup.second);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return undefined;

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((asUtc - utcMs) / 60_000);
}

/**
 * Converts a local wall clock in `timeZone` to a true UTC instant, as
 * `"YYYY-MM-DDTHH:MM:SSZ"`.
 *
 * Two iterations of the offset lookup, which is what makes it correct within a
 * DST transition: the first guess uses the offset at the *wrong* instant, the
 * second uses the offset at the (nearly) right one.
 *
 * Falls back to `fallbackOffset` (the upstream `timezoneOffset` string) when the
 * zone is unknown to `Intl`, and to `+00:00` when there is no fallback either.
 */
export function zonedWallClockToUtcIso(
  localWallClock: string,
  timeZone: string | undefined,
  fallbackOffset?: string,
): string {
  const pseudo = wallClockToPseudoUtcMs(localWallClock);
  if (pseudo === undefined) {
    throw new AppError("VALIDATION", `"${localWallClock}" is not a YYYY-MM-DDTHH:MM:SS timestamp.`);
  }

  if (timeZone) {
    const firstGuess = zoneOffsetMinutesAt(pseudo, timeZone);
    if (firstGuess !== undefined) {
      const refined = zoneOffsetMinutesAt(pseudo - firstGuess * 60_000, timeZone) ?? firstGuess;
      return utcIso(pseudo - refined * 60_000);
    }
  }

  const fallbackMinutes = fallbackOffset ? offsetToMinutes(fallbackOffset) : undefined;
  return utcIso(pseudo - (fallbackMinutes ?? 0) * 60_000);
}

/** `"YYYY-MM-DDTHH:MM:SSZ"` — seconds precision, no milliseconds. */
export function utcIso(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** Normalises any ISO UTC stamp to the seconds-precision `Z` form. */
export function normaliseUtcStamp(value: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!match) return undefined;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}Z`;
}

/** Rounds a `"HH:MM"` time down to the 30-minute grid. */
export function floorTimeToGrid(time: string): string {
  const [hours = "00", minutes = "00"] = time.split(":");
  const floored = Math.floor(Number.parseInt(minutes, 10) / GRID_MINUTES) * GRID_MINUTES;
  return `${pad2(Number.parseInt(hours, 10))}:${pad2(floored)}`;
}

/** True when an ISO stamp sits exactly on a 30-minute boundary. */
export function isOnGrid(iso: string): boolean {
  const match = /[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?/.exec(iso);
  if (!match) return false;
  const minutes = Number.parseInt(match[2] ?? "", 10);
  const seconds = Number.parseInt(match[3] ?? "0", 10);
  const fraction = Number.parseInt(match[4] ?? "0", 10);
  return minutes % GRID_MINUTES === 0 && seconds === 0 && fraction === 0;
}

/**
 * Guards the 30-minute grid.
 *
 * WeWork silently refuses off-grid bookings (a 200 with a refusal), so catching it
 * here turns an opaque upstream failure into an actionable validation error.
 *
 * @throws {AppError} `VALIDATION` naming the offending field.
 */
export function assertOnGrid(iso: string, field: string): void {
  if (!isOnGrid(iso)) {
    throw new AppError("VALIDATION", `${field} must fall on a 30-minute boundary, got "${iso}".`, {
      hint: "Round the time to :00 or :30 and search again; WeWork only books half-hour slots.",
    });
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/* -------------------------------------------------------------------------- */
/* Geography                                                                   */
/* -------------------------------------------------------------------------- */

/** Great-circle distance in kilometres, rounded to two decimals. */
export function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(km * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Locations                                                                   */
/* -------------------------------------------------------------------------- */

/** Options for {@link mapLocation}. */
export interface MapLocationOptions {
  /** Search origin; when given, `distanceKm` is computed (or read from upstream). */
  origin?: { lat: number; lng: number };
}

/**
 * Maps a raw building to a {@link Location}.
 *
 * Returns `undefined` only when there is no usable id — a location we cannot
 * reference again is not worth returning.
 */
export function mapLocation(
  raw: RawLocation | undefined,
  options: MapLocationOptions = {},
): Location | undefined {
  if (!raw) return undefined;
  const locationId = first(str(raw.uuid), str(raw.locationUUID), str(raw.id));
  if (!locationId) return undefined;

  const address = typeof raw.address === "string" ? undefined : (raw.address ?? undefined);
  const addressLine =
    typeof raw.address === "string"
      ? str(raw.address)
      : joinAddress([str(address?.line1), str(address?.line2)]);

  const latitude = first(num(raw.latitude), num(address?.latitude));
  const longitude = first(num(raw.longitude), num(address?.longitude));

  const location: Location = {
    locationId,
    name: first(str(raw.name), locationId) ?? locationId,
    address: addressLine ?? "",
    city: first(str(raw.city), str(address?.city)) ?? "",
    country:
      first(
        str(raw.countryCode),
        str(address?.countryCode),
        str(raw.country),
        str(address?.country),
      ) ?? "",
    timezone: first(str(raw.timeZone), str(raw.timezone)) ?? "",
    accountType: first(num(raw.accountType), 0) ?? 0,
    timezoneOffset:
      first(normaliseOffset(raw.timezoneOffset), normaliseOffset(raw.timeZoneOffset)) ??
      offsetStringForZone(first(str(raw.timeZone), str(raw.timezone))) ??
      "+00:00",
  };

  if (latitude !== undefined) location.latitude = latitude;
  if (longitude !== undefined) location.longitude = longitude;

  const openTime = padTime(raw.openTime);
  const closeTime = padTime(raw.closeTime);
  if (openTime) location.openTime = openTime;
  if (closeTime) location.closeTime = closeTime;
  const currency = str(raw.currency);
  if (currency && /^[A-Z]{3}$/.test(currency)) location.currency = currency;

  // Live-verified: upstream `distance` is in metres (327.37 for a building 330 m
  // from the search point), and on a city search it is measured from some default
  // point and means nothing. Our own great-circle figure is preferred whenever a
  // search origin exists; the upstream number is only a fallback, converted to km.
  if (options.origin && latitude !== undefined && longitude !== undefined) {
    location.distanceKm = distanceKm(options.origin, { lat: latitude, lng: longitude });
  } else if (options.origin) {
    const metres = num(raw.distance);
    const upstreamKm = first(
      num(raw.distanceInKm),
      metres === undefined ? undefined : metres / 1000,
    );
    if (upstreamKm !== undefined) location.distanceKm = Math.round(upstreamKm * 100) / 100;
  }

  return location;
}

/** Maps the `locationsByGeo` array, dropping unusable entries. */
/** The current UTC offset of an IANA zone as `"+HH:MM"`, or undefined when unknown. */
export function offsetStringForZone(
  timeZone: string | undefined,
  at = Date.now(),
): string | undefined {
  if (!timeZone) return undefined;
  const minutes = zoneOffsetMinutesAt(at, timeZone);
  if (minutes === undefined) return undefined;
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function mapLocations(values: unknown[], options: MapLocationOptions = {}): Location[] {
  const out: Location[] = [];
  for (const value of values) {
    const mapped = mapLocation(value as RawLocation, options);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Distinct city names from `get-city-details`, in upstream order. */
export function mapCities(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      addCity(value, seen, out);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const raw = value as RawCity;
    const name = first(str(raw.city), str(raw.cityName), str(raw.name));
    if (name) addCity(name, seen, out);
  }
  return out;
}

function addCity(name: string, seen: Set<string>, out: string[]): void {
  const key = name.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(name);
}

function joinAddress(parts: Array<string | undefined>): string | undefined {
  const joined = parts.filter((part): part is string => Boolean(part)).join(", ");
  return joined || undefined;
}

/* -------------------------------------------------------------------------- */
/* Spaces                                                                      */
/* -------------------------------------------------------------------------- */

/** Arguments for {@link mapWorkspace}. */
export interface MapWorkspaceArgs {
  /** The searched local calendar date, `"YYYY-MM-DD"`. */
  date: string;
  /** Used when the workspace carries no nested location (or it is incomplete). */
  fallbackLocation?: Location;
  /** Narrows the returned window; defaults to the building's opening hours. */
  startTime?: string;
  endTime?: string;
  origin?: { lat: number; lng: number };
}

/**
 * Maps one shared workspace to a {@link SpaceAvailability}.
 *
 * The returned window is the intersection of the requested times and the
 * building's opening hours, floored to the 30-minute grid, with both the local
 * wall clock and the true UTC instants filled in. Returns `undefined` when there is
 * no workspace id or no usable location.
 */
export function mapWorkspace(
  raw: RawWorkspace,
  args: MapWorkspaceArgs,
): SpaceAvailability | undefined {
  const spaceId = str(raw.uuid);
  if (!spaceId) return undefined;

  const nested = mapLocation(raw.location, args.origin ? { origin: args.origin } : {});
  const location = mergeLocations(nested, args.fallbackLocation);
  if (!location) return undefined;

  const openTime = padTime(raw.openTime) ?? location.openTime ?? DEFAULT_OPEN_TIME;
  const closeTime = padTime(raw.closeTime) ?? location.closeTime ?? DEFAULT_CLOSE_TIME;

  const startTime = floorTimeToGrid(laterOf(openTime, args.startTime));
  const endTime = floorTimeToGrid(earlierOf(closeTime, args.endTime));

  const startLocal = wallClock(args.date, startTime);
  const endLocal = wallClock(args.date, endTime);

  const seatsTotal = first(num(raw.seat?.total), num(raw.seatsTotal), num(raw.capacity)) ?? 0;
  const seatsAvailable = first(num(raw.seat?.available), num(raw.seatsAvailable), seatsTotal) ?? 0;

  const space: SpaceAvailability = {
    spaceId,
    spaceName: first(str(raw.name), str(raw.spaceName), "Shared workspace") ?? "Shared workspace",
    spaceType: "desk",
    capacity: first(num(raw.capacity), seatsTotal) ?? 0,
    seatsAvailable,
    seatsTotal,
    credits: first(num(raw.credits), 0) ?? 0,
    location,
    date: args.date,
    startLocal,
    endLocal,
    startUtc: zonedWallClockToUtcIso(startLocal, location.timezone, location.timezoneOffset),
    endUtc: zonedWallClockToUtcIso(endLocal, location.timezone, location.timezoneOffset),
    timezone: location.timezone,
  };

  const inventoryUuid = str(raw.inventoryUuid);
  if (inventoryUuid) space.inventoryUuid = inventoryUuid;
  const kubeId = first(str(raw.reservable?.KubeId), str(raw.reservable?.kubeId));
  if (kubeId) space.kubeId = kubeId;

  // Live shape: `productPrice.price = { currency: "GBP", amount: 70, symbol: "£" }`, the
  // day rate before tax. The quote call returns the tax-inclusive total.
  const listed = raw.productPrice?.price;
  const cashAmount = first(num(listed?.amount), num(raw.price));
  const currency = first(str(listed?.currency), str(raw.currency));
  if (cashAmount !== undefined && currency && /^[A-Z]{3}$/.test(currency)) {
    space.cashPrice = { amount: cashAmount, currency };
  }

  return space;
}

/**
 * Fills gaps in a workspace's nested location from the one we already know about.
 *
 * `get-spaces` nests a *partial* location (no name, no address for some accounts),
 * while `get-locations-by-geo` returns the full record. Merging keeps `accountType`
 * and the timezone from whichever source has them, which matters because
 * `accountType` decides the booking `SpaceID`.
 */
export function mergeLocations(
  primary: Location | undefined,
  fallback: Location | undefined,
): Location | undefined {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const merged: Location = { ...fallback, ...primary };
  merged.name = primary.name && primary.name !== primary.locationId ? primary.name : fallback.name;
  merged.address = primary.address || fallback.address;
  merged.city = primary.city || fallback.city;
  merged.country = primary.country || fallback.country;
  merged.timezone = primary.timezone || fallback.timezone;
  merged.timezoneOffset =
    primary.timezoneOffset !== "+00:00" ? primary.timezoneOffset : fallback.timezoneOffset;
  merged.accountType = primary.accountType || fallback.accountType;
  if (primary.openTime === undefined && fallback.openTime !== undefined) {
    merged.openTime = fallback.openTime;
  }
  if (primary.closeTime === undefined && fallback.closeTime !== undefined) {
    merged.closeTime = fallback.closeTime;
  }
  return merged;
}

function laterOf(a: string, b: string | undefined): string {
  if (!b) return a;
  return b > a ? b : a;
}

function earlierOf(a: string, b: string | undefined): string {
  if (!b) return a;
  return b < a ? b : a;
}

/* -------------------------------------------------------------------------- */
/* Profile and credits                                                         */
/* -------------------------------------------------------------------------- */

/** Maps `get-user-profile`. `userId` falls back to the token's member id. */
export function mapProfile(raw: RawProfileResponse, fallbackUserId: string): Profile {
  const source = raw.userProfile ?? raw;
  const profile: Profile = {
    userId: first(str(source.uuid), str(source.userUUID), fallbackUserId) ?? fallbackUserId,
  };

  const email = first(str(source.email), str(source.emailAddress));
  if (email) profile.email = email;

  const name =
    first(
      str(source.name),
      str(source.fullName),
      joinAddress([str(source.firstName), str(source.lastName)])?.replace(", ", " "),
    ) ?? undefined;
  if (name) profile.name = name;

  // Live shape: `companies[0].preferredMembershipNullable.membershipType` is
  // "On Demand" for pay-as-you-go accounts.
  const company = Array.isArray(raw.companies)
    ? (raw.companies[0] as
        | { preferredMembershipNullable?: { membershipType?: unknown; productName?: unknown } }
        | undefined)
    : undefined;
  const membershipType = first(
    str(source.membershipType),
    str(source.membership),
    str(company?.preferredMembershipNullable?.membershipType),
    str(company?.preferredMembershipNullable?.productName),
  );
  if (membershipType) profile.membershipType = membershipType;

  const homeLocationId = first(
    str(source.homeLocationUUID),
    str(source.homeLocationUuid),
    str(source.defaultLocationUUID),
    str(raw.homeLocation?.uuid),
  );
  if (homeLocationId) profile.homeLocationId = homeLocationId;

  return profile;
}

/**
 * Maps `monthly-credits`.
 *
 * Returns `undefined` when upstream reports no credit allowance at all, which is a
 * legitimate state for a cash-billed account — `whoami` then omits the field rather
 * than claiming zero credits.
 */
export function mapCredits(
  raw: RawMonthlyCreditsResponse,
  period: { start: string; end: string },
): Credits | undefined {
  const source = raw.monthlyCredits ?? raw;
  const total = first(num(source.totalCredits));
  const remaining = first(num(source.remainingCredits), num(source.availableCredits));
  const used = first(num(source.usedCredits), num(source.creditsUsed));

  if (total === undefined && remaining === undefined && used === undefined) return undefined;

  const resolvedTotal =
    total ?? (remaining !== undefined && used !== undefined ? remaining + used : (remaining ?? 0));
  const resolvedRemaining =
    remaining ?? (total !== undefined && used !== undefined ? total - used : resolvedTotal);

  return {
    remaining: resolvedRemaining,
    total: resolvedTotal,
    periodStart: first(str(source.startDate)?.slice(0, 10), period.start) ?? period.start,
    periodEnd: first(str(source.endDate)?.slice(0, 10), period.end) ?? period.end,
  };
}

/* -------------------------------------------------------------------------- */
/* Bookings                                                                    */
/* -------------------------------------------------------------------------- */

/** Maps one entry of `get-app-upcoming-bookings`. */
export function mapBooking(raw: RawUpcomingBooking): Booking | undefined {
  const bookingId = first(str(raw.uuid), str(raw.bookingId), str(raw.BookingId));
  if (!bookingId) return undefined;

  // Local wall clock stamped Z: re-anchor, never convert.
  // Live field names are `startDate`/`endDate`; the others are older spellings.
  const startLocal = first(
    wallClockFromLocalZStamp(raw.startDate),
    wallClockFromLocalZStamp(raw.startTime),
    wallClockFromLocalZStamp(raw.StartTime),
  );
  const endLocal = first(
    wallClockFromLocalZStamp(raw.endDate),
    wallClockFromLocalZStamp(raw.endTime),
    wallClockFromLocalZStamp(raw.EndTime),
  );
  if (!startLocal || !endLocal) return undefined;

  const location = mapLocation(raw.location);
  const timezone = first(str(raw.timeZone), str(raw.timezone), location?.timezone) ?? "";

  const booking: Booking = {
    bookingId,
    locationId: first(str(raw.locationId), str(raw.locationUUID), location?.locationId) ?? "",
    locationName: first(str(raw.locationName), location?.name) ?? "",
    date: startLocal.slice(0, 10),
    startLocal,
    endLocal,
    timezone,
    status:
      raw.isCancelled === true
        ? "cancelled"
        : raw.isPendingApproval === true
          ? "pending"
          : mapBookingStatus(first(str(raw.status), str(raw.bookingStatus))),
    credits:
      first(num(raw.creditCost), num(raw.credits), num(raw.creditsUsed), num(raw.creditPrice), 0) ??
      0,
    // The cancel endpoint needs fields this domain type does not carry, so the raw
    // item rides along. `BookingService` strips it before anything reaches an agent.
    raw,
  };

  const reservationId = first(
    str(raw.reservationId),
    str(raw.ReservationID),
    str(raw.kubeBookingExternalReference),
  );
  if (reservationId) booking.reservationId = reservationId;

  const spaceName = first(str(raw.spaceName), str(raw.spaceTypeName));
  if (spaceName) booking.spaceName = spaceName;

  const address = location?.address;
  if (address) booking.address = address;

  // Live: `modificationDeadlineTime` is local wall clock stamped `Z`, like the times.
  const deadline = first(
    wallClockFromLocalZStamp(raw.modificationDeadlineTime),
    wallClockFromLocalZStamp(raw.cancellationDeadline),
    wallClockFromLocalZStamp(raw.cancelBy),
  );
  if (deadline) booking.cancelDeadlineLocal = deadline;

  return booking;
}

/**
 * Maps an upstream status string.
 *
 * Defaults to `"confirmed"`: the endpoint is `get-app-upcoming-bookings`, so an
 * entry with no status is a live reservation, and reporting `"unknown"` would make
 * every booking look broken to an agent.
 */
export function mapBookingStatus(value: string | undefined): Booking["status"] {
  if (!value) return "confirmed";
  const normalised = value.trim().toLowerCase();
  if (/cancel/.test(normalised)) return "cancelled";
  if (/pending|approval|requested/.test(normalised)) return "pending";
  if (/success|confirm|book|active|upcoming|complete/.test(normalised)) return "confirmed";
  return "unknown";
}

/**
 * The local wall clock in `timeZone` for a true UTC instant.
 *
 * The inverse of {@link zonedWallClockToUtcIso}, used to fill the confirmation-email
 * copy in the upstream `MailData` block, which wants local times.
 */
export function utcIsoToZonedWallClock(
  utcStamp: string,
  timeZone: string | undefined,
  fallbackOffset?: string,
): string {
  const ms = Date.parse(utcStamp);
  if (Number.isNaN(ms)) return utcStamp;
  const minutes =
    (timeZone ? zoneOffsetMinutesAt(ms, timeZone) : undefined) ??
    (fallbackOffset ? offsetToMinutes(fallbackOffset) : undefined) ??
    0;
  return pseudoUtcMsToWallClock(ms + minutes * 60_000);
}
