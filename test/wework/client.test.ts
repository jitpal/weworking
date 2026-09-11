/**
 * `WeWorkClient`.
 *
 * Each endpoint gets the same three assertions, because all three have broken
 * independently in other clients: the **URL** (every documented query parameter, with
 * the right name and casing), the **header block** (the token in *two* headers, the
 * member id, the right `Request-Source`/`fe-pg` pair) and the **body** (PascalCase
 * fields, `Notes` as a string, `MailData` with no nulls, times on the grid).
 *
 * Then the four upstream behaviours that are not ordinary HTTP: a 200 carrying an
 * error envelope, a 200 carrying a *refused booking*, a literal `true` from cancel,
 * and a 401 that means "refresh and retry once".
 */

import { describe, expect, it } from "vitest";
import type { Booking } from "../../src/core/types";
import { isAppError } from "../../src/errors";
import {
  addDays,
  buildCancelBody,
  buildUrl,
  monthBoundsUtc,
  spaceIdByAccountType,
  WeWorkClient,
} from "../../src/wework/client";
import bookingRefused from "../fixtures/wework/booking-refused.json";
import bookingSuccess from "../fixtures/wework/booking-success.json";
import cityDetails from "../fixtures/wework/city-details.json";
import errorEnvelope from "../fixtures/wework/error-envelope.json";
import spacesFixture from "../fixtures/wework/get-spaces.json";
import inventoryDetails from "../fixtures/wework/inventory-details.json";
import inventoryDetailsEmpty from "../fixtures/wework/inventory-details-empty.json";
import locationsByGeo from "../fixtures/wework/locations-by-geo.json";
import monthlyCredits from "../fixtures/wework/monthly-credits.json";
import profile from "../fixtures/wework/profile.json";
import quoteFixture from "../fixtures/wework/quote.json";
import upcoming from "../fixtures/wework/upcoming-bookings.json";
import { createFakeFetch, type FakeRoute } from "../helpers/fake-fetch";
import {
  FIXTURE_ACCESS_TOKEN,
  FIXTURE_USER_UUID,
  fixtureBooking,
  fixtureSpace,
  INVENTORY_1,
  INVENTORY_2,
  jsonBody,
  LOCATION_1,
  LOCATION_2,
  MEMBERS_API,
  now,
  queryOf,
  SPACE_1,
  SPACE_2,
  sampleQuote,
  seededTokenStore,
} from "./helpers";

/** A client wired to a route table and the seeded token store. */
function makeClient(routes: FakeRoute[]) {
  const fetchStub = createFakeFetch(routes);
  const tokens = seededTokenStore();
  return { client: new WeWorkClient({ fetch: fetchStub, tokens, now }), fetchStub, tokens };
}

/** A single-route table answering `url` with `body`. */
function route(
  method: "GET" | "POST",
  url: string | RegExp,
  body: unknown,
  init?: ResponseInit,
): FakeRoute {
  return {
    method,
    url,
    response: () => new Response(body === undefined ? null : JSON.stringify(body), init),
  };
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected an AppError with code ${code}`);
}

/* -------------------------------------------------------------------------- */
/* Header block                                                                */
/* -------------------------------------------------------------------------- */

describe("the header block", () => {
  it("sends the token twice, the member id, and the ondemand source", async () => {
    const { client, fetchStub } = makeClient([
      route("GET", `${MEMBERS_API}/wework-yardi/user/get-user-profile`, profile),
    ]);
    await client.getProfile();

    const headers = fetchStub.calls[0]?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${FIXTURE_ACCESS_TOKEN}`);
    expect(headers.weworkauth).toBe(`Bearer ${FIXTURE_ACCESS_TOKEN}`);
    expect(headers.weworkuuid).toBe(FIXTURE_USER_UUID);
    expect(headers.weworkmembertype).toBe("2");
    expect(headers["request-source"]).toBe(
      "com.wework.ondemand/WorkplaceOne/Prod/iOS/2.71.0(26.1)",
    );
    expect(headers["fe-pg"]).toBe("/workplaceone/content2/dashboard");
    expect(headers.origin).toBe("https://members.wework.com");
    expect(headers.referer).toBe("https://members.wework.com/");
    expect(headers.accept).toContain("application/json");
  });

  it("switches to the MemberWeb source and your-bookings page for cancel", async () => {
    const booking = fixtureBooking();
    const { client, fetchStub } = makeClient([
      route("POST", `${MEMBERS_API}/common-booking/cancel`, true),
    ]);
    await client.cancelBooking(booking);

    const headers = fetchStub.calls[0]?.headers ?? {};
    expect(headers["request-source"]).toBe("MemberWeb/WorkplaceOne/Prod");
    expect(headers["fe-pg"]).toBe("/workplaceone/content2/your-bookings");
  });

  it("honours an injected user agent", async () => {
    const fetchStub = createFakeFetch([
      route("GET", `${MEMBERS_API}/wework-yardi/user/get-user-profile`, profile),
    ]);
    const client = new WeWorkClient({
      fetch: fetchStub,
      tokens: seededTokenStore(),
      now,
      userAgent: "Custom/1.0",
    });
    await client.getProfile();
    expect(fetchStub.calls[0]?.headers["user-agent"]).toBe("Custom/1.0");
  });
});

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

describe("listCities", () => {
  it("calls get-city-details and de-duplicates the result", async () => {
    const { client, fetchStub } = makeClient([
      route("GET", `${MEMBERS_API}/wework-yardi/location/get-city-details`, cityDetails),
    ]);
    await expect(client.listCities()).resolves.toEqual(["Berlin", "Lisbon"]);
    expect(fetchStub.calls[0]?.url).toBe(`${MEMBERS_API}/wework-yardi/location/get-city-details`);
  });
});

describe("listLocationsByCity", () => {
  it("sends the documented city-search parameters", async () => {
    const { client, fetchStub } = makeClient([
      route("GET", `${MEMBERS_API}/wework-yardi/ondemand/get-locations-by-geo`, locationsByGeo),
    ]);
    const locations = await client.listLocationsByCity("Berlin");

    expect(queryOf(fetchStub.calls[0]?.url ?? "")).toEqual({
      isAuthenticated: "true",
      city: "Berlin",
      isOnDemandUser: "false",
      isWeb: "true",
    });
    expect(locations.map((l) => l.locationId)).toEqual([LOCATION_1, LOCATION_2]);
    expect(locations[0]?.openTime).toBe("09:00");
  });
});

describe("listLocationsByGeo", () => {
  it("sends the +/-0.13 degree bounding box with NW and SE corners", async () => {
    const { client, fetchStub } = makeClient([
      route("GET", `${MEMBERS_API}/wework-yardi/ondemand/get-locations-by-geo`, locationsByGeo),
    ]);
    await client.listLocationsByGeo({ lat: 52.52, lng: 13.405 });

    expect(queryOf(fetchStub.calls[0]?.url ?? "")).toEqual({
      isAuthenticated: "true",
      city: "",
      isOnDemandUser: "false",
      isWeb: "true",
      userLatitude: "52.52",
      userLongitude: "13.405",
      // North-west: higher latitude, lower longitude.
      boundnwLat: "52.65",
      boundnwLng: "13.275",
      // South-east: lower latitude, higher longitude.
      boundseLat: "52.39",
      boundseLng: "13.535",
    });
  });

  it("computes distanceKm and sorts nearest first", async () => {
    const { client } = makeClient([
      route("GET", `${MEMBERS_API}/wework-yardi/ondemand/get-locations-by-geo`, locationsByGeo),
    ]);
    const locations = await client.listLocationsByGeo({ lat: 52.52, lng: 13.405 });
    expect(locations[0]?.locationId).toBe(LOCATION_1);
    expect(locations[0]?.distanceKm).toBe(0);
    expect(locations[1]?.distanceKm).toBeGreaterThan(0);
  });

  it("filters by radiusKm without changing the request", async () => {
    const { client, fetchStub } = makeClient([
      route("GET", `${MEMBERS_API}/wework-yardi/ondemand/get-locations-by-geo`, locationsByGeo),
    ]);
    const locations = await client.listLocationsByGeo({ lat: 52.52, lng: 13.405, radiusKm: 1 });
    expect(locations.map((l) => l.locationId)).toEqual([LOCATION_1]);
    // The bounding box is still the fixed one.
    expect(queryOf(fetchStub.calls[0]?.url ?? "").boundnwLat).toBe("52.65");
  });
});

describe("getProfile", () => {
  it("maps the profile, falling back to the token's member id", async () => {
    const { client } = makeClient([
      route("GET", `${MEMBERS_API}/wework-yardi/user/get-user-profile`, profile),
    ]);
    await expect(client.getProfile()).resolves.toEqual({
      userId: FIXTURE_USER_UUID,
      email: "not-a-real-member@example.invalid",
      name: "Testy Example",
      membershipType: "WeWork All Access",
      homeLocationId: LOCATION_1,
    });
  });

  it("uses the token's member id when upstream omits one", async () => {
    const { client } = makeClient([
      route("GET", `${MEMBERS_API}/wework-yardi/user/get-user-profile`, { email: "a@b.invalid" }),
    ]);
    await expect(client.getProfile()).resolves.toMatchObject({ userId: FIXTURE_USER_UUID });
  });
});

describe("getMonthlyCredits", () => {
  it("asks for the current UTC calendar month", async () => {
    const { client, fetchStub } = makeClient([
      route("GET", `${MEMBERS_API}/common-account/monthly-credits`, monthlyCredits),
    ]);
    // The frozen clock is 2026-09-20T18:30:00Z.
    await expect(client.getMonthlyCredits()).resolves.toEqual({
      remaining: 42,
      total: 60,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
    });
    expect(queryOf(fetchStub.calls[0]?.url ?? "")).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
  });

  it("honours an explicit reference date, including February", async () => {
    const { client, fetchStub } = makeClient([
      route("GET", `${MEMBERS_API}/common-account/monthly-credits`, monthlyCredits),
    ]);
    await client.getMonthlyCredits(new Date("2028-02-10T00:00:00Z"));
    expect(queryOf(fetchStub.calls[0]?.url ?? "")).toEqual({
      startDate: "2028-02-01",
      // 2028 is a leap year.
      endDate: "2028-02-29",
    });
  });

  it("returns undefined for an account with no credit allowance", async () => {
    const { client } = makeClient([
      route("GET", `${MEMBERS_API}/common-account/monthly-credits`, {
        responseStatus: { type: "success" },
      }),
    ]);
    await expect(client.getMonthlyCredits()).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* getSpaces                                                                   */
/* -------------------------------------------------------------------------- */

describe("getSpaces", () => {
  const GET_SPACES = `${MEMBERS_API}/spaces/get-spaces`;

  it("sends every documented query parameter", async () => {
    const { client, fetchStub } = makeClient([route("GET", GET_SPACES, spacesFixture)]);
    await client.getSpaces({ locationIds: [LOCATION_1, LOCATION_2], date: "2026-09-21" });

    expect(queryOf(fetchStub.calls[0]?.url ?? "")).toEqual({
      locationUUIDs: `${LOCATION_1},${LOCATION_2}`,
      date: "2026-09-21",
      duration: "30",
      locationOffset: "+00:00",
      type: "0",
      capacity: "0",
      offset: "0",
      limit: "50",
      isWeb: "true",
    });
  });

  it("reuses the offset of a location it has already listed", async () => {
    const { client, fetchStub } = makeClient([
      route("GET", `${MEMBERS_API}/wework-yardi/ondemand/get-locations-by-geo`, locationsByGeo),
      route("GET", GET_SPACES, spacesFixture),
    ]);
    await client.listLocationsByCity("Berlin");
    await client.getSpaces({ locationIds: [LOCATION_1], date: "2026-09-21" });
    expect(queryOf(fetchStub.calls[1]?.url ?? "").locationOffset).toBe("+02:00");
  });

  it("accepts an explicit locationOffset", async () => {
    const { client, fetchStub } = makeClient([route("GET", GET_SPACES, spacesFixture)]);
    await client.getSpaces({
      locationIds: [LOCATION_1],
      date: "2026-09-21",
      locationOffset: "-04:00",
    });
    expect(queryOf(fetchStub.calls[0]?.url ?? "").locationOffset).toBe("-04:00");
  });

  it("maps all three workspaces with their window in local and UTC", async () => {
    const { client } = makeClient([route("GET", GET_SPACES, spacesFixture)]);
    const spaces = await client.getSpaces({ locationIds: [LOCATION_1], date: "2026-09-21" });

    expect(spaces).toHaveLength(3);
    expect(spaces[0]).toMatchObject({
      spaceId: SPACE_1,
      kubeId: "kube-space-0001",
      inventoryUuid: INVENTORY_1,
      seatsAvailable: 5,
      credits: 10,
      startLocal: "2026-09-21T09:00:00",
      endLocal: "2026-09-21T18:30:00",
      startUtc: "2026-09-21T07:00:00Z",
      endUtc: "2026-09-21T16:30:00Z",
      spaceType: "desk",
    });
    expect(spaces[0]?.location.accountType).toBe(2);
    expect(spaces[1]).toMatchObject({
      spaceId: SPACE_2,
      inventoryUuid: INVENTORY_2,
      seatsAvailable: 3,
      // "8:0" upstream.
      startLocal: "2026-09-21T08:00:00",
      startUtc: "2026-09-21T06:00:00Z",
    });
    expect(spaces[1]?.kubeId).toBeUndefined();
    expect(spaces[1]?.location.accountType).toBe(4);
  });

  it("filters by the requested capacity, against seats actually available", async () => {
    const { client, fetchStub } = makeClient([route("GET", GET_SPACES, spacesFixture)]);
    const spaces = await client.getSpaces({
      locationIds: [LOCATION_1, LOCATION_2],
      date: "2026-09-21",
      capacity: 4,
    });
    // Only the first workspace has 4 or more seats free (5); the others have 3 and 0.
    expect(spaces.map((s) => s.spaceId)).toEqual([SPACE_1]);
    expect(queryOf(fetchStub.calls[0]?.url ?? "").capacity).toBe("4");
  });

  it("rejects a non-desk space type without calling upstream", async () => {
    const { client, fetchStub } = makeClient([route("GET", GET_SPACES, spacesFixture)]);
    await expectAppError(
      client.getSpaces({
        locationIds: [LOCATION_1],
        date: "2026-09-21",
        spaceType: "meeting_room",
      }),
      "UNSUPPORTED_SPACE_TYPE",
    );
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("validates its own arguments", async () => {
    const { client } = makeClient([route("GET", GET_SPACES, spacesFixture)]);
    await expectAppError(client.getSpaces({ locationIds: [], date: "2026-09-21" }), "VALIDATION");
    await expectAppError(
      client.getSpaces({ locationIds: [LOCATION_1], date: "21/09/2026" }),
      "VALIDATION",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* SpaceID resolution                                                          */
/* -------------------------------------------------------------------------- */

describe("resolveBookingSpaceId", () => {
  const INVENTORY_URL = `${MEMBERS_API}/common-booking/inventory-details`;

  /** The accountType 2 workspace from the fixture (reservable.KubeId present). */
  const space2 = () => fixtureSpace(0);

  /** The accountType 4 workspace from the fixture (inventoryUuid, no KubeId). */
  const space4 = () => fixtureSpace(1);

  it("prefers kubeSpaceId from inventory-details, with the renamed parameters", async () => {
    const { client, fetchStub } = makeClient([route("GET", INVENTORY_URL, inventoryDetails)]);
    await expect(client.resolveBookingSpaceId(space2())).resolves.toBe(
      "kube-space-from-inventory-0001",
    );
    expect(queryOf(fetchStub.calls[0]?.url ?? "")).toEqual({
      propertyGuid: LOCATION_1,
      spaceGuid: SPACE_1,
      applicationType: "WorkplaceOne",
    });
  });

  it("falls back to the accountType rules when kubeSpaceId is empty", async () => {
    const { client } = makeClient([route("GET", INVENTORY_URL, inventoryDetailsEmpty)]);
    // accountType 2 -> reservable.KubeId.
    await expect(client.resolveBookingSpaceId(space2())).resolves.toBe("kube-space-0001");
  });

  it("falls back gracefully when inventory-details fails outright", async () => {
    const { client } = makeClient([
      route(
        "GET",
        INVENTORY_URL,
        { responseStatus: { type: "error", message: "gone" } },
        { status: 500 },
      ),
    ]);
    await expect(client.resolveBookingSpaceId(space4())).resolves.toBe(INVENTORY_2);
  });

  it("falls back when inventory-details 404s, rather than propagating NOT_FOUND", async () => {
    const { client } = makeClient([route("GET", INVENTORY_URL, undefined, { status: 404 })]);
    await expect(client.resolveBookingSpaceId(space2())).resolves.toBe("kube-space-0001");
  });
});

describe("spaceIdByAccountType", () => {
  const base = {
    spaceId: "uuid-space",
    inventoryUuid: "inventory-space",
    kubeId: "kube-space",
  };
  const at = (accountType: number, overrides: Record<string, unknown> = {}) =>
    ({
      ...base,
      ...overrides,
      location: { accountType },
    }) as unknown as Parameters<typeof spaceIdByAccountType>[0];

  it("accountType 2 uses the Kube id", () => {
    expect(spaceIdByAccountType(at(2))).toBe("kube-space");
  });

  it("accountType 4 uses the inventory uuid", () => {
    expect(spaceIdByAccountType(at(4))).toBe("inventory-space");
  });

  it("accountType 0 uses the workspace uuid", () => {
    expect(spaceIdByAccountType(at(0))).toBe("uuid-space");
  });

  it("cascades down when the preferred id is absent", () => {
    expect(spaceIdByAccountType(at(2, { kubeId: undefined }))).toBe("inventory-space");
    expect(spaceIdByAccountType(at(2, { kubeId: undefined, inventoryUuid: undefined }))).toBe(
      "uuid-space",
    );
    expect(spaceIdByAccountType(at(4, { inventoryUuid: undefined }))).toBe("uuid-space");
  });

  it("an unknown accountType uses the workspace uuid", () => {
    expect(spaceIdByAccountType(at(99))).toBe("uuid-space");
  });
});

/* -------------------------------------------------------------------------- */
/* Quote and book                                                              */
/* -------------------------------------------------------------------------- */

describe("quote", () => {
  const QUOTE_URL = `${MEMBERS_API}/common-booking/quote`;

  it("builds the documented body, with Notes and MailData as strings", async () => {
    const { client, fetchStub } = makeClient([route("POST", QUOTE_URL, quoteFixture)]);
    await client.quote(sampleQuote());

    expect(jsonBody(fetchStub.calls[0]?.body)).toEqual({
      SpaceType: 4,
      ReservationID: "",
      TriggerCalendarEvent: true,
      Notes: "",
      LocationType: 2,
      UTCOffset: "+02:00",
      Currency: "com.wework.credits",
      LocationID: LOCATION_1,
      SpaceID: "kube-space-0001",
      WeWorkSpaceID: SPACE_1,
      StartTime: "2026-09-21T07:00:00Z",
      EndTime: "2026-09-21T15:00:00Z",
      MailData: {
        dayFormatted: "Monday, September 21",
        startTimeFormatted: "09:00 AM",
        endTimeFormatted: "05:00 PM",
        floorAddress: "",
        locationAddress: "100 Example Street, Floor 4",
        creditsUsed: "10",
        Capacity: "1",
        TimezoneUsed: "GMT +02:00",
        TimezoneIana: "Europe/Berlin",
        // Local wall clock, not UTC: the email says 09:00-17:00.
        startDateTime: "2026-09-21 09:00",
        endDateTime: "2026-09-21 17:00",
        locationName: "Fake Tower",
        locationCity: "Berlin",
        locationCountry: "DE",
        locationState: "Berlin",
      },
    });
  });

  it("never emits a null anywhere in the body", async () => {
    const { client, fetchStub } = makeClient([route("POST", QUOTE_URL, quoteFixture)]);
    // A quote with every optional field absent.
    const sparse = sampleQuote();
    delete sparse.state;
    await client.quote(sparse);
    expect(fetchStub.calls[0]?.body).not.toContain("null");
    expect(jsonBody(fetchStub.calls[0]?.body).MailData).toMatchObject({ locationState: "" });
  });

  it("uses quoteSpaceId for the quote's SpaceID when the payload carries one", async () => {
    const { client, fetchStub } = makeClient([route("POST", QUOTE_URL, quoteFixture)]);
    await client.quote({ ...sampleQuote(), quoteSpaceId: INVENTORY_1 } as never);
    expect(jsonBody(fetchStub.calls[0]?.body).SpaceID).toBe(INVENTORY_1);
  });

  it("returns the credit ratio the booking call must echo", async () => {
    const { client } = makeClient([route("POST", QUOTE_URL, quoteFixture)]);
    await expect(client.quote(sampleQuote())).resolves.toEqual({
      credits: 10,
      creditRatio: 1.5,
      amount: 0,
      currency: "com.wework.credits",
    });
  });

  it("fails when upstream returns no credit ratio", async () => {
    const { client } = makeClient([route("POST", QUOTE_URL, { grandTotal: { credits: 10 } })]);
    await expectAppError(client.quote(sampleQuote()), "UPSTREAM_ERROR");
  });

  it("enforces the 30-minute grid before calling upstream", async () => {
    const { client, fetchStub } = makeClient([route("POST", QUOTE_URL, quoteFixture)]);
    const offGrid = await expectAppError(
      client.quote(sampleQuote({ startUtc: "2026-09-21T07:15:00Z" })),
      "VALIDATION",
    );
    expect(offGrid.message).toContain("startUtc");
    await expectAppError(
      client.quote(sampleQuote({ endUtc: "2026-09-21T15:45:00Z" })),
      "VALIDATION",
    );
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("rejects stray seconds and milliseconds as off-grid", async () => {
    const { client } = makeClient([route("POST", QUOTE_URL, quoteFixture)]);
    await expectAppError(
      client.quote(sampleQuote({ startUtc: "2026-09-21T07:00:30Z" })),
      "VALIDATION",
    );
  });

  it("accepts a millisecond-precision stamp on the grid and normalises it", async () => {
    const { client, fetchStub } = makeClient([route("POST", QUOTE_URL, quoteFixture)]);
    await client.quote(sampleQuote({ startUtc: "2026-09-21T07:00:00.000Z" }));
    expect(jsonBody(fetchStub.calls[0]?.body).StartTime).toBe("2026-09-21T07:00:00Z");
  });

  it("rejects an end before its start", async () => {
    const { client } = makeClient([route("POST", QUOTE_URL, quoteFixture)]);
    await expectAppError(
      client.quote(sampleQuote({ endUtc: "2026-09-21T06:00:00Z" })),
      "VALIDATION",
    );
  });
});

describe("book", () => {
  const BOOK_URL = `${MEMBERS_API}/common-booking/`;

  it("posts the quote body plus the three booking-only fields", async () => {
    const { client, fetchStub } = makeClient([route("POST", BOOK_URL, bookingSuccess)]);
    await client.book(sampleQuote(), 1.5);

    const body = jsonBody(fetchStub.calls[0]?.body);
    expect(body).toMatchObject({
      ApplicationType: "WorkplaceOne",
      PlatformType: "iOS_APP",
      CreditRatio: 1.5,
      // The booking SpaceID is the accountType-resolved id, not the quote's.
      SpaceID: "kube-space-0001",
      WeWorkSpaceID: SPACE_1,
      SpaceType: 4,
      ReservationID: "",
      Notes: "",
    });
  });

  it("returns the reservation on BookingSuccess", async () => {
    const { client } = makeClient([route("POST", BOOK_URL, bookingSuccess)]);
    await expect(client.book(sampleQuote(), 1.5)).resolves.toMatchObject({
      reservationId: "RSV-FAKE-9001",
      status: "BookingSuccess",
    });
  });

  it("treats an HTTP 200 refusal as BOOKING_REFUSED, carrying the upstream message", async () => {
    const { client } = makeClient([route("POST", BOOK_URL, bookingRefused)]);
    const error = await expectAppError(client.book(sampleQuote(), 1.5), "BOOKING_REFUSED");
    expect(error.message).toBe("You do not have enough credits remaining for this booking.");
    expect(error.status).toBe(409);
  });

  it("refuses a success status with an empty ReservationID", async () => {
    const { client } = makeClient([
      route("POST", BOOK_URL, { BookingStatus: "BookingSuccess", ReservationID: "" }),
    ]);
    await expectAppError(client.book(sampleQuote(), 1.5), "BOOKING_REFUSED");
  });

  it("refuses a success status that still carries Errors", async () => {
    const { client } = makeClient([
      route("POST", BOOK_URL, {
        BookingStatus: "BookingSuccess",
        ReservationID: "RSV-FAKE-1",
        Errors: ["Space no longer available."],
      }),
    ]);
    const error = await expectAppError(client.book(sampleQuote(), 1.5), "BOOKING_REFUSED");
    expect(error.message).toBe("Space no longer available.");
  });

  it("refuses an unknown status and says so", async () => {
    const { client } = makeClient([
      route("POST", BOOK_URL, { BookingStatus: "SomethingElse", ReservationID: "RSV-FAKE-1" }),
    ]);
    const error = await expectAppError(client.book(sampleQuote(), 1.5), "BOOKING_REFUSED");
    expect(error.message).toContain("SomethingElse");
  });

  it("refuses an empty body rather than inventing a success", async () => {
    const { client } = makeClient([route("POST", BOOK_URL, {})]);
    await expectAppError(client.book(sampleQuote(), 1.5), "BOOKING_REFUSED");
  });
});

/* -------------------------------------------------------------------------- */
/* Bookings list and cancel                                                    */
/* -------------------------------------------------------------------------- */

describe("listBookings", () => {
  const LIST_URL = `${MEMBERS_API}/common-booking/get-app-upcoming-bookings`;

  it("defaults the window to today plus 30 days", async () => {
    const { client, fetchStub } = makeClient([route("GET", LIST_URL, upcoming)]);
    await client.listBookings();
    expect(queryOf(fetchStub.calls[0]?.url ?? "")).toEqual({
      isPastBooking: "false",
      platFormType: "1",
      // The frozen clock is 2026-09-20.
      startDate: "2026-09-20",
      endDate: "2026-10-20",
    });
  });

  it("passes an explicit window and the past-bookings flag", async () => {
    const { client, fetchStub } = makeClient([route("GET", LIST_URL, upcoming)]);
    await client.listBookings({ from: "2026-09-22", to: "2026-09-26", includePast: true });
    expect(queryOf(fetchStub.calls[0]?.url ?? "")).toMatchObject({
      isPastBooking: "true",
      startDate: "2026-09-22",
      endDate: "2026-09-26",
    });
  });

  it("re-anchors the local-wall-clock-stamped-Z times rather than converting them", async () => {
    const { client } = makeClient([route("GET", LIST_URL, upcoming)]);
    const bookings = await client.listBookings();

    // Upstream sent "2026-09-22T09:00:00Z" for a Berlin desk. Converting would give
    // 11:00 local; the right answer is the wall clock upstream already meant.
    expect(bookings[0]).toMatchObject({
      bookingId: "dddd4444-0000-4000-8000-000000000001",
      startLocal: "2026-09-22T09:00:00",
      endLocal: "2026-09-22T17:00:00",
      date: "2026-09-22",
      timezone: "Europe/Berlin",
      status: "confirmed",
      credits: 10,
    });
    expect(bookings[0]?.startLocal).not.toContain("11:00");
  });

  it("sorts by start time and filters out bookings beyond the window", async () => {
    const { client } = makeClient([route("GET", LIST_URL, upcoming)]);
    await expect(
      client.listBookings({ from: "2026-09-20", to: "2026-09-23" }),
    ).resolves.toHaveLength(1);

    const all = await client.listBookings();
    expect(all.map((b) => b.startLocal)).toEqual(["2026-09-22T09:00:00", "2026-09-25T08:00:00"]);
  });

  it("attaches the raw upstream item so cancel can be built from it", async () => {
    const { client } = makeClient([route("GET", LIST_URL, upcoming)]);
    const bookings = await client.listBookings();
    expect(bookings[0]?.raw).toMatchObject({
      reservableId: "eeee5555-0000-4000-8000-000000000001",
    });
  });
});

describe("cancelBooking", () => {
  const CANCEL_URL = `${MEMBERS_API}/common-booking/cancel`;

  it("sends the documented query parameters and body", async () => {
    const { client, fetchStub } = makeClient([route("POST", CANCEL_URL, true)]);
    await client.cancelBooking(fixtureBooking());

    expect(queryOf(fetchStub.calls[0]?.url ?? "")).toEqual({
      isOnDemand: "false",
      platFormType: "1",
    });
    expect(jsonBody(fetchStub.calls[0]?.body)).toEqual({
      bookingId: "dddd4444-0000-4000-8000-000000000001",
      // location.sourceType, not accountType.
      bookingLocationType: 1,
      creditsUsed: 10,
      // Local wall clock with .000 and no Z.
      startTime: "2026-09-22T09:00:00.000",
      endTime: "2026-09-22T17:00:00.000",
      locationId: LOCATION_1,
      reservableId: "eeee5555-0000-4000-8000-000000000001",
      spaceId: SPACE_1,
      isBookingApprovalOn: false,
      bookingType: 4,
      cancellationNote: "",
      reservationId: "RSV-FAKE-0001",
      mailParams: {
        workspaceType: 1,
        dayFormatted: "Tuesday, September 22",
        startTimeFormatted: "09:00 AM",
        endTimeFormatted: "05:00 PM",
        floorAddress: "",
        locationAddress: "100 Example Street, Floor 4",
        locationCountry: "Germany",
      },
    });
  });

  it("resolves on the literal true upstream returns", async () => {
    const { client } = makeClient([route("POST", CANCEL_URL, true)]);
    await expect(client.cancelBooking(fixtureBooking())).resolves.toBeUndefined();
  });

  it("fails when upstream answers false", async () => {
    const { client } = makeClient([route("POST", CANCEL_URL, false)]);
    await expectAppError(client.cancelBooking(fixtureBooking()), "UPSTREAM_ERROR");
  });

  it("refuses to guess when the Booking carries no raw item", async () => {
    const { client, fetchStub } = makeClient([route("POST", CANCEL_URL, true)]);
    const stripped: Booking = { ...fixtureBooking() };
    delete stripped.raw;
    const error = await expectAppError(client.cancelBooking(stripped), "VALIDATION");
    expect(error.hint).toContain("list_bookings");
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("buildCancelBody defaults the fields upstream may omit", () => {
    const body = buildCancelBody({
      ...fixtureBooking(),
      reservationId: undefined,
      raw: { uuid: "b1" },
    } as Booking);
    expect(body).toMatchObject({
      bookingLocationType: 0,
      reservableId: "",
      spaceId: "",
      isBookingApprovalOn: false,
      bookingType: 4,
      reservationId: "",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Error taxonomy                                                              */
/* -------------------------------------------------------------------------- */

describe("upstream error handling", () => {
  const PROFILE_URL = `${MEMBERS_API}/wework-yardi/user/get-user-profile`;

  it("forces a refresh and retries once on a 401", async () => {
    let calls = 0;
    const { client, fetchStub, tokens } = makeClient([
      {
        method: "GET",
        url: PROFILE_URL,
        response: () => {
          calls += 1;
          return calls === 1
            ? new Response("unauthorized", { status: 401 })
            : Response.json(profile);
        },
      },
    ]);

    await expect(client.getProfile()).resolves.toMatchObject({ userId: FIXTURE_USER_UUID });
    expect(fetchStub.calls).toHaveLength(2);
    expect(tokens.forceRefreshCount).toBe(1);
  });

  it("gives up with UPSTREAM_AUTH after a second 401", async () => {
    const { client, fetchStub, tokens } = makeClient([
      route("GET", PROFILE_URL, undefined, { status: 401 }),
    ]);
    await expectAppError(client.getProfile(), "UPSTREAM_AUTH");
    // Exactly one retry, never a loop.
    expect(fetchStub.calls).toHaveLength(2);
    expect(tokens.forceRefreshCount).toBe(1);
  });

  it("maps a 429 to UPSTREAM_RATE_LIMITED and keeps Retry-After in the details", async () => {
    const { client } = makeClient([
      route("GET", PROFILE_URL, undefined, { status: 429, headers: { "retry-after": "30" } }),
    ]);
    const error = await expectAppError(client.getProfile(), "UPSTREAM_RATE_LIMITED");
    expect(error.details).toEqual({ retryAfter: "30" });
    expect(error.status).toBe(429);
  });

  it("maps a 200 with an error envelope to UPSTREAM_ERROR, carrying the message", async () => {
    const { client } = makeClient([route("GET", PROFILE_URL, errorEnvelope)]);
    const error = await expectAppError(client.getProfile(), "UPSTREAM_ERROR");
    expect(error.message).toBe("This workspace is not available for the selected time.");
  });

  it("maps a non-JSON body to UPSTREAM_ERROR", async () => {
    const { client } = makeClient([
      {
        method: "GET",
        url: PROFILE_URL,
        response: () => new Response("<html>Gateway Timeout</html>", { status: 200 }),
      },
    ]);
    await expectAppError(client.getProfile(), "UPSTREAM_ERROR");
  });

  it("maps a Cloudflare challenge to UPSTREAM_BLOCKED", async () => {
    const { client } = makeClient([
      {
        method: "GET",
        url: PROFILE_URL,
        response: () =>
          new Response("<html><title>Just a moment...</title>cf-chl</html>", { status: 403 }),
      },
    ]);
    await expectAppError(client.getProfile(), "UPSTREAM_BLOCKED");
  });

  it("maps a plain 403 to UPSTREAM_AUTH", async () => {
    const { client } = makeClient([
      route("GET", PROFILE_URL, { message: "forbidden" }, { status: 403 }),
    ]);
    await expectAppError(client.getProfile(), "UPSTREAM_AUTH");
  });

  it("maps a 404 to NOT_FOUND", async () => {
    const { client } = makeClient([route("GET", PROFILE_URL, undefined, { status: 404 })]);
    await expectAppError(client.getProfile(), "NOT_FOUND");
  });

  it("maps a 500 to UPSTREAM_ERROR, including the envelope message", async () => {
    const { client } = makeClient([route("GET", PROFILE_URL, errorEnvelope, { status: 500 })]);
    const error = await expectAppError(client.getProfile(), "UPSTREAM_ERROR");
    expect(error.message).toContain("not available for the selected time");
  });

  it("never leaks the access token into an error", async () => {
    const { client } = makeClient([route("GET", PROFILE_URL, errorEnvelope)]);
    const error = await expectAppError(client.getProfile(), "UPSTREAM_ERROR");
    expect(JSON.stringify(error.details ?? "") + error.message).not.toContain(FIXTURE_ACCESS_TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

describe("url and date utilities", () => {
  it("buildUrl drops undefined parameters and encodes the rest", () => {
    expect(buildUrl("/x", { a: 1, b: undefined, c: "a b" })).toBe(`${MEMBERS_API}/x?a=1&c=a+b`);
    expect(buildUrl("x")).toBe(`${MEMBERS_API}/x`);
  });

  it("monthBoundsUtc handles month ends and leap years", () => {
    expect(monthBoundsUtc(new Date("2026-09-20T18:30:00Z"))).toEqual({
      start: "2026-09-01",
      end: "2026-09-30",
    });
    expect(monthBoundsUtc(new Date("2026-12-31T23:59:59Z"))).toEqual({
      start: "2026-12-01",
      end: "2026-12-31",
    });
    expect(monthBoundsUtc(new Date("2028-02-29T12:00:00Z")).end).toBe("2028-02-29");
  });

  it("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-09-20", 30)).toBe("2026-10-20");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("not-a-date", 1)).toBe("not-a-date");
  });
});
