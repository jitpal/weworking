/**
 * The mappers, and the time arithmetic they depend on.
 *
 * Three things here are worth more than the rest put together, because each is a bug
 * that has shipped in other WeWork clients: `padTime` on unpadded upstream hours,
 * `wallClockFromLocalZStamp` on the bookings list's fake `Z`, and
 * `zonedWallClockToUtcIso` getting DST right rather than trusting the fixed offset.
 */

import { describe, expect, it } from "vitest";
import { isAppError } from "../../src/errors";
import {
  arrayAt,
  assertOnGrid,
  bool,
  distanceKm,
  floorTimeToGrid,
  isOnGrid,
  mapBooking,
  mapBookingStatus,
  mapCities,
  mapCredits,
  mapLocation,
  mapLocations,
  mapWorkspace,
  normaliseOffset,
  normaliseUtcStamp,
  num,
  offsetFromMinutes,
  offsetToMinutes,
  padTime,
  str,
  utcIsoToZonedWallClock,
  wallClockFromLocalZStamp,
  zonedWallClockToUtcIso,
  zoneOffsetMinutesAt,
} from "../../src/wework/mappers";
import cityDetails from "../fixtures/wework/city-details.json";
import monthlyCredits from "../fixtures/wework/monthly-credits.json";
import {
  fixtureBookingRaw,
  fixtureLocationRaw,
  fixtureWorkspace,
  LOCATION_1,
  LOCATION_2,
  SPACE_1,
} from "./helpers";

describe("scalar coercion", () => {
  it("str trims, rejects empty, and stringifies numbers", () => {
    expect(str("  a  ")).toBe("a");
    expect(str("   ")).toBeUndefined();
    expect(str(7)).toBe("7");
    expect(str(null)).toBeUndefined();
  });

  it("num accepts the numeric strings upstream returns", () => {
    expect(num(2)).toBe(2);
    expect(num("2")).toBe(2);
    expect(num("2.5")).toBe(2.5);
    expect(num("")).toBeUndefined();
    expect(num("abc")).toBeUndefined();
    expect(num(Number.NaN)).toBeUndefined();
  });

  it("bool accepts strings and numbers", () => {
    expect(bool("true")).toBe(true);
    expect(bool("0")).toBe(false);
    expect(bool(1)).toBe(true);
    expect(bool("maybe")).toBeUndefined();
  });

  it("arrayAt finds the array under any of several keys", () => {
    expect(arrayAt({ b: [1] }, "a", "b")).toEqual([1]);
    expect(arrayAt([1, 2], "a")).toEqual([1, 2]);
    expect(arrayAt({ a: "nope" }, "a")).toEqual([]);
    expect(arrayAt(null, "a")).toEqual([]);
  });
});

describe("padTime", () => {
  it("zero-pads the unpadded values upstream actually returns", () => {
    expect(padTime("9:00")).toBe("09:00");
    expect(padTime("8:0")).toBe("08:00");
    expect(padTime("09:00:00")).toBe("09:00");
    expect(padTime("18:30")).toBe("18:30");
  });

  it("handles a 12-hour clock", () => {
    expect(padTime("7 PM")).toBe("19:00");
    expect(padTime("7:30 pm")).toBe("19:30");
    expect(padTime("12:00 AM")).toBe("00:00");
    expect(padTime("12:00 PM")).toBe("12:00");
  });

  it("normalises midnight-as-24 and rejects nonsense", () => {
    expect(padTime("24:00")).toBe("00:00");
    expect(padTime("")).toBeUndefined();
    expect(padTime("closed")).toBeUndefined();
    expect(padTime("25:61")).toBeUndefined();
  });
});

describe("offsets", () => {
  it("normalises every observed form to +HH:MM", () => {
    expect(normaliseOffset("+02:00")).toBe("+02:00");
    expect(normaliseOffset("+2:00")).toBe("+02:00");
    expect(normaliseOffset("02:00")).toBe("+02:00");
    expect(normaliseOffset("-05:30")).toBe("-05:30");
    expect(normaliseOffset("GMT+02:00")).toBe("+02:00");
    expect(normaliseOffset("Z")).toBe("+00:00");
    expect(normaliseOffset(120)).toBe("+02:00");
    expect(normaliseOffset(-330)).toBe("-05:30");
    expect(normaliseOffset("nonsense")).toBeUndefined();
  });

  it("round-trips through minutes", () => {
    expect(offsetToMinutes(offsetFromMinutes(-330))).toBe(-330);
    expect(offsetToMinutes("+05:45")).toBe(345);
    expect(offsetToMinutes("not an offset")).toBeUndefined();
  });
});

describe("wallClockFromLocalZStamp", () => {
  it("drops the bogus Z rather than converting", () => {
    // 09:00 at a Berlin location means 09:00 Berlin time, not 11:00.
    expect(wallClockFromLocalZStamp("2026-09-22T09:00:00Z")).toBe("2026-09-22T09:00:00");
    expect(wallClockFromLocalZStamp("2026-09-22T09:00:00.000Z")).toBe("2026-09-22T09:00:00");
    expect(wallClockFromLocalZStamp("2026-09-22T09:00Z")).toBe("2026-09-22T09:00:00");
    expect(wallClockFromLocalZStamp("2026-09-22 09:00:00")).toBe("2026-09-22T09:00:00");
  });

  it("returns undefined for anything else", () => {
    expect(wallClockFromLocalZStamp("tomorrow")).toBeUndefined();
    expect(wallClockFromLocalZStamp(null)).toBeUndefined();
  });
});

describe("zonedWallClockToUtcIso", () => {
  it("uses the IANA zone, not the fixed offset, so DST is right", () => {
    // Berlin is +02:00 in September (CEST) and +01:00 in December (CET). The
    // upstream `timezoneOffset` would be stale for one of them.
    expect(zonedWallClockToUtcIso("2026-09-21T09:00:00", "Europe/Berlin", "+02:00")).toBe(
      "2026-09-21T07:00:00Z",
    );
    expect(zonedWallClockToUtcIso("2026-12-21T09:00:00", "Europe/Berlin", "+02:00")).toBe(
      "2026-12-21T08:00:00Z",
    );
  });

  it("handles a half-hour zone and the southern hemisphere", () => {
    expect(zonedWallClockToUtcIso("2026-09-21T09:00:00", "Asia/Kolkata")).toBe(
      "2026-09-21T03:30:00Z",
    );
    expect(zonedWallClockToUtcIso("2026-09-21T09:00:00", "Australia/Sydney")).toBe(
      "2026-09-20T23:00:00Z",
    );
  });

  it("falls back to the fixed offset for an unknown zone", () => {
    expect(zonedWallClockToUtcIso("2026-09-21T09:00:00", "Not/AZone", "+05:30")).toBe(
      "2026-09-21T03:30:00Z",
    );
    expect(zonedWallClockToUtcIso("2026-09-21T09:00:00", undefined)).toBe("2026-09-21T09:00:00Z");
  });

  it("throws VALIDATION on a malformed wall clock", () => {
    try {
      zonedWallClockToUtcIso("not a time", "Europe/Berlin");
      throw new Error("expected a throw");
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("VALIDATION");
    }
  });

  it("round-trips with utcIsoToZonedWallClock", () => {
    const utc = zonedWallClockToUtcIso("2026-09-21T09:30:00", "America/New_York");
    expect(utc).toBe("2026-09-21T13:30:00Z");
    expect(utcIsoToZonedWallClock(utc, "America/New_York")).toBe("2026-09-21T09:30:00");
  });

  it("zoneOffsetMinutesAt reports the offset in force at an instant", () => {
    expect(zoneOffsetMinutesAt(Date.parse("2026-09-21T12:00:00Z"), "Europe/Berlin")).toBe(120);
    expect(zoneOffsetMinutesAt(Date.parse("2026-12-21T12:00:00Z"), "Europe/Berlin")).toBe(60);
    expect(zoneOffsetMinutesAt(Date.parse("2026-09-21T12:00:00Z"), "Not/AZone")).toBeUndefined();
  });
});

describe("the 30-minute grid", () => {
  it("recognises aligned and misaligned stamps", () => {
    expect(isOnGrid("2026-09-21T07:00:00Z")).toBe(true);
    expect(isOnGrid("2026-09-21T07:30:00Z")).toBe(true);
    expect(isOnGrid("2026-09-21T07:15:00Z")).toBe(false);
    expect(isOnGrid("2026-09-21T07:00:30Z")).toBe(false);
    expect(isOnGrid("2026-09-21T07:00:00.500Z")).toBe(false);
  });

  it("floors a time to the grid", () => {
    expect(floorTimeToGrid("18:30")).toBe("18:30");
    expect(floorTimeToGrid("18:45")).toBe("18:30");
    expect(floorTimeToGrid("09:29")).toBe("09:00");
    expect(floorTimeToGrid("23:59")).toBe("23:30");
  });

  it("assertOnGrid throws VALIDATION naming the field", () => {
    expect(() => assertOnGrid("2026-09-21T07:00:00Z", "startUtc")).not.toThrow();
    try {
      assertOnGrid("2026-09-21T07:15:00Z", "startUtc");
      throw new Error("expected a throw");
    } catch (error) {
      if (!isAppError(error)) throw error;
      expect(error.code).toBe("VALIDATION");
      expect(error.message).toContain("startUtc");
      expect(error.hint).toBeTypeOf("string");
    }
  });

  it("normaliseUtcStamp collapses to seconds precision", () => {
    expect(normaliseUtcStamp("2026-09-21T07:00:00.000Z")).toBe("2026-09-21T07:00:00Z");
    expect(normaliseUtcStamp("2026-09-21T07:00Z")).toBe("2026-09-21T07:00:00Z");
    expect(normaliseUtcStamp("nope")).toBeUndefined();
  });
});

describe("distanceKm", () => {
  it("computes a plausible great-circle distance", () => {
    // Brandenburg Gate to Alexanderplatz is about 2.6 km.
    const km = distanceKm({ lat: 52.5163, lng: 13.3777 }, { lat: 52.5219, lng: 13.4132 });
    expect(km).toBeGreaterThan(2.3);
    expect(km).toBeLessThan(2.9);
    expect(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
  });
});

describe("mapLocation", () => {
  const l1 = fixtureLocationRaw(0);
  const l2 = fixtureLocationRaw(1);

  it("maps the full geo record, padding the opening hours", () => {
    expect(mapLocation(l1)).toEqual({
      locationId: LOCATION_1,
      name: "Fake Tower",
      address: "100 Example Street, Floor 4",
      city: "Berlin",
      country: "DE",
      timezone: "Europe/Berlin",
      accountType: 2,
      timezoneOffset: "+02:00",
      latitude: 52.52,
      longitude: 13.405,
      // "9:00" upstream.
      openTime: "09:00",
      closeTime: "18:30",
    });
  });

  it("pads a pathologically unpadded openTime", () => {
    // "8:0" upstream.
    expect(mapLocation(l2)?.openTime).toBe("08:00");
  });

  it("prefers the ISO country code over the country name", () => {
    expect(mapLocation(l1)?.country).toBe("DE");
    expect(mapLocation({ uuid: "x", country: "Portugal" })?.country).toBe("Portugal");
  });

  it("computes distanceKm against a search origin", () => {
    const mapped = mapLocation(l2, { origin: { lat: 52.52, lng: 13.405 } });
    expect(mapped?.distanceKm).toBeGreaterThan(2.5);
    expect(mapped?.distanceKm).toBeLessThan(4);
  });

  it("accepts a flat address string", () => {
    expect(mapLocation({ uuid: "x", address: "1 Flat Street" })?.address).toBe("1 Flat Street");
  });

  it("returns undefined without an id, and defaults the rest", () => {
    expect(mapLocation({ name: "No id" })).toBeUndefined();
    expect(mapLocation(undefined)).toBeUndefined();
    expect(mapLocation({ uuid: "x" })).toEqual({
      locationId: "x",
      name: "x",
      address: "",
      city: "",
      country: "",
      timezone: "",
      accountType: 0,
      timezoneOffset: "+00:00",
    });
  });

  it("mapLocations drops unusable entries", () => {
    expect(mapLocations([{ uuid: "a" }, { name: "no id" }, "junk"])).toHaveLength(1);
  });
});

describe("mapCities", () => {
  it("de-duplicates case-insensitively, keeping upstream order and casing", () => {
    expect(mapCities(cityDetails.cityDetails)).toEqual(["Berlin", "Lisbon"]);
  });

  it("accepts plain strings", () => {
    expect(mapCities(["Berlin", "berlin", "Lisbon"])).toEqual(["Berlin", "Lisbon"]);
  });
});

describe("mapWorkspace", () => {
  const w1 = fixtureWorkspace(0);
  const w2 = fixtureWorkspace(1);
  const w3 = fixtureWorkspace(2);

  it("maps the accountType 2 workspace, filling the window from the opening hours", () => {
    const mapped = mapWorkspace(w1, { date: "2026-09-21" });
    expect(mapped).toMatchObject({
      spaceId: SPACE_1,
      inventoryUuid: "cccc3333-0000-4000-8000-000000000001",
      kubeId: "kube-space-0001",
      spaceName: "Shared Workspace, Floor 4",
      spaceType: "desk",
      capacity: 1,
      seatsAvailable: 5,
      seatsTotal: 12,
      credits: 10,
      date: "2026-09-21",
      startLocal: "2026-09-21T09:00:00",
      endLocal: "2026-09-21T18:30:00",
      startUtc: "2026-09-21T07:00:00Z",
      endUtc: "2026-09-21T16:30:00Z",
      timezone: "Europe/Berlin",
    });
    expect(mapped?.location.accountType).toBe(2);
  });

  it("maps the accountType 4 workspace with no KubeId", () => {
    const mapped = mapWorkspace(w2, { date: "2026-09-21" });
    expect(mapped?.kubeId).toBeUndefined();
    expect(mapped?.inventoryUuid).toBe("cccc3333-0000-4000-8000-000000000002");
    expect(mapped?.location.accountType).toBe(4);
    // "8:0" -> 08:00.
    expect(mapped?.startLocal).toBe("2026-09-21T08:00:00");
    expect(mapped?.startUtc).toBe("2026-09-21T06:00:00Z");
  });

  it("keeps a fully booked workspace, reporting zero seats", () => {
    expect(mapWorkspace(w3, { date: "2026-09-21" })?.seatsAvailable).toBe(0);
  });

  it("narrows the window to the requested times, inside the opening hours", () => {
    const mapped = mapWorkspace(w1, {
      date: "2026-09-21",
      startTime: "10:00",
      endTime: "14:00",
    });
    expect(mapped?.startLocal).toBe("2026-09-21T10:00:00");
    expect(mapped?.endLocal).toBe("2026-09-21T14:00:00");
  });

  it("never widens the window beyond the opening hours", () => {
    const mapped = mapWorkspace(w1, {
      date: "2026-09-21",
      startTime: "06:00",
      endTime: "23:00",
    });
    expect(mapped?.startLocal).toBe("2026-09-21T09:00:00");
    expect(mapped?.endLocal).toBe("2026-09-21T18:30:00");
  });

  it("floors a requested off-grid time", () => {
    expect(
      mapWorkspace(w1, { date: "2026-09-21", startTime: "10:20", endTime: "14:45" })?.startLocal,
    ).toBe("2026-09-21T10:00:00");
  });

  it("defaults to the whole day when nothing reports opening hours", () => {
    const bare = { uuid: "w", location: { uuid: "l", timeZone: "Europe/Berlin" } };
    const mapped = mapWorkspace(bare, { date: "2026-09-21" });
    expect(mapped?.startLocal).toBe("2026-09-21T00:00:00");
    expect(mapped?.endLocal).toBe("2026-09-21T23:30:00");
  });

  it("fills a partial nested location from a previously-seen full one", () => {
    const fallback = mapLocation(fixtureLocationRaw(0));
    const mapped = mapWorkspace(w1, { date: "2026-09-21", fallbackLocation: fallback });
    // The nested location in get-spaces has no `name`.
    expect(mapped?.location.name).toBe("Fake Tower");
    expect(mapped?.location.address).toBe("100 Example Street, Floor 4");
    expect(mapped?.location.accountType).toBe(2);
  });

  it("returns undefined without a workspace id or a location", () => {
    expect(mapWorkspace({ location: { uuid: "l" } }, { date: "2026-09-21" })).toBeUndefined();
    expect(mapWorkspace({ uuid: "w" }, { date: "2026-09-21" })).toBeUndefined();
  });
});

describe("mapProfile and mapCredits", () => {
  it("maps the credit allowance and the period", () => {
    expect(mapCredits(monthlyCredits, { start: "2026-09-01", end: "2026-09-30" })).toEqual({
      remaining: 42,
      total: 60,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
    });
  });

  it("derives a missing total from remaining plus used", () => {
    expect(
      mapCredits({ remainingCredits: 10, usedCredits: 5 }, { start: "a", end: "b" }),
    ).toMatchObject({ remaining: 10, total: 15 });
  });

  it("derives a missing remaining from total minus used", () => {
    expect(
      mapCredits({ totalCredits: 60, usedCredits: 18 }, { start: "a", end: "b" }),
    ).toMatchObject({ remaining: 42, total: 60 });
  });

  it("returns undefined for an account with no credit allowance", () => {
    expect(mapCredits({}, { start: "a", end: "b" })).toBeUndefined();
    expect(
      mapCredits({ responseStatus: { type: "success" } }, { start: "a", end: "b" }),
    ).toBeUndefined();
  });
});

describe("mapBooking", () => {
  const b1 = fixtureBookingRaw(0);

  it("re-anchors the local-wall-clock-stamped-Z times without converting them", () => {
    const booking = mapBooking(b1);
    // Upstream said "2026-09-22T09:00:00Z" for a Berlin desk. A naive conversion
    // would produce 11:00; the right answer is 09:00 local.
    expect(booking?.startLocal).toBe("2026-09-22T09:00:00");
    expect(booking?.endLocal).toBe("2026-09-22T17:00:00");
    expect(booking?.date).toBe("2026-09-22");
    expect(booking?.timezone).toBe("Europe/Berlin");
    expect(booking?.cancelDeadlineLocal).toBe("2026-09-22T08:00:00");
  });

  it("maps the identity, status and credits, and keeps the raw item for cancel", () => {
    const booking = mapBooking(b1);
    expect(booking).toMatchObject({
      bookingId: "dddd4444-0000-4000-8000-000000000001",
      reservationId: "RSV-FAKE-0001",
      locationId: LOCATION_1,
      locationName: "Fake Tower",
      status: "confirmed",
      credits: 10,
    });
    expect(booking?.raw).toBe(b1);
  });

  it("maps the second fixture booking at the other location", () => {
    const booking = mapBooking(fixtureBookingRaw(1));
    expect(booking?.locationId).toBe(LOCATION_2);
    expect(booking?.startLocal).toBe("2026-09-25T08:00:00");
    expect(booking?.credits).toBe(8);
  });

  it("returns undefined without an id or without times", () => {
    expect(mapBooking({ startTime: "2026-09-22T09:00:00Z" })).toBeUndefined();
    expect(mapBooking({ uuid: "x" })).toBeUndefined();
  });

  it("maps status strings, defaulting an absent status to confirmed", () => {
    expect(mapBookingStatus(undefined)).toBe("confirmed");
    expect(mapBookingStatus("Booked")).toBe("confirmed");
    expect(mapBookingStatus("BookingSuccess")).toBe("confirmed");
    expect(mapBookingStatus("Cancelled")).toBe("cancelled");
    expect(mapBookingStatus("Canceled")).toBe("cancelled");
    expect(mapBookingStatus("PendingApproval")).toBe("pending");
    expect(mapBookingStatus("something else")).toBe("unknown");
  });
});
