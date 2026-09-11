/**
 * The booking service: the orchestration rules, end to end, over fake collaborators.
 *
 * The cases here are the ones that protect the user's credits and the user's trust —
 * a forged or stale quote, a price that moved between search and book, a cap that is
 * already spent, a retry that must not double-book, a dry run that must touch nothing,
 * and the rollback that has to happen when the upstream call fails half-way.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SessionRpc, WeWorkApi } from "../../src/core/booking-service";
import { signQuote } from "../../src/core/quote";
import type { QuotePayload } from "../../src/core/types";
import { AppError, isAppError } from "../../src/errors";
import type { WeWorkSession } from "../../src/session/do";
import type { WeWorkApi as ClientWeWorkApi } from "../../src/wework/client";
import {
  createHarness,
  firstQuote,
  makeBooking,
  makeLocation,
  makeSpace,
  NOW_MS,
  READ_WRITE_ACTOR,
  TEST_QUOTE_KEY,
} from "./fakes";

/**
 * Compile-time guard: the `WeWorkApi` this layer declares locally and
 * the one `src/wework/client.ts` exports must stay mutually assignable, and a real
 * `DurableObjectStub<WeWorkSession>` must satisfy `SessionRpc`.
 *
 * These are the two seams `src/index.ts` wires together. Declaring them structurally keeps
 * `src/core` free of any dependency on the transport and session layers; this type is what
 * turns a drift between the declarations into a typecheck failure rather than a runtime
 * surprise on the first real booking. It is asserted in the test at the bottom of this file.
 */
type ContractCompatibility = [
  ClientWeWorkApi extends WeWorkApi ? true : never,
  WeWorkApi extends ClientWeWorkApi ? true : never,
  DurableObjectStub<WeWorkSession> extends SessionRpc ? true : never,
];

/** The code of the `AppError` a promise rejects with; fails the test on anything else. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (!isAppError(err)) throw err;
    expect(err.hint, "every service error must carry an agent-facing hint").toBeTypeOf("string");
    return err.code;
  }
  throw new Error("expected the call to reject");
}

const DATE = "2026-09-21";

describe("listLocations", () => {
  it("searches by city", async () => {
    const harness = createHarness();
    const locations = await harness.service.listLocations({ city: "London" });
    expect(locations.map((l) => l.locationId)).toEqual(["loc-poultry"]);
    expect(harness.api.calls.map((c) => c.method)).toEqual(["listLocationsByCity"]);
  });

  it("searches by coordinates, passing the radius through", async () => {
    const harness = createHarness();
    const locations = await harness.service.listLocations({ lat: 51.5, lng: -0.09, radiusKm: 2 });
    expect(locations[0]?.distanceKm).toBe(0.4);
    expect(harness.api.calls[0]).toEqual({
      method: "listLocationsByGeo",
      args: { lat: 51.5, lng: -0.09, radiusKm: 2 },
    });
  });

  it("rejects a half-specified geographic search", async () => {
    const harness = createHarness();
    expect(await codeOf(harness.service.listLocations({ lat: 51.5 }))).toBe("VALIDATION");
  });

  it("resolves free text to a city, then filters that city's buildings", async () => {
    const harness = createHarness({
      apiScript: {
        cities: ["London", "New York"],
        locationsByCity: {
          London: [
            makeLocation(),
            makeLocation({ locationId: "loc-spitalfields", name: "Spitalfields" }),
          ],
        },
      },
    });
    const locations = await harness.service.listLocations({ query: "London" });
    expect(locations).toHaveLength(2);
    expect(harness.api.calls.map((c) => c.method)).toEqual(["listCities", "listLocationsByCity"]);
  });

  it("filters by name when the query names a building rather than a city", async () => {
    const harness = createHarness({
      apiScript: {
        cities: ["London"],
        locationsByCity: {
          London: [makeLocation(), makeLocation({ locationId: "loc-2", name: "Spitalfields" })],
        },
      },
    });
    // "london spitalfields" resolves to the city, then the name filter narrows it.
    const byCity = await harness.service.listLocations({ city: "London", query: "spitalfields" });
    expect(byCity.map((l) => l.locationId)).toEqual(["loc-2"]);
  });

  it("reports NOT_FOUND when no city matches the free text", async () => {
    const harness = createHarness({ apiScript: { cities: ["London"] } });
    expect(await codeOf(harness.service.listLocations({ query: "Atlantis" }))).toBe("NOT_FOUND");
  });

  it("requires at least one search parameter", async () => {
    const harness = createHarness();
    expect(await codeOf(harness.service.listLocations({}))).toBe("VALIDATION");
  });

  it("applies the limit", async () => {
    const harness = createHarness({
      apiScript: {
        locationsByCity: {
          London: [
            makeLocation(),
            makeLocation({ locationId: "b" }),
            makeLocation({ locationId: "c" }),
          ],
        },
      },
    });
    await expect(harness.service.listLocations({ city: "London", limit: 2 })).resolves.toHaveLength(
      2,
    );
  });
});

describe("searchAvailability", () => {
  it("searches nearby buildings by lat/lng, nearest first, with distances on each result", async () => {
    const near = makeLocation({ locationId: "loc-near", name: "Near", distanceKm: 0.4 });
    const far = makeLocation({ locationId: "loc-far", name: "Far", distanceKm: 2.1 });
    const harness = createHarness({
      apiScript: {
        locationsByGeo: [far, near],
        spaces: [
          makeSpace({ location: far, credits: 1 }),
          makeSpace({ location: near, credits: 2 }),
        ],
      },
    });
    const results = await harness.service.searchAvailability({
      lat: 51.51,
      lng: -0.09,
      radiusKm: 3,
      date: DATE,
    });
    expect(harness.api.calls[0]).toMatchObject({
      method: "listLocationsByGeo",
      args: { lat: 51.51, lng: -0.09, radiusKm: 3 },
    });
    expect(results.map((r) => r.location.locationId)).toEqual(["loc-near", "loc-far"]);
    expect(results[0]?.location.distanceKm).toBe(0.4);
  });

  it("uses the agent-supplied timezone for a bare location_id", async () => {
    const harness = createHarness();
    await harness.service.searchAvailability({
      locationId: "loc-poultry",
      timezone: "America/New_York",
      date: "2026-11-10",
    });
    const call = harness.api.calls.find((c) => c.method === "getSpaces");
    expect(call?.args).toMatchObject({ locationOffset: "-05:00" });
  });

  it("rejects mixing location modes and half a coordinate", async () => {
    const harness = createHarness();
    expect(
      await codeOf(
        harness.service.searchAvailability({ city: "London", lat: 1, lng: 2, date: DATE }),
      ),
    ).toBe("VALIDATION");
    expect(await codeOf(harness.service.searchAvailability({ lat: 1, date: DATE }))).toBe(
      "VALIDATION",
    );
  });

  it("prices pay-as-you-go spaces through the quote call in the building's currency", async () => {
    // Live-verified against an "On Demand" account: get-spaces says 0 credits and
    // lists a pre-tax day rate; the quote returns the tax-inclusive total.
    const harness = createHarness({
      apiScript: {
        spaces: [
          makeSpace({
            credits: 0,
            cashPrice: { amount: 70, currency: "GBP" },
            location: makeLocation({ currency: "GBP" }),
          }),
        ],
        price: { credits: 0, creditRatio: 20, amount: 84, currency: "GBP" },
      },
    });
    const results = await harness.service.searchAvailability({
      locationId: "loc-poultry",
      date: DATE,
    });
    const result = results[0];
    if (!result) throw new Error("no result");
    expect(result.cashPrice).toEqual({ amount: 84, currency: "GBP" });
    expect(result.credits).toBe(0);
    expect(result.summary).toContain("£84.00");
    expect(harness.api.calls.find((c) => c.method === "quote")?.args).toMatchObject({
      currency: "GBP",
    });
    const payload = JSON.parse(atob(result.quote.split(".")[0] as string)) as QuotePayload;
    expect(payload).toMatchObject({ amount: 84, currency: "GBP" });
  });

  it("still returns the option when the cash quote fails, marked price unavailable", async () => {
    const harness = createHarness({
      apiScript: {
        spaces: [makeSpace({ credits: 0, location: makeLocation({ currency: "GBP" }) })],
        fail: { quote: new AppError("UPSTREAM_ERROR", "quote down") },
      },
    });
    const results = await harness.service.searchAvailability({
      locationId: "loc-poultry",
      date: DATE,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.summary).toContain("price unavailable");
  });

  it("does not call the quote endpoint for credit-priced spaces", async () => {
    const harness = createHarness();
    await harness.service.searchAvailability({ locationId: "loc-poultry", date: DATE });
    expect(harness.api.calls.some((c) => c.method === "quote")).toBe(false);
  });

  it("returns a signed quote and a local-time summary per option", async () => {
    const harness = createHarness();
    const results = await harness.service.searchAvailability({
      locationId: "loc-poultry",
      date: DATE,
      startTime: "09:00",
      endTime: "17:00",
    });

    expect(results).toHaveLength(1);
    const result = results[0];
    if (!result) throw new Error("no result");
    expect(result.startLocal).toBe("2026-09-21T09:00:00");
    expect(result.startUtc).toBe("2026-09-21T08:00:00Z");
    expect(result.endUtc).toBe("2026-09-21T16:00:00Z");
    expect(result.summary).toBe(
      "Desk at 1 Poultry, London on 2026-09-21 09:00-17:00 (Europe/London), 1 credits, 12 seats left",
    );
    expect(result.quote.split(".")).toHaveLength(2);
  });

  it("bakes the resolved booking space id, the offset and the expiry into the quote", async () => {
    const harness = createHarness();
    const quote = await firstQuote(harness);
    const payload = JSON.parse(atob(quote.split(".")[0] as string)) as QuotePayload;
    expect(payload).toMatchObject({
      v: 1,
      accountId: "default",
      bookingSpaceId: "kube-1",
      tzOffset: "+01:00",
      timezone: "Europe/London",
      credits: 1,
    });
    expect(payload.exp).toBe(Math.floor(NOW_MS / 1000) + 600);
  });

  it("snaps requested times onto the 30-minute grid", async () => {
    const harness = createHarness();
    const results = await harness.service.searchAvailability({
      locationId: "loc-poultry",
      date: DATE,
      startTime: "09:11",
      endTime: "16:46",
    });
    expect(results[0]?.startLocal).toBe("2026-09-21T09:00:00");
    expect(results[0]?.endLocal).toBe("2026-09-21T17:00:00");
  });

  it("falls back to the building's own window when no times are given", async () => {
    const harness = createHarness();
    const results = await harness.service.searchAvailability({
      locationId: "loc-poultry",
      date: DATE,
    });
    expect(results[0]?.startLocal).toBe("2026-09-21T08:00:00");
    expect(results[0]?.endUtc).toBe("2026-09-21T17:00:00Z");
  });

  it("fans out across a city, capped at ten buildings", async () => {
    const locations = Array.from({ length: 14 }, (_, index) =>
      makeLocation({ locationId: `loc-${index}` }),
    );
    const harness = createHarness({
      apiScript: {
        locationsByCity: { London: locations },
        spaces: (args) => args.locationIds.map((id) => makeSpace({ spaceId: `space-${id}` })),
      },
    });
    const results = await harness.service.searchAvailability({ city: "London", date: DATE });
    expect(results).toHaveLength(10);
  });

  it("prices at most `limit` spaces, however many the buildings returned", async () => {
    // Every space here is cash-priced, so each one the loop reaches costs a
    // resolveBookingSpaceId *and* a quote subrequest.
    const spaces = Array.from({ length: 40 }, (_, index) =>
      makeSpace({
        spaceId: `space-${index}`,
        credits: 0,
        seatsAvailable: index + 1,
        location: makeLocation({ currency: "GBP" }),
      }),
    );
    const harness = createHarness({
      apiScript: { spaces, price: { credits: 0, creditRatio: 20, amount: 84, currency: "GBP" } },
    });

    const results = await harness.service.searchAvailability({
      locationId: "loc-poultry",
      date: DATE,
      limit: 3,
    });

    expect(results).toHaveLength(3);
    expect(harness.api.calls.filter((c) => c.method === "quote")).toHaveLength(3);
    expect(harness.api.calls.filter((c) => c.method === "resolveBookingSpaceId")).toHaveLength(3);
    // The three kept are the roomiest, not the first three upstream listed.
    expect(results.map((r) => r.spaceId).sort()).toEqual(["space-37", "space-38", "space-39"]);
  });

  it("keeps the fan-out bounded by the default limit too", async () => {
    const spaces = Array.from({ length: 50 }, (_, index) =>
      makeSpace({ spaceId: `space-${index}`, credits: 0, seatsAvailable: index + 1 }),
    );
    const harness = createHarness({ apiScript: { spaces } });
    const results = await harness.service.searchAvailability({
      locationId: "loc-poultry",
      date: DATE,
    });
    expect(results).toHaveLength(20);
    expect(harness.api.calls.filter((c) => c.method === "resolveBookingSpaceId")).toHaveLength(20);
  });

  it("hides sold-out spaces", async () => {
    const harness = createHarness({
      apiScript: { spaces: [makeSpace({ seatsAvailable: 0 }), makeSpace({ spaceId: "s2" })] },
    });
    const results = await harness.service.searchAvailability({
      locationId: "loc-poultry",
      date: DATE,
    });
    expect(results.map((r) => r.spaceId)).toEqual(["s2"]);
  });

  it("orders cheapest first, then by seats left", async () => {
    const harness = createHarness({
      apiScript: {
        spaces: [
          makeSpace({ spaceId: "pricey", credits: 3 }),
          makeSpace({ spaceId: "cheap-busy", credits: 1, seatsAvailable: 2 }),
          makeSpace({ spaceId: "cheap-empty", credits: 1, seatsAvailable: 20 }),
        ],
      },
    });
    const results = await harness.service.searchAvailability({
      locationId: "loc-poultry",
      date: DATE,
    });
    expect(results.map((r) => r.spaceId)).toEqual(["cheap-empty", "cheap-busy", "pricey"]);
  });

  it("never prices a search upstream — one get-spaces, no quote calls", async () => {
    const harness = createHarness();
    await harness.service.searchAvailability({ locationId: "loc-poultry", date: DATE });
    expect(harness.api.calls.filter((c) => c.method === "quote")).toHaveLength(0);
    expect(harness.api.calls.filter((c) => c.method === "getSpaces")).toHaveLength(1);
  });

  it("refuses meeting rooms with a pointer to the capture guide", async () => {
    const harness = createHarness();
    try {
      await harness.service.searchAvailability({
        locationId: "loc-poultry",
        date: DATE,
        spaceType: "meeting_room",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("UNSUPPORTED_SPACE_TYPE");
      expect(isAppError(err) && err.hint).toContain("docs/CAPTURE_GUIDE.md");
    }
  });

  it.each([
    ["a malformed date", { locationId: "loc-poultry", date: "21/09/2026" }],
    ["an impossible date", { locationId: "loc-poultry", date: "2026-02-30" }],
    ["a past date", { locationId: "loc-poultry", date: "2026-09-01" }],
    ["neither location nor city", { date: DATE }],
    ["both location and city", { locationId: "loc-poultry", city: "London", date: DATE }],
    [
      "an inverted window",
      { locationId: "loc-poultry", date: DATE, startTime: "17:00", endTime: "09:00" },
    ],
  ])("rejects %s", async (_label, args) => {
    const harness = createHarness();
    expect(await codeOf(harness.service.searchAvailability(args))).toBe("VALIDATION");
  });

  it("allows today in the building's zone even when UTC has moved on", async () => {
    // 23:30 UTC on the 21st is still the 21st in New York.
    const harness = createHarness({
      nowMs: Date.parse("2026-09-21T23:30:00Z"),
      apiScript: {
        locationsByCity: {
          "New York": [makeLocation({ timezone: "America/New_York", city: "New York" })],
        },
        spaces: [
          makeSpace({
            location: makeLocation({ timezone: "America/New_York", city: "New York" }),
            timezone: "America/New_York",
          }),
        ],
      },
    });
    await expect(
      harness.service.searchAvailability({ city: "New York", date: "2026-09-21" }),
    ).resolves.toHaveLength(1);
  });

  it("reports NOT_FOUND for a city with no buildings", async () => {
    const harness = createHarness({ apiScript: { locationsByCity: {} } });
    expect(await codeOf(harness.service.searchAvailability({ city: "Narnia", date: DATE }))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("createBooking", () => {
  it("books the quoted slot: reserve, re-price, book, confirm, audit", async () => {
    const harness = createHarness();
    const quote = await firstQuote(harness);
    const result = await harness.service.createBooking(
      { quote, idempotencyKey: "key-1" },
      READ_WRITE_ACTOR,
    );

    expect(result.dryRun).toBe(false);
    expect(result.creditsCharged).toBe(1);
    expect(result.booking).toMatchObject({
      bookingId: "RES-NEW",
      status: "confirmed",
      locationName: "1 Poultry",
      startLocal: "2026-09-21T08:00:00",
      timezone: "Europe/London",
    });
    expect(result.capsRemaining).toEqual({ day: 0, week: 4 });
    expect(result.summary).toContain("1 Poultry, London");
    expect(result.summary).toContain("credit");

    // The order of upstream calls is the safety property: price, then book.
    expect(harness.api.calls.map((c) => c.method).slice(-2)).toEqual(["quote", "book"]);
    expect(harness.session.confirmed).toEqual([{ bookingKey: "book:key-1", bookingId: "RES-NEW" }]);
    expect(harness.session.released).toEqual([]);
    expect(harness.session.audits).toContainEqual({
      tool: "create_booking",
      outcome: "ok",
      dryRun: false,
    });
  });

  it("refuses a forged quote without calling upstream at all", async () => {
    const harness = createHarness();
    const quote = await firstQuote(harness);
    const callsBefore = harness.api.calls.length;
    const [body] = quote.split(".") as [string, string];
    const forged = `${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

    expect(await codeOf(harness.service.createBooking({ quote: forged }, READ_WRITE_ACTOR))).toBe(
      "QUOTE_INVALID",
    );
    expect(harness.api.calls).toHaveLength(callsBefore);
    expect(harness.session.reserved.size).toBe(0);
  });

  it("refuses an expired quote", async () => {
    const harness = createHarness();
    const stale: QuotePayload = {
      v: 1,
      accountId: "default",
      locationId: "loc-poultry",
      spaceId: "space-1",
      wwSpaceId: "space-1",
      bookingSpaceId: "kube-1",
      accountType: 2,
      date: DATE,
      startUtc: "2026-09-21T08:00:00Z",
      endUtc: "2026-09-21T16:00:00Z",
      credits: 1,
      timezone: "Europe/London",
      tzOffset: "+01:00",
      locationName: "1 Poultry",
      address: "1 Poultry",
      city: "London",
      country: "GBR",
      exp: Math.floor(NOW_MS / 1000) - 1,
    };
    const quote = await signQuote(stale, TEST_QUOTE_KEY);
    expect(await codeOf(harness.service.createBooking({ quote }, READ_WRITE_ACTOR))).toBe(
      "QUOTE_EXPIRED",
    );
  });

  it("refuses a quote minted for another account", async () => {
    const harness = createHarness();
    const quote = await firstQuote(harness);
    expect(
      await codeOf(
        harness.service.createBooking({ quote }, { ...READ_WRITE_ACTOR, accountId: "tenant-b" }),
      ),
    ).toBe("QUOTE_INVALID");
  });

  it("refuses to book when the price moved, and releases the reservation", async () => {
    const harness = createHarness({ apiScript: { price: { credits: 2, creditRatio: 1 } } });
    const quote = await firstQuote(harness);

    try {
      await harness.service.createBooking({ quote, idempotencyKey: "k" }, READ_WRITE_ACTOR);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("BOOKING_REFUSED");
      expect(isAppError(err) && err.hint).toBe("price changed, search again");
    }

    expect(harness.api.calls.filter((c) => c.method === "book")).toHaveLength(0);
    expect(harness.session.released).toEqual(["book:k"]);
    expect(harness.session.usedToday()).toBe(0);
    expect(harness.session.audits).toContainEqual({
      tool: "create_booking",
      outcome: "error",
      error: "BOOKING_REFUSED",
      dryRun: false,
    });
  });

  it("books when the price is unchanged to the credit", async () => {
    const harness = createHarness({ apiScript: { price: { credits: 1, creditRatio: 0.5 } } });
    const quote = await firstQuote(harness);
    await expect(harness.service.createBooking({ quote }, READ_WRITE_ACTOR)).resolves.toMatchObject(
      { creditsCharged: 1 },
    );
    // The authoritative creditRatio from the re-price is what goes upstream.
    expect(harness.api.calls.at(-1)).toEqual({
      method: "book",
      args: { spaceId: "space-1", creditRatio: 0.5 },
    });
  });

  it("reports CAP_EXCEEDED with the remaining allowance in details", async () => {
    const harness = createHarness({ sessionScript: { usedToday: 1, maxPerDay: 1 } });
    const quote = await firstQuote(harness);
    try {
      await harness.service.createBooking({ quote }, READ_WRITE_ACTOR);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("CAP_EXCEEDED");
      expect(isAppError(err) && err.details).toEqual({ capsRemaining: { day: 0, week: 5 } });
      expect(isAppError(err) && err.hint).toContain("Cancelled bookings still count");
    }
    expect(harness.api.calls.filter((c) => c.method === "book")).toHaveLength(0);
    expect(harness.session.audits).toContainEqual({
      tool: "create_booking",
      outcome: "denied",
      error: "CAP_EXCEEDED",
      dryRun: false,
    });
  });

  it("enforces MAX_CREDITS_PER_BOOKING before reserving anything", async () => {
    const harness = createHarness({
      config: { maxCreditsPerBooking: 1 },
      apiScript: { spaces: [makeSpace({ credits: 4 })] },
    });
    const quote = await firstQuote(harness);
    expect(await codeOf(harness.service.createBooking({ quote }, READ_WRITE_ACTOR))).toBe(
      "CAP_EXCEEDED",
    );
    expect(harness.session.reserved.size).toBe(0);
  });

  it("enforces MAX_CASH_PER_BOOKING on a pay-as-you-go quote", async () => {
    // A cash booking costs no credits, so the credit cap never sees it.
    const harness = createHarness({
      config: { maxCashPerBooking: 50, maxCreditsPerBooking: 0 },
      apiScript: {
        spaces: [makeSpace({ credits: 0, location: makeLocation({ currency: "GBP" }) })],
        price: { credits: 0, creditRatio: 20, amount: 84, currency: "GBP" },
      },
    });
    const quote = await firstQuote(harness);
    try {
      await harness.service.createBooking({ quote }, READ_WRITE_ACTOR);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.code).toBe("CAP_EXCEEDED");
      expect(isAppError(err) && err.message).toContain("MAX_CASH_PER_BOOKING");
      expect(isAppError(err) && err.message).toContain("£84.00");
      expect(isAppError(err) && err.details).toEqual({ maxCashPerBooking: 50, amount: 84 });
    }
    expect(harness.session.reserved.size).toBe(0);
    expect(harness.api.calls.filter((c) => c.method === "book")).toHaveLength(0);
    expect(harness.session.audits).toContainEqual({
      tool: "create_booking",
      outcome: "denied",
      error: "CAP_EXCEEDED",
      dryRun: false,
    });
  });

  it("refuses every cash booking at the default cap of zero", async () => {
    const harness = createHarness({
      config: { maxCashPerBooking: 0 },
      apiScript: {
        spaces: [makeSpace({ credits: 0, location: makeLocation({ currency: "GBP" }) })],
        price: { credits: 0, creditRatio: 20, amount: 1, currency: "GBP" },
      },
    });
    const quote = await firstQuote(harness);
    expect(await codeOf(harness.service.createBooking({ quote }, READ_WRITE_ACTOR))).toBe(
      "CAP_EXCEEDED",
    );
  });

  it("books a cash desk that fits under the cap, and tells the Durable Object the price", async () => {
    const harness = createHarness({
      config: { maxCashPerBooking: 100 },
      apiScript: {
        spaces: [makeSpace({ credits: 0, location: makeLocation({ currency: "GBP" }) })],
        price: { credits: 0, creditRatio: 20, amount: 84, currency: "GBP" },
      },
    });
    const quote = await firstQuote(harness);
    await expect(harness.service.createBooking({ quote }, READ_WRITE_ACTOR)).resolves.toMatchObject(
      { dryRun: false },
    );
    expect(harness.session.reservations[0]).toMatchObject({ amount: 84, credits: 0 });
  });

  it("lets MAX_CASH_PER_BOOKING=-1 through unbounded", async () => {
    const harness = createHarness({
      config: { maxCashPerBooking: -1 },
      apiScript: {
        spaces: [makeSpace({ credits: 0, location: makeLocation({ currency: "GBP" }) })],
        price: { credits: 0, creditRatio: 20, amount: 9_999, currency: "GBP" },
      },
    });
    const quote = await firstQuote(harness);
    await expect(harness.service.createBooking({ quote }, READ_WRITE_ACTOR)).resolves.toMatchObject(
      { dryRun: false },
    );
  });

  it("replays an idempotent retry instead of booking twice", async () => {
    const harness = createHarness({ sessionScript: { maxPerDay: 5 } });
    const quote = await firstQuote(harness);
    const first = await harness.service.createBooking(
      { quote, idempotencyKey: "same" },
      READ_WRITE_ACTOR,
    );
    const bookCalls = harness.api.calls.filter((c) => c.method === "book").length;

    const replay = await harness.service.createBooking(
      { quote, idempotencyKey: "same" },
      READ_WRITE_ACTOR,
    );

    expect(replay.booking).toEqual(first.booking);
    expect(replay.summary).toContain("idempotent: true");
    expect(harness.api.calls.filter((c) => c.method === "book")).toHaveLength(bookCalls);
  });

  it("derives the idempotency key from the quote when none is given", async () => {
    const harness = createHarness({ sessionScript: { maxPerDay: 5 } });
    const quote = await firstQuote(harness);
    await harness.service.createBooking({ quote }, READ_WRITE_ACTOR);
    const replay = await harness.service.createBooking({ quote }, READ_WRITE_ACTOR);
    expect(replay.summary).toContain("idempotent: true");
    expect(harness.api.calls.filter((c) => c.method === "book")).toHaveLength(1);
  });

  it("dry-runs without touching WeWork or the caps", async () => {
    const harness = createHarness();
    const quote = await firstQuote(harness);
    const result = await harness.service.createBooking({ quote, dryRun: true }, READ_WRITE_ACTOR);

    expect(result).toMatchObject({
      dryRun: true,
      creditsCharged: 1,
      booking: { bookingId: "dry-run", status: "pending" },
    });
    expect(result.summary).toContain("Dry run");
    expect(result.capsRemaining).toEqual({ day: 1, week: 5 });
    expect(harness.api.calls.filter((c) => c.method === "quote" || c.method === "book")).toEqual(
      [],
    );
    expect(harness.session.usedToday()).toBe(0);
    expect(harness.session.audits).toContainEqual({
      tool: "create_booking",
      outcome: "ok",
      dryRun: true,
    });
  });

  it("refuses every write when WRITE_ENABLED is false", async () => {
    const harness = createHarness({ config: { writeEnabled: false } });
    const quote = await firstQuote(harness);
    expect(await codeOf(harness.service.createBooking({ quote }, READ_WRITE_ACTOR))).toBe(
      "WRITE_DISABLED",
    );
    expect(
      await codeOf(harness.service.cancelBooking({ bookingId: "BK-1" }, READ_WRITE_ACTOR)),
    ).toBe("WRITE_DISABLED");
  });

  it("releases the cap and records the failure when the upstream booking errors", async () => {
    const { AppError } = await import("../../src/errors");
    const harness = createHarness({
      apiScript: { fail: { book: new AppError("UPSTREAM_ERROR", "WeWork exploded") } },
    });
    const quote = await firstQuote(harness);
    expect(
      await codeOf(harness.service.createBooking({ quote, idempotencyKey: "k" }, READ_WRITE_ACTOR)),
    ).toBe("UPSTREAM_ERROR");
    expect(harness.session.released).toEqual(["book:k"]);
    expect(harness.session.usedToday()).toBe(0);
    expect(harness.session.idempotency.size).toBe(0);
  });

  it("substitutes the deployment's base URL into the <base> placeholder in hints", async () => {
    const { AppError } = await import("../../src/errors");
    const harness = createHarness({
      apiScript: { fail: { getSpaces: new AppError("SESSION_MISSING", "No session stored.") } },
    });
    try {
      await harness.service.searchAvailability({ locationId: "loc-poultry", date: DATE });
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAppError(err) && err.hint).toContain("https://weworking.test/admin/connect");
      expect(isAppError(err) && err.hint).not.toContain("<base>");
    }
  });
});

describe("listBookings", () => {
  it("passes the range through and strips the raw upstream payload", async () => {
    const harness = createHarness();
    const bookings = await harness.service.listBookings({ from: DATE, to: "2026-09-30" });
    expect(bookings[0]).not.toHaveProperty("raw");
    expect(harness.api.calls[0]).toEqual({
      method: "listBookings",
      args: { from: DATE, to: "2026-09-30" },
    });
  });

  it("rejects an inverted range and a malformed date", async () => {
    const harness = createHarness();
    expect(await codeOf(harness.service.listBookings({ from: "2026-09-30", to: DATE }))).toBe(
      "VALIDATION",
    );
    expect(await codeOf(harness.service.listBookings({ from: "nope" }))).toBe("VALIDATION");
  });
});

describe("cancelBooking", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness({ apiScript: { bookings: [makeBooking()] } });
  });

  it("cancels, records it in the ledger and reports the refund", async () => {
    const result = await harness.service.cancelBooking({ bookingId: "BK-1" }, READ_WRITE_ACTOR);
    expect(result).toMatchObject({ bookingId: "BK-1", status: "cancelled", creditsRefunded: 1 });
    expect(result.summary).toContain("1 Poultry");
    expect(harness.session.cancelled).toEqual(["BK-1"]);
    expect(harness.api.calls.map((c) => c.method)).toEqual(["listBookings", "cancelBooking"]);
    expect(harness.session.audits).toContainEqual({
      tool: "cancel_booking",
      outcome: "ok",
      dryRun: false,
    });
  });

  it("does not hand the day back, so book-cancel-book cannot loop past the caps", async () => {
    const booked = createHarness({
      apiScript: { bookings: [makeBooking()] },
      sessionScript: { maxPerDay: 1, maxPerWeek: 5 },
    });
    const quote = await firstQuote(booked);
    await booked.service.createBooking({ quote }, READ_WRITE_ACTOR);
    await expect(booked.session.session.capsRemaining("2026-09-21")).resolves.toEqual({
      day: 0,
      week: 4,
    });

    await booked.service.cancelBooking({ bookingId: "BK-1" }, READ_WRITE_ACTOR);
    await expect(booked.session.session.capsRemaining("2026-09-21")).resolves.toEqual({
      day: 0,
      week: 4,
    });
  });

  it("reports NOT_FOUND for an unknown id, without cancelling anything", async () => {
    expect(
      await codeOf(harness.service.cancelBooking({ bookingId: "BK-missing" }, READ_WRITE_ACTOR)),
    ).toBe("NOT_FOUND");
    expect(harness.api.calls.filter((c) => c.method === "cancelBooking")).toEqual([]);
  });

  it("dry-runs without calling upstream cancel", async () => {
    const result = await harness.service.cancelBooking(
      { bookingId: "BK-1", dryRun: true },
      READ_WRITE_ACTOR,
    );
    expect(result.summary).toContain("Dry run");
    expect(result.status).toBe("confirmed");
    expect(harness.api.calls.filter((c) => c.method === "cancelBooking")).toEqual([]);
    expect(harness.session.cancelled).toEqual([]);
  });

  it("replays an idempotent retry", async () => {
    await harness.service.cancelBooking(
      { bookingId: "BK-1", idempotencyKey: "c1" },
      READ_WRITE_ACTOR,
    );
    const replay = await harness.service.cancelBooking(
      { bookingId: "BK-1", idempotencyKey: "c1" },
      READ_WRITE_ACTOR,
    );
    expect(replay.summary).toContain("idempotent: true");
    expect(harness.api.calls.filter((c) => c.method === "cancelBooking")).toHaveLength(1);
  });

  it("requires a booking id", async () => {
    expect(await codeOf(harness.service.cancelBooking({ bookingId: "  " }, READ_WRITE_ACTOR))).toBe(
      "VALIDATION",
    );
  });
});

describe("whoami", () => {
  it("reports profile, credits, session, caps and scopes", async () => {
    const harness = createHarness();
    const result = await harness.service.whoami(READ_WRITE_ACTOR);
    expect(result).toMatchObject({
      profile: { userId: "user-1", name: "Ada" },
      credits: { remaining: 7.5 },
      session: { state: "valid" },
      actor: READ_WRITE_ACTOR,
      caps: {
        maxBookingsPerDay: 1,
        maxBookingsPerWeek: 5,
        maxCreditsPerBooking: -1,
        maxCashPerBooking: -1,
      },
      capsRemaining: { day: 1, week: 5 },
      writeEnabled: true,
    });
  });

  it("answers without a session rather than throwing, and never calls upstream", async () => {
    const harness = createHarness({
      sessionScript: { sessionInfo: { state: "none", source: "none", hasRefreshToken: false } },
    });
    const result = await harness.service.whoami(READ_WRITE_ACTOR);
    expect(result.session.state).toBe("none");
    // Placeholder profile: `WhoamiResult.profile` is not optional in the shared types.
    expect(result.profile).toEqual({ userId: "" });
    expect(result.credits).toBeUndefined();
    expect(harness.api.calls).toEqual([]);
  });

  it("tolerates an upstream credits failure", async () => {
    const { AppError } = await import("../../src/errors");
    const harness = createHarness({
      apiScript: { fail: { getMonthlyCredits: new AppError("UPSTREAM_ERROR", "nope") } },
    });
    const result = await harness.service.whoami(READ_WRITE_ACTOR);
    expect(result.credits).toBeUndefined();
    expect(result.profile.userId).toBe("user-1");
  });

  it("reports writeEnabled false when the kill switch is off", async () => {
    const harness = createHarness({ config: { writeEnabled: false } });
    await expect(harness.service.whoami(READ_WRITE_ACTOR)).resolves.toMatchObject({
      writeEnabled: false,
    });
  });
});

describe("cross-module contracts", () => {
  it("keeps WeWorkApi and SessionRpc assignable in both directions", () => {
    // Only the annotation matters: if a declaration drifts, one of the tuple members
    // becomes `never` and `tsc` rejects this line.
    const compatible: ContractCompatibility = [true, true, true];
    expect(compatible).toEqual([true, true, true]);
  });
});
