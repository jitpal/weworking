/**
 * Shared scaffolding for the `src/wework/` tests.
 *
 * Pulls the synthetic identity out of the fixtures rather than re-declaring it, so a
 * regenerated fixture cannot silently disagree with the tests that assert on it.
 */

import type { Booking, QuotePayload, SessionRecord, SpaceAvailability } from "../../src/core/types";
import { MemoryTokenStore } from "../../src/session/token-store";
import { mapBooking, mapWorkspace } from "../../src/wework/mappers";
import type { RawLocation, RawUpcomingBooking, RawWorkspace } from "../../src/wework/raw-types";
import spacesFixture from "../fixtures/wework/get-spaces.json";
import locationsFixture from "../fixtures/wework/locations-by-geo.json";
import tokenResponse from "../fixtures/wework/token-response.json";
import upcomingFixture from "../fixtures/wework/upcoming-bookings.json";

/** The fabricated access token every fixture shares. */
export const FIXTURE_ACCESS_TOKEN: string = tokenResponse.access_token;

/** The fabricated refresh token. */
export const FIXTURE_REFRESH_TOKEN: string = tokenResponse.refresh_token;

/** The `https://wework.com/user_uuid` claim inside {@link FIXTURE_ACCESS_TOKEN}. */
export const FIXTURE_USER_UUID = "11111111-2222-4333-8444-555555555555";

/** The token's `exp`, in epoch **milliseconds**. */
export const FIXTURE_EXPIRES_AT_MS = Date.parse("2026-09-21T06:00:00Z");

/** Frozen clock for every test: inside the token's validity window. */
export const NOW_MS = Date.parse("2026-09-20T18:30:00Z");

/** The two fixture locations. */
export const LOCATION_1 = "aaaa1111-0000-4000-8000-000000000001";
export const LOCATION_2 = "aaaa1111-0000-4000-8000-000000000002";

/** The three fixture workspaces. */
export const SPACE_1 = "bbbb2222-0000-4000-8000-000000000001";
export const SPACE_2 = "bbbb2222-0000-4000-8000-000000000002";
export const SPACE_3 = "bbbb2222-0000-4000-8000-000000000003";

export const INVENTORY_1 = "cccc3333-0000-4000-8000-000000000001";
export const INVENTORY_2 = "cccc3333-0000-4000-8000-000000000002";

export const MEMBERS_API = "https://members.wework.com/workplaceone/api";
export const IDP = "https://idp.wework.com";

/** A token store already holding the fixture session. */
export function seededTokenStore(): MemoryTokenStore {
  const record: Omit<SessionRecord, "obtainedAt"> = {
    accessToken: FIXTURE_ACCESS_TOKEN,
    refreshToken: FIXTURE_REFRESH_TOKEN,
    expiresAt: FIXTURE_EXPIRES_AT_MS,
    source: "manual",
    userUuid: FIXTURE_USER_UUID,
  };
  return new MemoryTokenStore(record, () => NOW_MS);
}

/** Frozen clock. */
export const now = (): number => NOW_MS;

/**
 * A quote payload for the Berlin `accountType` 2 location, 09:00-17:00 local
 * (07:00-15:00Z, both on the 30-minute grid).
 */
export function sampleQuote(overrides: Partial<QuotePayload> = {}): QuotePayload {
  return {
    v: 1,
    accountId: "default",
    locationId: LOCATION_1,
    spaceId: SPACE_1,
    wwSpaceId: SPACE_1,
    bookingSpaceId: "kube-space-0001",
    accountType: 2,
    date: "2026-09-21",
    startUtc: "2026-09-21T07:00:00Z",
    endUtc: "2026-09-21T15:00:00Z",
    credits: 10,
    timezone: "Europe/Berlin",
    tzOffset: "+02:00",
    locationName: "Fake Tower",
    address: "100 Example Street, Floor 4",
    city: "Berlin",
    country: "DE",
    state: "Berlin",
    exp: Math.floor(NOW_MS / 1000) + 600,
    ...overrides,
  };
}

/** Parses a recorded request body as JSON. */
export function jsonBody<T = Record<string, unknown>>(body: string | undefined): T {
  if (body === undefined) throw new Error("expected a request body");
  return JSON.parse(body) as T;
}

/** Parses a recorded `application/x-www-form-urlencoded` body. */
export function formBody(body: string | undefined): Record<string, string> {
  if (body === undefined) throw new Error("expected a request body");
  return Object.fromEntries(new URLSearchParams(body).entries());
}

/** The query parameters of a recorded URL. */
export function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

/* -------------------------------------------------------------------------- */
/* Typed fixture accessors                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Indexing a JSON fixture yields `T | undefined` under `noUncheckedIndexedAccess`,
 * and a `!` or a cast in every test would hide a genuinely missing entry. These
 * throw instead, so a regenerated fixture that drops an entry fails loudly.
 */
function at<T>(items: T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture has no ${what} at index ${index}`);
  return item;
}

/** One of the three `get-spaces` workspaces: 0 is accountType 2, 1 and 2 are 4. */
export function fixtureWorkspace(index: 0 | 1 | 2): RawWorkspace {
  return at(spacesFixture.getSharedWorkspaces.workspaces, index, "workspace");
}

/** One of the two raw upcoming-booking items. */
export function fixtureBookingRaw(index: 0 | 1): RawUpcomingBooking {
  return at(upcomingFixture.bookings, index, "booking");
}

/** One of the two raw geo locations: 0 is accountType 2, 1 is accountType 4. */
export function fixtureLocationRaw(index: 0 | 1): RawLocation {
  return at(locationsFixture.locationsByGeo, index, "location");
}

/** The first fixture booking, already mapped to the domain type. */
export function fixtureBooking(): Booking {
  const booking = mapBooking(fixtureBookingRaw(0));
  if (!booking) throw new Error("the fixture booking did not map");
  return booking;
}

/** One fixture workspace, already mapped to the domain type. */
export function fixtureSpace(index: 0 | 1 | 2): SpaceAvailability {
  const space = mapWorkspace(fixtureWorkspace(index), { date: "2026-09-21" });
  if (!space) throw new Error("the fixture workspace did not map");
  return space;
}
