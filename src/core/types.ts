/**
 * Domain types — the shared contract every module in this project speaks.
 *
 * These names are authoritative: the WeWork client maps raw upstream JSON *into*
 * them (`src/wework/mappers.ts`), the booking service orchestrates *over* them,
 * and the MCP tools / REST routes serialise them straight out as
 * `structuredContent` / JSON bodies. Changing a field here is a breaking API
 * change — add optional fields instead.
 *
 * Phase 1 implements hot desks only, but every shape already carries
 * `spaceType` so meeting rooms and private offices can land without a new
 * schema version.
 */

import type { Config } from "../env";

/** Permission granularity for both OAuth access tokens and static bearer tokens. */
export type Scope = "read" | "write" | "admin";

/**
 * The authenticated caller of a tool or REST route, resolved by `src/auth/guard.ts`.
 *
 * - `oauth` — an access token minted by `@cloudflare/workers-oauth-provider`; the
 *   scopes come from the grant's encrypted props.
 * - `bearer` — a static token whose SHA-256 hash is listed in the `AUTH_TOKENS` secret.
 * - `admin` — the signed admin cookie (the `/admin/*` pages).
 */
export interface Actor {
  kind: "oauth" | "bearer" | "admin";
  /** Human-readable label used in the audit log, e.g. the token name. Never a secret. */
  name: string;
  scopes: Scope[];
  /**
   * Tenant seam. Phase 1 is single-account and always uses `"default"`; it exists so a
   * future multi-account deployment can key the Durable Object and quotes per account
   * without changing these types.
   */
  accountId: string;
}

/** Bookable inventory kinds. Phase 1 implements only `"desk"`. */
export type SpaceType = "desk" | "meeting_room" | "private_office";

/** A WeWork building. */
export interface Location {
  /** WeWork location UUID — the stable id used everywhere else in this API. */
  locationId: string;
  name: string;
  address: string;
  city: string;
  /** ISO 3166-1 alpha-2 where upstream provides it, otherwise the upstream string. */
  country: string;
  /** IANA timezone name, e.g. `"Europe/Berlin"`. All `*Local` fields are in this zone. */
  timezone: string;
  latitude?: number;
  longitude?: number;
  /** Straight-line distance from the caller's search point, when the search was geographic. */
  distanceKm?: number;
  /**
   * Upstream `accountType`. Load-bearing: it selects which identifier goes into
   * the booking payload's `SpaceID` (see docs/WEWORK_API.md).
   */
  accountType: number;
  /** Fixed UTC offset string as upstream reports it, e.g. `"+02:00"`. */
  timezoneOffset: string;
  /** Building opening time, local wall clock `"HH:MM"`, when known. */
  openTime?: string;
  /** Building closing time, local wall clock `"HH:MM"`, when known. */
  closeTime?: string;
}

/** One bookable slot at one location on one day, as returned by a search. */
export interface SpaceAvailability {
  /** Upstream workspace UUID. */
  spaceId: string;
  /** Upstream `inventoryUuid`, when present. Needed for `accountType` 4 bookings. */
  inventoryUuid?: string;
  /** Upstream Kube space id, when resolvable. Needed for `accountType` 2 bookings. */
  kubeId?: string;
  spaceName: string;
  spaceType: SpaceType;
  /** Seats in this workspace. */
  capacity: number;
  seatsAvailable: number;
  seatsTotal: number;
  /** WeWork credits the booking would cost. */
  credits: number;
  /** Cash price, only when the account is billed in currency rather than credits. */
  cashPrice?: { amount: number; currency: string };
  location: Location;
  /** Local calendar date, `"YYYY-MM-DD"`. */
  date: string;
  /** Local wall-clock start, ISO-8601 without zone designator, e.g. `"2026-09-14T09:00:00"`. */
  startLocal: string;
  /** Local wall-clock end, same format as `startLocal`. */
  endLocal: string;
  /** True UTC start on a 30-minute boundary, `"...Z"`. */
  startUtc: string;
  /** True UTC end on a 30-minute boundary, `"...Z"`. */
  endUtc: string;
  /** IANA timezone of `startLocal`/`endLocal`; mirrors `location.timezone`. */
  timezone: string;
}

/**
 * The payload inside an HMAC-signed quote token.
 *
 * `create_booking` accepts *only* a quote, never loose parameters: everything the
 * upstream booking call needs is captured here at search time and signed, so an
 * agent cannot invent a booking the user never saw. See `src/core/quote.ts`.
 */
export interface QuotePayload {
  /** Payload version, for forwards-compatible verification. */
  v: 1;
  accountId: string;
  locationId: string;
  /** Our `SpaceAvailability.spaceId`. */
  spaceId: string;
  /** Value for the upstream `WeWorkSpaceID` field (the workspace UUID). */
  wwSpaceId: string;
  /** Value for the upstream `SpaceID` field, already resolved per `accountType`. */
  bookingSpaceId: string;
  accountType: number;
  date: string;
  startUtc: string;
  endUtc: string;
  credits: number;
  timezone: string;
  /** Fixed offset string for the upstream `UTCOffset` field, e.g. `"+02:00"`. */
  tzOffset: string;
  locationName: string;
  address: string;
  city: string;
  country: string;
  state?: string;
  /** Expiry as a Unix timestamp in seconds. */
  exp: number;
  /** `SpaceID` for the upstream *quote* call (`inventoryUuid || uuid`); the booking call uses `bookingSpaceId`. */
  quoteSpaceId?: string;
  /** Human-readable space name, used in the confirmation-email block. */
  spaceName?: string;
  /** Desk capacity, used in the confirmation-email block. */
  capacity?: number;
}

/** A booking, either just created or read back from the upstream bookings list. */
export interface Booking {
  /** WeWork booking UUID — the id accepted by `cancel_booking`. */
  bookingId: string;
  /** Upstream reservation id, when the response carried one. */
  reservationId?: string;
  locationId: string;
  locationName: string;
  address?: string;
  date: string;
  /** Local wall-clock start, e.g. `"2026-09-14T09:00:00"`. */
  startLocal: string;
  /** Local wall-clock end. */
  endLocal: string;
  timezone: string;
  status: "confirmed" | "cancelled" | "pending" | "unknown";
  credits: number;
  /** Last local wall-clock time at which this booking can still be cancelled, when known. */
  cancelDeadlineLocal?: string;
  /** Redacted upstream body, only attached in debug paths. Never returned to agents by default. */
  raw?: unknown;
}

/** Credit balance for the current membership period. */
export interface Credits {
  remaining: number;
  total: number;
  /** `"YYYY-MM-DD"`. */
  periodStart: string;
  /** `"YYYY-MM-DD"`. */
  periodEnd: string;
}

/** The WeWork member this deployment acts as. */
export interface Profile {
  userId: string;
  email?: string;
  name?: string;
  membershipType?: string;
  homeLocationId?: string;
}

/**
 * Health of the stored WeWork session, safe to expose publicly:
 * it never contains a token.
 */
export interface SessionInfo {
  /** `expiring` means valid but inside the proactive-refresh window. */
  state: "none" | "valid" | "expiring" | "expired";
  source: "login" | "manual" | "refresh" | "none";
  /** ISO-8601 UTC. */
  obtainedAt?: string;
  /** ISO-8601 UTC. */
  expiresAt?: string;
  hasRefreshToken: boolean;
  /** Last failure message from a login/refresh attempt, already redacted. */
  lastError?: string;
}

/**
 * The stored credential. Lives only inside the `WeWorkSession` Durable Object
 * and must never cross a tool, REST or log boundary.
 */
export interface SessionRecord {
  /** Auth0 access token — this *is* the bearer for the WeWork member API. */
  accessToken: string;
  refreshToken?: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
  /** Unix epoch milliseconds. */
  obtainedAt: number;
  source: "login" | "manual" | "refresh";
  /** The `https://wework.com/user_uuid` JWT claim; required by the `WeWorkUUID` header. */
  userUuid: string;
}

/**
 * Worker-side view of the token, backed by the Durable Object.
 *
 * Implementations coalesce concurrent refreshes, so callers may call
 * `getAccessToken()` freely on every upstream request.
 */
export interface TokenStore {
  getAccessToken(opts?: { forceRefresh?: boolean }): Promise<{
    accessToken: string;
    userUuid: string;
  }>;
  getSessionInfo(): Promise<SessionInfo>;
  /** `obtainedAt` is stamped by the store, not the caller. */
  setSession(rec: Omit<SessionRecord, "obtainedAt">): Promise<void>;
  clear(): Promise<void>;
}

/** A way of obtaining a fresh `SessionRecord` from WeWork. */
export interface LoginStrategy {
  name: "headless" | "manual";
  login(): Promise<SessionRecord>;
}

/* -------------------------------------------------------------------------- */
/* Booking service                                                             */
/* -------------------------------------------------------------------------- */

/** Arguments for {@link BookingService.listLocations}. */
export interface ListLocationsArgs {
  /** Free-text match against location name/address. */
  query?: string;
  city?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  limit?: number;
}

/** Arguments for {@link BookingService.searchAvailability}. */
export interface SearchAvailabilityArgs {
  /** Either `locationId` or `city` must be supplied. */
  locationId?: string;
  city?: string;
  /** Local calendar date, `"YYYY-MM-DD"`. */
  date: string;
  /** Local wall-clock `"HH:MM"`; defaults to the building's opening time. */
  startTime?: string;
  /** Local wall-clock `"HH:MM"`; defaults to the building's closing time. */
  endTime?: string;
  /** Phase 1 only supports `"desk"`; anything else raises `UNSUPPORTED_SPACE_TYPE`. */
  spaceType?: SpaceType;
  /** Minimum seats required. */
  capacity?: number;
}

/**
 * A search result with the signed quote that `createBooking` requires, plus a
 * one-line human summary for the agent to read back to the user.
 */
export type AvailabilityResult = SpaceAvailability & { quote: string; summary: string };

/** Arguments for {@link BookingService.createBooking}. */
export interface CreateBookingArgs {
  /** A quote string produced by `searchAvailability`. The only accepted input. */
  quote: string;
  /** Caller-supplied replay guard; a repeat returns the first result verbatim. */
  idempotencyKey?: string;
  /** Validate, price and check caps without calling upstream. */
  dryRun?: boolean;
  /** Free-text note stored on the booking. */
  note?: string;
}

/** How many further bookings the caps allow after this operation. */
export interface CapsRemaining {
  day: number;
  week: number;
}

/** Result of {@link BookingService.createBooking}. */
export interface CreateBookingResult {
  booking: Booking;
  dryRun: boolean;
  creditsCharged: number;
  capsRemaining: CapsRemaining;
  summary: string;
}

/** Arguments for {@link BookingService.listBookings}. */
export interface ListBookingsArgs {
  /** Local calendar date, inclusive. Defaults to today. */
  from?: string;
  /** Local calendar date, inclusive. Defaults to `from` + 30 days. */
  to?: string;
  includePast?: boolean;
}

/** Arguments for {@link BookingService.cancelBooking}. */
export interface CancelBookingArgs {
  bookingId: string;
  idempotencyKey?: string;
  dryRun?: boolean;
}

/** Result of {@link BookingService.cancelBooking}. */
export interface CancelBookingResult {
  bookingId: string;
  status: Booking["status"];
  creditsRefunded?: number;
  summary: string;
}

/** The configured safety limits, echoed to callers so agents can self-regulate. */
export interface CapsConfig {
  maxBookingsPerDay: number;
  maxBookingsPerWeek: number;
  /** `0` means unlimited. */
  maxCreditsPerBooking: number;
}

/** Result of {@link BookingService.whoami}. */
export interface WhoamiResult {
  profile: Profile;
  credits?: Credits;
  session: SessionInfo;
  actor: Actor;
  caps: CapsConfig;
  writeEnabled: boolean;
}

/**
 * The single orchestration surface. Both the MCP tools (`src/mcp/tools.ts`) and the
 * REST routes (`src/http/api.ts`) call exactly these six methods and serialise the
 * results unchanged — there is no business logic above this interface.
 *
 * Every method rejects with an {@link ../errors!AppError} carrying a machine-readable
 * `code` and an agent-actionable `hint`.
 */
export interface BookingService {
  listLocations(args?: ListLocationsArgs): Promise<Location[]>;
  searchAvailability(args: SearchAvailabilityArgs): Promise<AvailabilityResult[]>;
  /** Requires the `write` scope and `WRITE_ENABLED`. */
  createBooking(args: CreateBookingArgs, actor: Actor): Promise<CreateBookingResult>;
  listBookings(args?: ListBookingsArgs): Promise<Booking[]>;
  /** Requires the `write` scope and `WRITE_ENABLED`. */
  cancelBooking(args: CancelBookingArgs, actor: Actor): Promise<CancelBookingResult>;
  whoami(actor: Actor): Promise<WhoamiResult>;
}

/* -------------------------------------------------------------------------- */
/* Dependency injection                                                        */
/* -------------------------------------------------------------------------- */

/** Parsed, validated configuration. Defined in `src/env.ts`, re-exported here for convenience. */
export type { Config };

/**
 * Everything the service layer needs, injected rather than imported, so tests can
 * run with a fake `fetch`, a frozen clock and an in-memory token store.
 *
 * `session` is the raw Durable Object stub; prefer `tokenStore` for token access and
 * reach for the stub directly only for caps, idempotency and audit RPC.
 */
export interface Deps<TSession extends Rpc.DurableObjectBranded = Rpc.DurableObjectBranded> {
  config: Config;
  tokenStore: TokenStore;
  /** Injected so tests never touch the network. Always call through this, never global `fetch`. */
  fetch: typeof fetch;
  /** Injected clock, Unix epoch milliseconds. */
  now(): number;
  session: DurableObjectStub<TSession>;
}
