/**
 * `WeWorkClient` — every members.wework.com call this worker makes, in one place.
 *
 * Design rules, all of them load-bearing:
 *
 * - **`fetch` and `now()` are injected.** Nothing here reaches for a global, so the
 *   whole client is unit-testable against `test/helpers/fake-fetch.ts` with a frozen
 *   clock, and no test can accidentally hit the real API.
 * - **The token comes from a `TokenStore`, never a constructor argument.** A 401
 *   triggers exactly one `getAccessToken({ forceRefresh: true })` and one retry;
 *   refresh coalescing is the store's problem, not ours.
 * - **HTTP 200 is not success.** WeWork returns `{responseStatus:{type:"error"}}`
 *   with a 200, and — worse — returns a *refused booking* with a 200. Both are
 *   caught here and turned into `AppError`s, so no caller can mistake a refusal for
 *   a reservation.
 * - **This layer does no policy.** Caps, quotes, idempotency, `WRITE_ENABLED` and
 *   audit all live in `src/core/booking-service.ts`. The client maps, validates
 *   shapes, and translates errors.
 *
 * Endpoint and payload details come from `docs/WEWORK_API.md`. Anything marked
 * *inferred* there is inferred here too; the fixtures in `test/fixtures/wework/` are
 * hand-written to those notes, not recorded, so the first live run is the real test.
 */

import type {
  Booking,
  Credits,
  Location,
  Profile,
  QuotePayload,
  SpaceAvailability,
  SpaceType,
  TokenStore,
} from "../core/types";
import { AppError, toErrorBody } from "../errors";
import { redact } from "../redact";
import { DESKTOP_USER_AGENT, type HeaderVariant, MEMBERS_API_BASE, weworkHeaders } from "./headers";
import {
  arrayAt,
  assertOnGrid,
  bool,
  first,
  mapBooking,
  mapCities,
  mapCredits,
  mapLocation,
  mapLocations,
  mapProfile,
  mapWorkspace,
  normaliseUtcStamp,
  num,
  offsetStringForZone,
  str,
  utcIsoToZonedWallClock,
} from "./mappers";
import type {
  BookingRequestBody,
  CancelRequestBody,
  MailData,
  QuotePayloadWithQuoteSpaceId,
  QuoteRequestBody,
  RawBookingResponse,
  RawInventoryDetailsResponse,
  RawLocation,
  RawMonthlyCreditsResponse,
  RawProfileResponse,
  RawQuoteResponse,
  RawUpcomingBooking,
} from "./raw-types";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Half-width of the bounding box sent with a geographic location search.
 *
 * `0.13` degrees is what the members web app sends — roughly 14 km of latitude, and
 * less in longitude the further from the equator you go. It is kept fixed rather
 * than derived from `radiusKm` so the request matches captured traffic byte for
 * byte; `radiusKm` filters the *results* instead (see {@link WeWorkClient.listLocationsByGeo}).
 */
export const GEO_BOUNDING_BOX_DEGREES = 0.13;

/** `SpaceType` in the quote and booking payloads. `4` is a shared desk. */
export const BOOKING_SPACE_TYPE = 4;

/** `bookingType` in the cancel payload. */
export const CANCEL_BOOKING_TYPE = 4;

/** `workspaceType` inside the cancel payload's `mailParams`. */
export const CANCEL_WORKSPACE_TYPE = 1;

/** Currency sentinel meaning "bill this to the credit allowance". */
export const CREDITS_CURRENCY = "com.wework.credits";

/** `type` query parameter on `get-spaces`. `0` is the shared-workspace/hot-desk type. */
export const GET_SPACES_TYPE_DESK = 0;

/** Slot granularity the `get-spaces` search asks for, in minutes. */
export const GET_SPACES_DURATION = 30;

/** Page size for `get-spaces`. */
export const GET_SPACES_LIMIT = 50;

/** Default window for {@link WeWorkClient.listBookings} when no `to` is given. */
const DEFAULT_BOOKING_WINDOW_DAYS = 30;

/** Markers that identify a Cloudflare/bot-protection interstitial rather than an API error. */
const BLOCK_MARKERS = /cf-chl|cf_chl_opt|Attention Required! \| Cloudflare|Just a moment/i;

/* -------------------------------------------------------------------------- */
/* Public surface                                                              */
/* -------------------------------------------------------------------------- */

/** Arguments for {@link WeWorkApi.listLocationsByGeo}. */
export interface GeoSearchArgs {
  lat: number;
  lng: number;
  /** Filters the returned buildings by computed `distanceKm`. Does not change the request. */
  radiusKm?: number;
}

/** Arguments for {@link WeWorkApi.getSpaces}. */
export interface GetSpacesArgs {
  locationIds: string[];
  /** Local calendar date, `"YYYY-MM-DD"`. */
  date: string;
  /** Only `"desk"` is implemented; anything else raises `UNSUPPORTED_SPACE_TYPE`. */
  spaceType?: SpaceType;
  /** Minimum seats; `0` or absent means no constraint. */
  capacity?: number;
  /**
   * Optional: the searched location's UTC offset, e.g. `"+02:00"`, which upstream
   * uses to decide where the requested day starts. The client fills it from any
   * location it has already seen; pass it when you know it and have not listed
   * locations in this request.
   */
  locationOffset?: string;
  /** Narrows the returned window inside the building's opening hours, `"HH:MM"`. */
  startTime?: string;
  endTime?: string;
}

/** Arguments for {@link WeWorkApi.listBookings}. */
export interface ListBookingsArgs {
  /** `"YYYY-MM-DD"`, inclusive. Defaults to today (UTC). */
  from?: string;
  /** `"YYYY-MM-DD"`, inclusive. Defaults to `from` + 30 days. */
  to?: string;
  includePast?: boolean;
}

/** What `POST /common-booking/quote` tells us. */
export interface QuoteResult {
  credits: number;
  /** Opaque multiplier the booking call must echo back verbatim. */
  creditRatio: number;
  amount?: number;
  currency?: string;
}

/** What `POST /common-booking/` tells us on success. */
export interface BookResult {
  reservationId: string;
  status: string;
  raw?: unknown;
}

/**
 * The upstream surface the booking service talks to.
 *
 * Everything is a domain type in and out; no raw upstream shape crosses this
 * boundary, with the single documented exception of `Booking.raw`, which the cancel
 * payload needs.
 */
export interface WeWorkApi {
  listCities(): Promise<string[]>;
  listLocationsByCity(city: string): Promise<Location[]>;
  listLocationsByGeo(args: GeoSearchArgs): Promise<Location[]>;
  getProfile(): Promise<Profile>;
  getMonthlyCredits(now?: Date): Promise<Credits | undefined>;
  getSpaces(args: GetSpacesArgs): Promise<SpaceAvailability[]>;
  resolveBookingSpaceId(space: SpaceAvailability): Promise<string>;
  quote(q: QuotePayload): Promise<QuoteResult>;
  book(q: QuotePayload, creditRatio: number): Promise<BookResult>;
  listBookings(args: ListBookingsArgs): Promise<Booking[]>;
  cancelBooking(booking: Booking): Promise<void>;
}

/** Constructor options for {@link WeWorkClient}. */
export interface WeWorkClientOptions {
  /** Injected `fetch`. Required — the client never uses the global. */
  fetch: typeof fetch;
  tokens: TokenStore;
  /** Injected clock (epoch ms). */
  now?: () => number;
  userAgent?: string;
  /**
   * Durable building metadata, normally the session Durable Object. Lets a search
   * by bare `location_id` send the right `locationOffset` even in a cold isolate.
   */
  locationStore?: LocationStore;
}

/** Persistent building metadata shared across isolates. */
export interface LocationStore {
  get(locationId: string): Promise<Location | undefined>;
  put(locations: Location[]): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export class WeWorkClient implements WeWorkApi {
  readonly #fetch: typeof fetch;
  readonly #tokens: TokenStore;
  readonly #now: () => number;
  readonly #userAgent: string;

  /**
   * Locations seen in this request, by id.
   *
   * `get-spaces` needs the building's UTC offset as a query parameter, and returns
   * only a partial location in its payload. Caching what `listLocations*` already
   * fetched avoids both an extra subrequest and a wrong day boundary. Per-instance,
   * so it never outlives a request.
   */
  readonly #locations = new Map<string, Location>();
  readonly #locationStore: LocationStore | undefined;

  constructor(opts: WeWorkClientOptions) {
    this.#fetch = opts.fetch;
    this.#tokens = opts.tokens;
    this.#now = opts.now ?? Date.now;
    this.#userAgent = opts.userAgent ?? DESKTOP_USER_AGENT;
    this.#locationStore = opts.locationStore;
  }

  /** Distinct city names WeWork has on-demand inventory in. */
  async listCities(): Promise<string[]> {
    const body = await this.#call({
      method: "GET",
      path: "/wework-yardi/location/get-city-details",
      label: "list cities",
    });
    return mapCities(arrayAt(body, "cityDetails", "cities", "data"));
  }

  /**
   * Buildings in a city.
   *
   * Uses the same `get-locations-by-geo` endpoint as the geographic search — with
   * `city` set and no coordinates, upstream treats it as a city lookup.
   */
  async listLocationsByCity(city: string): Promise<Location[]> {
    const body = await this.#call({
      method: "GET",
      path: "/wework-yardi/ondemand/get-locations-by-geo",
      label: "list locations by city",
      query: {
        isAuthenticated: true,
        city,
        isOnDemandUser: false,
        isWeb: true,
      },
    });
    const items = arrayAt(body, "locationsByGeo", "locations");
    const mapped = mapLocations(items);
    // No search origin, so any upstream distance is relative to nothing useful.
    for (const location of mapped) delete location.distanceKm;
    return this.#rememberLocations(mapped);
  }

  /**
   * Buildings near a point.
   *
   * The request always carries the same +/-{@link GEO_BOUNDING_BOX_DEGREES} box the
   * web app sends. `radiusKm`, when given, filters the mapped results by their
   * computed `distanceKm` — so a tighter radius never *widens* what upstream
   * returns, and the request stays identical to captured traffic.
   */
  async listLocationsByGeo(args: GeoSearchArgs): Promise<Location[]> {
    const delta = GEO_BOUNDING_BOX_DEGREES;
    const body = await this.#call({
      method: "GET",
      path: "/wework-yardi/ondemand/get-locations-by-geo",
      label: "list locations by geo",
      query: {
        isAuthenticated: true,
        city: "",
        isOnDemandUser: false,
        isWeb: true,
        userLatitude: args.lat,
        userLongitude: args.lng,
        // North-west corner: higher latitude, lower longitude.
        boundnwLat: round6(args.lat + delta),
        boundnwLng: round6(args.lng - delta),
        // South-east corner: lower latitude, higher longitude.
        boundseLat: round6(args.lat - delta),
        boundseLng: round6(args.lng + delta),
      },
    });

    const origin = { lat: args.lat, lng: args.lng };
    let locations = mapLocations(arrayAt(body, "locationsByGeo", "locations"), { origin });
    if (args.radiusKm !== undefined) {
      const limit = args.radiusKm;
      locations = locations.filter(
        (location) => location.distanceKm === undefined || location.distanceKm <= limit,
      );
    }
    locations.sort(
      (a, b) =>
        (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY),
    );
    return this.#rememberLocations(locations);
  }

  /** The member this deployment acts as. */
  async getProfile(): Promise<Profile> {
    const { userUuid } = await this.#tokens.getAccessToken();
    const body = await this.#call({
      method: "GET",
      path: "/wework-yardi/user/get-user-profile",
      label: "get profile",
    });
    return mapProfile((body ?? {}) as RawProfileResponse, userUuid);
  }

  /**
   * Credit balance for the calendar month containing `now`.
   *
   * Month boundaries are computed in UTC, which is what the endpoint's `startDate`
   * and `endDate` mean — the allowance is a billing-period fact, not a local one.
   * Returns `undefined` for an account that is not billed in credits.
   */
  async getMonthlyCredits(now?: Date): Promise<Credits | undefined> {
    const reference = now ?? new Date(this.#now());
    const { start, end } = monthBoundsUtc(reference);

    const body = await this.#call({
      method: "GET",
      path: "/common-account/monthly-credits",
      label: "get monthly credits",
      query: { startDate: start, endDate: end },
    });
    if (body === null || typeof body !== "object") return undefined;
    return mapCredits(body as RawMonthlyCreditsResponse, { start, end });
  }

  /**
   * Hot-desk availability at one or more buildings on one local date.
   *
   * @throws {AppError} `UNSUPPORTED_SPACE_TYPE` for anything but `"desk"`,
   * `VALIDATION` when `locationIds` is empty or `date` is malformed.
   */
  async getSpaces(args: GetSpacesArgs): Promise<SpaceAvailability[]> {
    const spaceType = args.spaceType ?? "desk";
    if (spaceType !== "desk") {
      throw new AppError(
        "UNSUPPORTED_SPACE_TYPE",
        `Phase 1 books hot desks only; "${spaceType}" is not implemented.`,
      );
    }
    if (args.locationIds.length === 0) {
      throw new AppError("VALIDATION", "getSpaces needs at least one location id.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
      throw new AppError("VALIDATION", `date must be YYYY-MM-DD, got "${args.date}".`);
    }

    // The offset must match the building, or upstream answers with an empty list
    // (live-verified for New York). Known buildings come from the in-memory cache or
    // the durable store; an unknown one gets a first pass at +00:00 and a second at
    // the offset its own results reveal.
    const knownOffset = args.locationOffset ?? (await this.#offsetFor(args.locationIds, args.date));
    let body = await this.#getSpacesRaw(args, knownOffset ?? "+00:00");
    if (knownOffset === undefined) {
      const revealed = this.#offsetRevealedBy(body);
      if (revealed && revealed !== "+00:00") {
        body = await this.#getSpacesRaw(args, revealed);
      }
    }

    const workspaces = arrayAt(
      (body as { getSharedWorkspaces?: unknown } | null)?.getSharedWorkspaces ?? body,
      "workspaces",
    );

    if (workspaces.length === 0) {
      // Keys only: enough to tell "nothing available" from "shape we do not read".
      const top = body && typeof body === "object" ? Object.keys(body as object) : typeof body;
      const inner = (body as { getSharedWorkspaces?: unknown } | null)?.getSharedWorkspaces;
      console.warn("get-spaces returned no workspaces", {
        locationIds: args.locationIds.length,
        locationOffset: knownOffset ?? "+00:00 (unknown building)",
        date: args.date,
        topLevelKeys: top,
        sharedWorkspacesKeys:
          inner && typeof inner === "object" ? Object.keys(inner) : typeof inner,
        totalCount: (inner as { totalCount?: unknown } | undefined)?.totalCount,
      });
    }

    const out: SpaceAvailability[] = [];
    for (const value of workspaces) {
      if (typeof value !== "object" || value === null) continue;
      const mapArgs: Parameters<typeof mapWorkspace>[1] = { date: args.date };
      if (args.startTime !== undefined) mapArgs.startTime = args.startTime;
      if (args.endTime !== undefined) mapArgs.endTime = args.endTime;
      const nestedId = str((value as { location?: { uuid?: unknown } }).location?.uuid);
      const cached = nestedId ? this.#locations.get(nestedId) : undefined;
      if (cached) mapArgs.fallbackLocation = cached;

      const mapped = mapWorkspace(value, mapArgs);
      if (!mapped) continue;
      if (
        args.capacity !== undefined &&
        args.capacity > 0 &&
        mapped.seatsAvailable < args.capacity
      ) {
        continue;
      }
      this.#locations.set(mapped.location.locationId, mapped.location);
      out.push(mapped);
    }
    if (out.length > 0) await this.#rememberLocations(out.map((space) => space.location));
    return out;
  }

  /**
   * The identifier that must go into the booking payload's `SpaceID`.
   *
   * Prefers `inventory-details.kubeSpaceId`, which is what the current members web
   * app uses and works across account types. That endpoint's parameter names were
   * renamed in Aug 2026 and it is the least-verified call in this client, so a
   * failure or an empty answer is *not* fatal: we fall back to the documented
   * `accountType` rules (2 -> `reservable.KubeId`, 4 -> `inventoryUuid`,
   * otherwise the workspace `uuid`), and then to the workspace uuid if even the
   * preferred id for that account type is missing.
   */
  async resolveBookingSpaceId(space: SpaceAvailability): Promise<string> {
    // `accountType` 2 buildings hand the booking id straight to get-spaces as
    // `reservable.KubeId` (live-verified); inventory-details answers HTTP 500 for
    // them, so it is only consulted when that id is missing.
    if (space.location.accountType === 2 && space.kubeId) return space.kubeId;
    const kubeSpaceId = await this.#tryInventoryDetails(space);
    if (kubeSpaceId) return kubeSpaceId;
    return spaceIdByAccountType(space);
  }

  /**
   * Prices a booking.
   *
   * @throws {AppError} `VALIDATION` when the quote's times are off the 30-minute
   * grid, `UPSTREAM_ERROR` when upstream returns no credit ratio.
   */
  async quote(q: QuotePayload): Promise<QuoteResult> {
    const payload = q as QuotePayloadWithQuoteSpaceId;
    // The quote call wants `inventoryUuid || uuid`, which is not always the same id
    // the booking call wants. `quoteSpaceId` carries it when the caller knows it.
    const spaceId = payload.quoteSpaceId ?? q.bookingSpaceId;
    const body = (await this.#call({
      method: "POST",
      path: "/common-booking/quote",
      label: "quote",
      body: buildQuoteBody(payload, spaceId),
    })) as RawQuoteResponse | null;

    // Credit accounts get a creditRatio; pay-as-you-go accounts may not. The
    // booking call echoes whatever we have, and `0` matches what the web app sends
    // when there is none.
    const creditRatio = first(num(body?.grandTotal?.creditRatio), num(body?.creditRatio), 0) ?? 0;

    const result: QuoteResult = {
      credits: first(num(body?.grandTotal?.credits), num(body?.credits), q.credits) ?? q.credits,
      creditRatio,
    };
    const amount = first(num(body?.grandTotal?.total), num(body?.grandTotal?.amount));
    // `currency` echoes the request; only a real ISO code is worth keeping.
    const currency = str(body?.grandTotal?.currency);
    if (amount !== undefined) result.amount = amount;
    if (currency && /^[A-Z]{3}$/.test(currency)) result.currency = currency;
    return result;
  }

  /**
   * Books the desk described by a verified quote.
   *
   * WeWork answers HTTP 200 whether or not it booked anything, so success requires
   * all three of: `BookingStatus === "BookingSuccess"`, a non-empty `ReservationID`,
   * and no `Errors`. Anything else is a refusal.
   *
   * @throws {AppError} `BOOKING_REFUSED` carrying the upstream message,
   * `VALIDATION` for off-grid times.
   */
  async book(q: QuotePayload, creditRatio: number): Promise<BookResult> {
    const payload = q as QuotePayloadWithQuoteSpaceId;
    const body = (await this.#call({
      method: "POST",
      path: "/common-booking/",
      label: "book",
      body: buildBookingBody(payload, creditRatio),
    })) as RawBookingResponse | null;

    const status = str(body?.BookingStatus) ?? "";
    const reservationId = first(str(body?.ReservationID), str(body?.ReservationId)) ?? "";
    const errorMessage = bookingErrorMessage(body);

    if (status !== "BookingSuccess" || !reservationId || errorMessage) {
      throw new AppError(
        "BOOKING_REFUSED",
        errorMessage ??
          (status
            ? `WeWork declined the booking with status "${status}".`
            : "WeWork declined the booking without giving a reason."),
        { details: redact({ bookingStatus: status, reservationId: reservationId || undefined }) },
      );
    }

    return { reservationId, status, raw: body };
  }

  /**
   * Upcoming (or, with `includePast`, past) bookings.
   *
   * The upstream times are local wall clock stamped `Z`; `mapBooking` re-anchors
   * them rather than converting. Results are filtered to `[from, to]` locally as
   * well, because upstream has been observed ignoring the date parameters.
   */
  async listBookings(args: ListBookingsArgs = {}): Promise<Booking[]> {
    const from = args.from ?? isoDateUtc(this.#now());
    const to = args.to ?? addDays(from, DEFAULT_BOOKING_WINDOW_DAYS);

    const body = await this.#call({
      method: "GET",
      path: "/common-booking/get-app-upcoming-bookings",
      label: "list bookings",
      query: {
        isPastBooking: args.includePast === true,
        platFormType: 1,
        startDate: from,
        endDate: to,
      },
    });

    const items = arrayAt(body, "bookings", "upcomingBookings", "appUpcomingBookings");
    const out: Booking[] = [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const mapped = mapBooking(item as RawUpcomingBooking);
      if (!mapped) continue;
      if (mapped.date < from || mapped.date > to) continue;
      out.push(mapped);
    }
    out.sort((a, b) => a.startLocal.localeCompare(b.startLocal));
    return out;
  }

  /**
   * Cancels a booking.
   *
   * Needs the raw upcoming-booking item (`Booking.raw`), because the cancel payload
   * carries `reservableId`, `spaceId`, `sourceType` and the approval flag, none of
   * which are in the domain type. Call {@link listBookings} first.
   *
   * @throws {AppError} `VALIDATION` when `Booking.raw` is missing, `UPSTREAM_ERROR`
   * when upstream does not answer with a literal `true`.
   */
  async cancelBooking(booking: Booking): Promise<void> {
    const body = await this.#call({
      method: "POST",
      path: "/common-booking/cancel",
      label: "cancel booking",
      variant: "cancel",
      query: { isOnDemand: false, platFormType: 1 },
      body: buildCancelBody(booking),
    });

    // The endpoint answers with the JSON literal `true`.
    if (body === true) return;
    if (bool(body) === true) return;
    if (
      typeof body === "object" &&
      body !== null &&
      /success/i.test(
        str((body as { responseStatus?: { type?: unknown } }).responseStatus?.type) ?? "",
      )
    ) {
      return;
    }

    throw new AppError("UPSTREAM_ERROR", "WeWork did not confirm the cancellation.", {
      details: redact({ response: body }),
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Internals                                                                */
  /* ------------------------------------------------------------------------ */

  /** One upstream call, with the 401-retry and the error taxonomy applied. */
  async #call(spec: {
    method: "GET" | "POST";
    path: string;
    label: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    variant?: HeaderVariant;
  }): Promise<unknown> {
    const url = buildUrl(spec.path, spec.query);

    let response = await this.#send(url, spec, false);
    if (response.status === 401) {
      // The stored token was rejected: force a refresh and try exactly once more.
      // A second 401 means the credential itself is dead, not stale.
      response = await this.#send(url, spec, true);
    }
    return await this.#parse(response, spec.label);
  }

  async #send(
    url: string,
    spec: { method: "GET" | "POST"; body?: unknown; variant?: HeaderVariant },
    forceRefresh: boolean,
  ): Promise<Response> {
    const { accessToken, userUuid } = await this.#tokens.getAccessToken(
      forceRefresh ? { forceRefresh: true } : undefined,
    );
    const headerArgs: Parameters<typeof weworkHeaders>[0] = {
      accessToken,
      userUuid,
      userAgent: this.#userAgent,
      json: spec.method === "POST",
    };
    if (spec.variant !== undefined) headerArgs.variant = spec.variant;

    const init: RequestInit = {
      method: spec.method,
      headers: weworkHeaders(headerArgs),
      redirect: "follow",
    };
    if (spec.body !== undefined) init.body = JSON.stringify(spec.body);
    return await this.#fetch(url, init);
  }

  /** Maps an upstream response to parsed JSON or an {@link AppError}. */
  async #parse(response: Response, label: string): Promise<unknown> {
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new AppError("UPSTREAM_RATE_LIMITED", `WeWork rate-limited the "${label}" request.`, {
        details: retryAfter ? { retryAfter } : undefined,
      });
    }

    const text = await response.text().catch(() => "");

    if (response.status === 401) {
      throw new AppError(
        "UPSTREAM_AUTH",
        `WeWork rejected the stored session on the "${label}" request.`,
      );
    }
    if (response.status === 403) {
      if (BLOCK_MARKERS.test(text)) {
        throw new AppError(
          "UPSTREAM_BLOCKED",
          `A Cloudflare challenge blocked the "${label}" request.`,
        );
      }
      throw new AppError("UPSTREAM_AUTH", `WeWork refused the "${label}" request with HTTP 403.`);
    }
    if (response.status === 404) {
      throw new AppError("NOT_FOUND", `WeWork has no such resource for the "${label}" request.`);
    }

    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = text.trim() === "" ? null : JSON.parse(text);
    } catch {
      parseFailed = true;
    }

    if (parseFailed) {
      console.warn(
        "[wework] non-JSON upstream response",
        redact({ label, status: response.status, bytes: text.length }),
      );
      throw new AppError(
        "UPSTREAM_ERROR",
        `WeWork returned a non-JSON body for the "${label}" request (HTTP ${response.status}).`,
      );
    }

    if (!response.ok) {
      throw new AppError(
        "UPSTREAM_ERROR",
        `WeWork returned HTTP ${response.status} for the "${label}" request${
          envelopeMessage(parsed) ? `: ${envelopeMessage(parsed)}` : ""
        }.`,
      );
    }

    // A 200 with an error envelope is the normal way this API reports failure.
    if (isErrorEnvelope(parsed)) {
      throw new AppError(
        "UPSTREAM_ERROR",
        envelopeMessage(parsed) ?? `WeWork reported an error on the "${label}" request.`,
      );
    }

    return parsed;
  }

  /** `inventory-details`, swallowing every failure. See {@link resolveBookingSpaceId}. */
  async #tryInventoryDetails(space: SpaceAvailability): Promise<string | undefined> {
    try {
      const body = (await this.#call({
        method: "GET",
        path: "/common-booking/inventory-details",
        label: "inventory details",
        query: {
          propertyGuid: space.location.locationId,
          spaceGuid: space.spaceId,
          applicationType: "WorkplaceOne",
        },
      })) as RawInventoryDetailsResponse | null;

      return first(
        str(body?.kubeSpaceId),
        str(body?.KubeSpaceId),
        str(body?.inventoryDetails?.kubeSpaceId),
        str(body?.inventoryDetails?.KubeSpaceId),
      );
    } catch (error) {
      console.warn(
        "[wework] inventory-details unavailable, falling back to accountType rules",
        redact({
          locationId: space.location.locationId,
          accountType: space.location.accountType,
          error,
        }),
      );
      return undefined;
    }
  }

  async #rememberLocations(locations: Location[]): Promise<Location[]> {
    for (const location of locations) this.#locations.set(location.locationId, location);
    if (this.#locationStore && locations.length > 0) {
      // Awaited on purpose: Workers drop un-awaited work once the response is sent.
      try {
        await this.#locationStore.put(locations);
      } catch (err) {
        console.warn("location store write failed", toErrorBody(err));
      }
    }
    return locations;
  }

  /** The UTC offset to send with `get-spaces`, from any location we have seen. */
  /**
   * The building's UTC offset *on the requested date*, so a search across a
   * daylight-saving change sends the offset WeWork expects for that day rather than
   * today's. Falls back to the stored offset when the zone is unknown.
   */
  async #offsetFor(locationIds: string[], date: string): Promise<string | undefined> {
    const known = await this.#locationFor(locationIds);
    if (!known) return undefined;
    return (
      offsetStringForZone(known.timezone, Date.parse(`${date}T12:00:00Z`)) ?? known.timezoneOffset
    );
  }

  /** The first of these buildings we know, from memory or the durable store. */
  async #locationFor(locationIds: string[]): Promise<Location | undefined> {
    for (const id of locationIds) {
      const cached = this.#locations.get(id);
      if (cached) return cached;
    }
    if (this.#locationStore) {
      for (const id of locationIds) {
        try {
          const stored = await this.#locationStore.get(id);
          if (stored) {
            this.#locations.set(id, stored);
            return stored;
          }
        } catch (err) {
          console.warn("location store lookup failed", toErrorBody(err));
        }
      }
    }
    return undefined;
  }

  #getSpacesRaw(args: GetSpacesArgs, locationOffset: string): Promise<unknown> {
    return this.#call({
      method: "GET",
      path: "/spaces/get-spaces",
      label: "get spaces",
      query: {
        locationUUIDs: args.locationIds.join(","),
        date: args.date,
        duration: GET_SPACES_DURATION,
        locationOffset,
        type: GET_SPACES_TYPE_DESK,
        capacity: args.capacity ?? 0,
        offset: 0,
        limit: GET_SPACES_LIMIT,
        isWeb: true,
      },
    });
  }

  /** The offset of the first workspace's building in a get-spaces response, if any. */
  #offsetRevealedBy(body: unknown): string | undefined {
    const workspaces = arrayAt(
      (body as { getSharedWorkspaces?: unknown } | null)?.getSharedWorkspaces ?? body,
      "workspaces",
    );
    for (const value of workspaces) {
      const location = mapLocation((value as { location?: RawLocation }).location);
      if (location?.timezoneOffset) return location.timezoneOffset;
    }
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Payload builders                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The shared part of the quote and booking bodies.
 *
 * `Notes` is `""` and never `null`: the field is typed as a string upstream and a
 * `null` is rejected outright. Every `MailData` value is a string for the same
 * reason — this is the field that most often turns a booking into a 200-with-refusal.
 *
 * @throws {AppError} `VALIDATION` when either time is off the 30-minute grid.
 */
export function buildQuoteBody(q: QuotePayloadWithQuoteSpaceId, spaceId: string): QuoteRequestBody {
  const startUtc = normaliseUtcStamp(q.startUtc);
  const endUtc = normaliseUtcStamp(q.endUtc);
  if (!startUtc || !endUtc) {
    throw new AppError(
      "VALIDATION",
      "The quote's startUtc/endUtc are not ISO-8601 UTC timestamps.",
    );
  }
  assertOnGrid(startUtc, "startUtc");
  assertOnGrid(endUtc, "endUtc");
  if (endUtc <= startUtc) {
    throw new AppError("VALIDATION", "The quote's endUtc must be after its startUtc.");
  }

  return {
    SpaceType: BOOKING_SPACE_TYPE,
    ReservationID: "",
    TriggerCalendarEvent: true,
    Notes: "",
    MailData: buildMailData(q, startUtc, endUtc),
    LocationType: q.accountType,
    UTCOffset: q.tzOffset,
    // Credit accounts price in credits; pay-as-you-go accounts in their local currency.
    Currency: q.currency ?? CREDITS_CURRENCY,
    LocationID: q.locationId,
    SpaceID: spaceId,
    WeWorkSpaceID: q.wwSpaceId,
    StartTime: startUtc,
    EndTime: endUtc,
  };
}

/** The booking body: the quote body plus the three fields only booking carries. */
export function buildBookingBody(
  q: QuotePayloadWithQuoteSpaceId,
  creditRatio: number,
): BookingRequestBody {
  return {
    ...buildQuoteBody(q, q.bookingSpaceId),
    ApplicationType: "WorkplaceOne",
    PlatformType: "iOS_APP",
    CreditRatio: creditRatio,
  };
}

/**
 * Confirmation-email copy, in the shape the members web app sends (verified from
 * dvcrn/wework-cli). Every value is a string; times are location-local.
 */
export function buildMailData(
  q: QuotePayloadWithQuoteSpaceId,
  startUtc: string,
  endUtc: string,
): MailData {
  const tz = q.timezone || "UTC";
  const startWall = utcIsoToZonedWallClock(startUtc, tz, q.tzOffset);
  const endWall = utcIsoToZonedWallClock(endUtc, tz, q.tzOffset);
  return {
    dayFormatted: formatDayLong(startUtc, tz),
    startTimeFormatted: formatTime12h(startUtc, tz),
    endTimeFormatted: formatTime12h(endUtc, tz),
    floorAddress: "",
    locationAddress: q.address ?? "",
    creditsUsed: String(q.credits ?? 0),
    Capacity: String(q.capacity ?? 1),
    TimezoneUsed: gmtLabel(q.tzOffset),
    TimezoneIana: tz,
    startDateTime: wallClockToDateTime(startWall),
    endDateTime: wallClockToDateTime(endWall),
    locationName: q.locationName ?? "",
    locationCity: q.city ?? "",
    locationCountry: q.country ?? "",
    locationState: q.state ?? "",
  };
}

/** `"Monday, September 21"` in the given zone (en-US, as the web app renders it). */
export function formatDayLong(utcStamp: string, timeZone: string): string {
  const ms = Date.parse(utcStamp);
  if (Number.isNaN(ms)) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(ms);
  } catch {
    return "";
  }
}

/** `"09:00 AM"` in the given zone. */
export function formatTime12h(utcStamp: string, timeZone: string): string {
  const ms = Date.parse(utcStamp);
  if (Number.isNaN(ms)) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
      .format(ms)
      .replace(/\u202f/g, " ");
  } catch {
    return "";
  }
}

/** `"+02:00"` -> `"GMT +02:00"`. */
export function gmtLabel(offset: string | undefined): string {
  const o = (offset ?? "").trim();
  return o ? `GMT ${o}` : "GMT +00:00";
}

/** `"2026-09-21T09:00:00"` -> `"2026-09-21 09:00"`. */
export function wallClockToDateTime(wallClock: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(wallClock);
  return m ? `${m[1]} ${m[2]}` : wallClock;
}

/**
 * The cancel payload.
 *
 * `startTime`/`endTime` are `"YYYY-MM-DDTHH:MM:SS.000"` **with no `Z`** — local wall
 * clock, matching what the bookings list handed us.
 *
 * @throws {AppError} `VALIDATION` when the booking carries no raw upstream item.
 */
export function buildCancelBody(booking: Booking): CancelRequestBody {
  const raw = booking.raw as RawUpcomingBooking | undefined;
  if (!raw || typeof raw !== "object") {
    throw new AppError(
      "VALIDATION",
      "Cancelling needs the raw upstream booking, which this Booking does not carry.",
      { hint: "Call list_bookings and cancel the booking object it returned." },
    );
  }

  const startTime = `${booking.startLocal}.000`;
  const endTime = `${booking.endLocal}.000`;
  const credits = booking.credits;

  return {
    bookingId: booking.bookingId,
    // `sourceType`, not `accountType` — a different upstream taxonomy.
    bookingLocationType: first(num(raw.location?.sourceType), 0) ?? 0,
    creditsUsed: credits,
    startTime,
    endTime,
    locationId: booking.locationId,
    reservableId: first(str(raw.reservableId), "") ?? "",
    spaceId: first(str(raw.spaceId), str(raw.spaceUUID), "") ?? "",
    isBookingApprovalOn: bool(raw.isBookingApprovalOn) ?? false,
    bookingType: first(num(raw.bookingType), CANCEL_BOOKING_TYPE) ?? CANCEL_BOOKING_TYPE,
    cancellationNote: "",
    reservationId: first(booking.reservationId, str(raw.reservationId), "") ?? "",
    mailParams: {
      workspaceType: CANCEL_WORKSPACE_TYPE,
      dayFormatted: formatDayLong(`${booking.startLocal}Z`, "UTC"),
      startTimeFormatted: formatTime12h(`${booking.startLocal}Z`, "UTC"),
      endTimeFormatted: formatTime12h(`${booking.endLocal}Z`, "UTC"),
      floorAddress: "",
      locationAddress: booking.address ?? "",
      locationCountry: rawAddressCountry(raw.location?.address),
    },
  };
}

/** The country from a raw location address, which upstream sends as a string or an object. */
function rawAddressCountry(address: unknown): string {
  if (typeof address !== "object" || address === null) return "";
  const rec = address as { country?: unknown; countryCode?: unknown };
  return first(str(rec.country), str(rec.countryCode), "") ?? "";
}

/**
 * The `accountType` fallback rules for the booking `SpaceID`.
 *
 * `2` -> `reservable.KubeId`, `4` -> `inventoryUuid`, anything else -> the workspace
 * `uuid`, with a cascade down to the uuid when the preferred id is absent.
 */
export function spaceIdByAccountType(space: SpaceAvailability): string {
  switch (space.location.accountType) {
    case 2:
      return space.kubeId ?? space.inventoryUuid ?? space.spaceId;
    case 4:
      return space.inventoryUuid ?? space.spaceId;
    default:
      return space.spaceId;
  }
}

/* -------------------------------------------------------------------------- */
/* Response helpers                                                            */
/* -------------------------------------------------------------------------- */

/** True for `{responseStatus:{type:"error"}}`, whatever the HTTP status was. */
function isErrorEnvelope(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const status = (body as { responseStatus?: { type?: unknown } }).responseStatus;
  if (!status || typeof status !== "object") return false;
  return /error|fail/i.test(str((status as { type?: unknown }).type) ?? "");
}

/** The human-readable part of an error envelope, if there is one. */
function envelopeMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const status = (body as { responseStatus?: Record<string, unknown> }).responseStatus;
  if (!status || typeof status !== "object") return undefined;
  return first(str(status.message), str(status.title), str(status.code));
}

/** The refusal reason from a booking response, or `undefined` when there is none. */
function bookingErrorMessage(body: RawBookingResponse | null): string | undefined {
  if (!body) return undefined;
  const errors = body.Errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : first(
              str((entry as Record<string, unknown> | null)?.Message),
              str((entry as Record<string, unknown> | null)?.message),
              str((entry as Record<string, unknown> | null)?.ErrorMessage),
            ),
      )
      .filter((entry): entry is string => Boolean(entry));
    if (messages.length > 0) return messages.join("; ");
    return "WeWork returned an unlabelled booking error.";
  }
  if (typeof errors === "string" && errors.trim()) return errors.trim();

  return first(str(body.ErrorMessage), str(body.Message), envelopeMessage(body));
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

/** Absolute members API URL with a query string; `undefined` values are dropped. */
export function buildUrl(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(`${MEMBERS_API_BASE}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** First and last day of the UTC calendar month containing `reference`. */
export function monthBoundsUtc(reference: Date): { start: string; end: string } {
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  return {
    start: isoDateUtc(Date.UTC(year, month, 1)),
    // Day 0 of the next month is the last day of this one.
    end: isoDateUtc(Date.UTC(year, month + 1, 0)),
  };
}

/** `"YYYY-MM-DD"` for an epoch-ms instant, in UTC. */
export function isoDateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `"YYYY-MM-DD"` shifted by whole days. */
export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return isoDateUtc(ms + days * 86_400_000);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
