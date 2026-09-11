/**
 * Test doubles for the service layer.
 *
 * The booking service takes its two collaborators as interfaces (`WeWorkApi`,
 * `SessionRpc`), so neither the network nor a Durable Object is needed to exercise it:
 * `createFakeApi()` is a scripted upstream and `createFakeSession()` is an in-memory
 * implementation of the caps/idempotency/audit RPC that behaves like the real Durable
 * Object for the cases under test.
 *
 * These are deliberately *behavioural* fakes rather than bare stubs — the caps fake
 * really counts bookings, the idempotency fake really stores results — because the
 * interesting bugs in this layer are about sequencing (reserve, then price, then book,
 * then confirm), not about call counts.
 */

import { createBookingService } from "../../src/core/booking-service";
import type {
  BookingServiceDeps,
  BookingServiceImpl,
  ReserveResult,
  SessionRpc,
  WeWorkApi,
} from "../../src/core/booking-service";
import type {
  Actor,
  Booking,
  CapsRemaining,
  Config,
  Credits,
  Location,
  Profile,
  QuotePayload,
  SessionInfo,
  SpaceAvailability,
} from "../../src/core/types";
import { AppError } from "../../src/errors";

/** A 64-character hex key, the shape `parseConfig` enforces for `QUOTE_SIGNING_KEY`. */
export const TEST_QUOTE_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

/** A frozen clock: 2026-09-11T09:00:00Z, a Friday. */
export const NOW_MS = Date.parse("2026-09-11T09:00:00Z");

/** A read+write static-token caller. */
export const READ_WRITE_ACTOR: Actor = {
  kind: "bearer",
  name: "test-token",
  scopes: ["read", "write"],
  accountId: "default",
};

/** A read-only caller, for the scope tests. */
export const READ_ONLY_ACTOR: Actor = {
  kind: "bearer",
  name: "reader",
  scopes: ["read"],
  accountId: "default",
};

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    writeEnabled: true,
    maxBookingsPerDay: 1,
    maxBookingsPerWeek: 5,
    maxCreditsPerBooking: 0,
    quoteTtlSeconds: 600,
    quoteSigningKey: TEST_QUOTE_KEY,
    cookieSigningKey: TEST_QUOTE_KEY,
    adminPassword: "admin",
    authTokens: [],
    loginStrategy: "manual",
    hasWeworkCredentials: false,
    publicBaseUrl: "https://weworking.test",
    secretsPresent: {
      weworkCredentials: false,
      adminPassword: true,
      quoteKey: true,
      cookieKey: true,
      authTokens: 0,
    },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Domain fixtures                                                             */
/* -------------------------------------------------------------------------- */

export function makeLocation(overrides: Partial<Location> = {}): Location {
  return {
    locationId: "loc-poultry",
    name: "1 Poultry",
    address: "1 Poultry, London EC2R 8EJ",
    city: "London",
    country: "GBR",
    timezone: "Europe/London",
    timezoneOffset: "+01:00",
    latitude: 51.5136,
    longitude: -0.0907,
    accountType: 2,
    openTime: "08:00",
    closeTime: "18:00",
    ...overrides,
  };
}

export function makeSpace(overrides: Partial<SpaceAvailability> = {}): SpaceAvailability {
  const location = overrides.location ?? makeLocation();
  return {
    spaceId: "space-1",
    inventoryUuid: "inv-1",
    kubeId: "kube-1",
    spaceName: "Hot Desk, 3rd Floor",
    spaceType: "desk",
    capacity: 1,
    seatsAvailable: 12,
    seatsTotal: 40,
    credits: 1,
    location,
    date: "2026-09-21",
    startLocal: "2026-09-21T08:00:00",
    endLocal: "2026-09-21T18:00:00",
    startUtc: "2026-09-21T07:00:00Z",
    endUtc: "2026-09-21T17:00:00Z",
    timezone: location.timezone,
    ...overrides,
  };
}

export function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    bookingId: "BK-1",
    reservationId: "RES-1",
    locationId: "loc-poultry",
    locationName: "1 Poultry",
    address: "1 Poultry, London EC2R 8EJ",
    date: "2026-09-21",
    startLocal: "2026-09-21T09:00:00",
    endLocal: "2026-09-21T17:00:00",
    timezone: "Europe/London",
    status: "confirmed",
    credits: 1,
    cancelDeadlineLocal: "2026-09-21T08:00:00",
    raw: { ReservationID: "RES-1" },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Fake WeWorkApi                                                              */
/* -------------------------------------------------------------------------- */

/** Script for {@link createFakeApi}; anything omitted gets a sensible default. */
export interface FakeApiScript {
  cities?: string[];
  locationsByCity?: Record<string, Location[]>;
  locationsByGeo?: Location[];
  profile?: Profile | (() => Promise<Profile>);
  credits?: Credits | (() => Promise<Credits | undefined>);
  spaces?: SpaceAvailability[] | ((args: { locationIds: string[]; date: string }) => SpaceAvailability[]);
  bookingSpaceId?: string;
  /** Price returned at booking time — set `credits` differently to simulate a price change. */
  price?: { credits: number; creditRatio: number };
  bookResult?: { reservationId: string; status: string; raw?: unknown };
  bookings?: Booking[];
  /** Make one method reject, to exercise the rollback paths. */
  fail?: Partial<Record<keyof WeWorkApi, AppError>>;
}

/** A fake upstream plus a log of the calls made against it. */
export interface FakeApi {
  api: WeWorkApi;
  calls: Array<{ method: keyof WeWorkApi; args?: unknown }>;
}

export function createFakeApi(script: FakeApiScript = {}): FakeApi {
  const calls: FakeApi["calls"] = [];
  const record = (method: keyof WeWorkApi, args?: unknown): void => {
    calls.push(args === undefined ? { method } : { method, args });
    const failure = script.fail?.[method];
    if (failure) throw failure;
  };

  const api: WeWorkApi = {
    async listCities() {
      record("listCities");
      return script.cities ?? ["London", "New York", "Tokyo"];
    },
    async listLocationsByCity(city) {
      record("listLocationsByCity", { city });
      if (script.locationsByCity) return script.locationsByCity[city] ?? [];
      return city.toLowerCase() === "london" ? [makeLocation()] : [];
    },
    async listLocationsByGeo(args) {
      record("listLocationsByGeo", args);
      return script.locationsByGeo ?? [makeLocation({ distanceKm: 0.4 })];
    },
    async getProfile() {
      record("getProfile");
      if (typeof script.profile === "function") return await script.profile();
      return script.profile ?? { userId: "user-1", email: "member@example.com", name: "Ada" };
    },
    async getMonthlyCredits() {
      record("getMonthlyCredits");
      if (typeof script.credits === "function") return await script.credits();
      return (
        script.credits ?? {
          remaining: 7.5,
          total: 10,
          periodStart: "2026-09-01",
          periodEnd: "2026-09-30",
        }
      );
    },
    async getSpaces(args) {
      record("getSpaces", args);
      if (typeof script.spaces === "function") return script.spaces(args);
      return script.spaces ?? [makeSpace()];
    },
    async resolveBookingSpaceId(space) {
      record("resolveBookingSpaceId", { spaceId: space.spaceId });
      return script.bookingSpaceId ?? space.kubeId ?? space.spaceId;
    },
    async quote(payload: QuotePayload) {
      record("quote", { spaceId: payload.spaceId, credits: payload.credits });
      return script.price ?? { credits: payload.credits, creditRatio: 1 };
    },
    async book(payload, creditRatio) {
      record("book", { spaceId: payload.spaceId, creditRatio });
      return script.bookResult ?? { reservationId: "RES-NEW", status: "BookingSuccess" };
    },
    async listBookings(args) {
      record("listBookings", args);
      return script.bookings ?? [makeBooking()];
    },
    async cancelBooking(booking) {
      record("cancelBooking", { bookingId: booking.bookingId });
    },
  };

  return { api, calls };
}

/* -------------------------------------------------------------------------- */
/* Fake session Durable Object                                                 */
/* -------------------------------------------------------------------------- */

/** Script for {@link createFakeSession}. */
export interface FakeSessionScript {
  sessionInfo?: SessionInfo | (() => Promise<SessionInfo>);
  /** Bookings already taken today / this week, for the cap tests. */
  usedToday?: number;
  usedThisWeek?: number;
  maxPerDay?: number;
  maxPerWeek?: number;
}

/** A fake `WeWorkSession` plus the state and audit trail a test can assert on. */
export interface FakeSession {
  session: SessionRpc;
  audits: Array<{ tool: string; outcome: string; error?: string; dryRun?: boolean }>;
  idempotency: Map<string, unknown>;
  reserved: Set<string>;
  released: string[];
  confirmed: Array<{ bookingKey: string; bookingId: string }>;
  cancelled: string[];
  usedToday: () => number;
}

export function createFakeSession(script: FakeSessionScript = {}): FakeSession {
  const maxPerDay = script.maxPerDay ?? 1;
  const maxPerWeek = script.maxPerWeek ?? 5;
  let usedToday = script.usedToday ?? 0;
  let usedThisWeek = script.usedThisWeek ?? 0;

  const audits: FakeSession["audits"] = [];
  const idempotency = new Map<string, unknown>();
  const reserved = new Set<string>();
  const released: string[] = [];
  const confirmed: FakeSession["confirmed"] = [];
  const cancelled: string[] = [];

  const caps = (): CapsRemaining => ({
    day: Math.max(0, maxPerDay - usedToday),
    week: Math.max(0, maxPerWeek - usedThisWeek),
  });

  const session: SessionRpc = {
    async getSessionInfo() {
      if (typeof script.sessionInfo === "function") return await script.sessionInfo();
      return (
        script.sessionInfo ?? {
          state: "valid",
          source: "manual",
          obtainedAt: "2026-09-11T08:00:00.000Z",
          expiresAt: "2026-09-12T08:00:00.000Z",
          hasRefreshToken: true,
        }
      );
    },
    async reserveBooking({ bookingKey, dryRun }): Promise<ReserveResult> {
      if (caps().day <= 0 || caps().week <= 0) {
        return {
          ok: false,
          code: "CAP_EXCEEDED",
          message: `Daily booking cap of ${maxPerDay} already used.`,
          capsRemaining: caps(),
        };
      }
      if (!dryRun) {
        reserved.add(bookingKey);
        usedToday += 1;
        usedThisWeek += 1;
      }
      return { ok: true, capsRemaining: caps() };
    },
    async confirmBooking(args) {
      confirmed.push(args);
    },
    async releaseBooking({ bookingKey }) {
      if (reserved.delete(bookingKey)) {
        usedToday = Math.max(0, usedToday - 1);
        usedThisWeek = Math.max(0, usedThisWeek - 1);
      }
      released.push(bookingKey);
    },
    async cancelLedger({ bookingId }) {
      cancelled.push(bookingId);
      usedToday = Math.max(0, usedToday - 1);
      usedThisWeek = Math.max(0, usedThisWeek - 1);
    },
    async capsRemaining() {
      return caps();
    },
    async idempotencyGet(key) {
      return idempotency.get(key);
    },
    async idempotencyPut(key, value) {
      idempotency.set(key, value);
    },
    async audit(entry) {
      const record: FakeSession["audits"][number] = { tool: entry.tool, outcome: entry.outcome };
      if (entry.error !== undefined) record.error = entry.error;
      if (entry.dryRun !== undefined) record.dryRun = entry.dryRun;
      audits.push(record);
    },
  };

  return {
    session,
    audits,
    idempotency,
    reserved,
    released,
    confirmed,
    cancelled,
    usedToday: () => usedToday,
  };
}

/* -------------------------------------------------------------------------- */
/* Service under test                                                          */
/* -------------------------------------------------------------------------- */

/** Everything a test touches: the service plus both fakes. */
export interface Harness {
  service: BookingServiceImpl;
  api: FakeApi;
  session: FakeSession;
  config: Config;
  now: () => number;
}

/** Builds a service over the fakes, with a frozen clock at {@link NOW_MS}. */
export function createHarness(
  options: {
    apiScript?: FakeApiScript;
    sessionScript?: FakeSessionScript;
    config?: Partial<Config>;
    nowMs?: number;
    deps?: Partial<BookingServiceDeps>;
  } = {},
): Harness {
  const api = createFakeApi(options.apiScript);
  const session = createFakeSession(options.sessionScript);
  const config = testConfig(options.config);
  const nowMs = options.nowMs ?? NOW_MS;
  const now = (): number => nowMs;

  const service = createBookingService({
    api: api.api,
    session: session.session,
    config,
    quoteKey: config.quoteSigningKey,
    now,
    baseUrl: "https://weworking.test",
    ...options.deps,
  });

  return { service, api, session, config, now };
}

/** A convenience for the many tests that need one fresh quote. */
export async function firstQuote(harness: Harness, date = "2026-09-21"): Promise<string> {
  const results = await harness.service.searchAvailability({ locationId: "loc-poultry", date });
  const first = results[0];
  if (!first) throw new Error("fixture produced no availability");
  return first.quote;
}
