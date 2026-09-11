/**
 * Shapes observed against the live API on 2026-09-11 with a pay-as-you-go
 * ("On Demand") account. Each block is a trimmed, synthetic copy of what upstream
 * actually sent, so the mappers stay honest about real field names.
 */

import { describe, expect, it } from "vitest";
import { mapLocation, mapProfile, mapWorkspace } from "../../src/wework/mappers";
import type { RawLocation, RawProfileResponse, RawWorkspace } from "../../src/wework/raw-types";

const LIVE_LOCATION: RawLocation = {
  uuid: "20242b8b-0000-4000-8000-000000000001",
  name: "10 York Rd",
  latitude: 51.503704,
  longitude: -0.1165341,
  address: {
    line1: "10 York Rd",
    line2: "",
    city: "London",
    state: "",
    country: "",
    zip: "SE1 7ND",
  },
  timeZone: "Europe/London",
  // Present even on a city search, relative to nothing useful.
  distance: 5725590.5,
  accountType: 2,
  currency: "GBP",
};

describe("live location item", () => {
  it("maps the IANA zone to a current offset and keeps the building currency", () => {
    const location = mapLocation(LIVE_LOCATION);
    expect(location?.timezone).toBe("Europe/London");
    expect(location?.timezoneOffset).toMatch(/^\+0[01]:00$/);
    expect(location?.currency).toBe("GBP");
    expect(location?.city).toBe("London");
  });
});

describe("live workspace item", () => {
  it("reads the pre-tax day rate from productPrice.price as cashPrice", () => {
    const raw: RawWorkspace = {
      uuid: "519f596a-0000-4000-8000-000000000001",
      inventoryUuid: "c4ce9457-0000-4000-8000-000000000001",
      capacity: 65,
      credits: 0,
      location: LIVE_LOCATION,
      openTime: "08:30",
      closeTime: "18:00",
      productPrice: { price: { currency: "GBP", amount: 70, symbol: "£" } },
      seat: { total: 65, available: 56 },
      reservable: { KubeId: "15769" },
    };
    const space = mapWorkspace(raw, { date: "2026-09-14" });
    expect(space?.cashPrice).toEqual({ amount: 70, currency: "GBP" });
    expect(space?.credits).toBe(0);
    expect(space?.kubeId).toBe("15769");
    expect(space?.location.currency).toBe("GBP");
    expect(space?.startLocal).toBe("2026-09-14T08:30:00");
  });
});

describe("live profile", () => {
  it("finds the membership type under companies and the home location uuid", () => {
    const raw: RawProfileResponse = {
      uuid: "15b2a950-0000-4000-8000-000000000001",
      email: "someone@example.com",
      name: "Test Member",
      homeLocation: {
        uuid: "cec7a8c2-0000-4000-8000-000000000001",
        currency: "USD",
        timeZone: "America/New_York",
      },
      companies: [
        {
          uuid: "371ad8b0-0000-4000-8000-000000000001",
          name: "Example Co",
          preferredMembershipNullable: { membershipType: "On Demand", productName: "On Demand" },
        },
      ],
    };
    const profile = mapProfile(raw, "fallback");
    expect(profile.membershipType).toBe("On Demand");
    expect(profile.homeLocationId).toBe("cec7a8c2-0000-4000-8000-000000000001");
    expect(profile.name).toBe("Test Member");
  });
});
