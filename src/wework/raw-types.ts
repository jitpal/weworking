/**
 * Raw upstream shapes — only the fields we actually read.
 *
 * Two rules govern this file, both learned the hard way from a reverse-engineered
 * API with no contract:
 *
 * 1. **Everything is optional, and most things are `unknown`.** WeWork ships
 *    breaking field changes without notice (the `inventory-details` parameters were
 *    renamed in Aug 2026), returns `"2"` where it returned `2`, and omits whole
 *    sub-objects for some membership types. A declared-non-optional field here
 *    would be a lie that `tsc` happily believes. The coercion happens once, in
 *    `mappers.ts`, and the domain types in `src/core/types.ts` are strict.
 * 2. **Casing is inconsistent upstream and preserved here.** Reads are
 *    `camelCase`, booking and cancel are `PascalCase` and `camelCase`
 *    respectively. Renaming them in this file would hide a mismatch that only
 *    shows up as a silent 200-with-no-booking.
 *
 * The domain types these map *to* live in `src/core/types.ts` and are owned by the
 * shared contract; nothing in this file is part of that contract.
 */

/* -------------------------------------------------------------------------- */
/* Envelope                                                                    */
/* -------------------------------------------------------------------------- */

/** WeWork's error envelope. Arrives with HTTP 200 as often as not. */
export interface RawResponseStatus {
  /** `"error"` marks a failure, whatever the HTTP status says. */
  type?: unknown;
  message?: unknown;
  title?: unknown;
  code?: unknown;
}

/** Every members API response may carry a `responseStatus`. */
export interface RawEnvelope {
  responseStatus?: RawResponseStatus;
}

/* -------------------------------------------------------------------------- */
/* Locations                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A postal address. Sometimes an object, sometimes a flat string — both observed,
 * so {@link RawLocation.address} is typed as the union.
 */
export interface RawAddress {
  line1?: unknown;
  line2?: unknown;
  city?: unknown;
  state?: unknown;
  country?: unknown;
  countryCode?: unknown;
  zip?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

/** A building, as it appears inside `locationsByGeo` and nested in a workspace. */
export interface RawLocation {
  uuid?: unknown;
  id?: unknown;
  locationUUID?: unknown;
  name?: unknown;
  address?: RawAddress | string | null;
  city?: unknown;
  state?: unknown;
  country?: unknown;
  countryCode?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  /** IANA name, e.g. `"Europe/Berlin"`. Upstream spells the key both ways. */
  timeZone?: unknown;
  timezone?: unknown;
  /** Fixed offset, e.g. `"+02:00"`. Sometimes a signed minute count. */
  timezoneOffset?: unknown;
  timeZoneOffset?: unknown;
  /** Selects the `SpaceID` rule for bookings. */
  accountType?: unknown;
  /** Needed by the cancel payload as `bookingLocationType`. */
  sourceType?: unknown;
  /** Distance from the search point, when upstream computed one. */
  distance?: unknown;
  distanceInKm?: unknown;
  openTime?: unknown;
  closeTime?: unknown;
  isOpen?: unknown;
  /** ISO 4217 code the building prices in (live: `"GBP"`). */
  currency?: unknown;
}

/** One entry of the city list. */
export interface RawCity {
  city?: unknown;
  cityName?: unknown;
  name?: unknown;
  country?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Spaces                                                                      */
/* -------------------------------------------------------------------------- */

/** Seat counts for a shared workspace. */
export interface RawSeat {
  total?: unknown;
  available?: unknown;
  booked?: unknown;
}

/** The `reservable` block, which is where `accountType` 2 finds its Kube id. */
export interface RawReservable {
  KubeId?: unknown;
  kubeId?: unknown;
  Id?: unknown;
  uuid?: unknown;
}

/** One bookable shared workspace, from `getSharedWorkspaces.workspaces[]`. */
export interface RawWorkspace {
  uuid?: unknown;
  inventoryUuid?: unknown;
  name?: unknown;
  spaceName?: unknown;
  capacity?: unknown;
  credits?: unknown;
  price?: unknown;
  currency?: unknown;
  /** Local wall clock, frequently **not** zero-padded: `"9:00"`, even `"9:0"`. */
  openTime?: unknown;
  closeTime?: unknown;
  seat?: RawSeat;
  seatsAvailable?: unknown;
  seatsTotal?: unknown;
  reservable?: RawReservable;
  location?: RawLocation;
  /** `0` is the hot-desk/shared-workspace type in `get-spaces`. */
  spaceType?: unknown;
  type?: unknown;
  /** Live shape: `{ price: { currency, amount, symbol }, rateUnit, halfHourCreditPrices[] }`. */
  productPrice?: { price?: { currency?: unknown; amount?: unknown; symbol?: unknown } } | null;
}

/** `GET /common-booking/inventory-details`. */
export interface RawInventoryDetailsResponse extends RawEnvelope {
  kubeSpaceId?: unknown;
  KubeSpaceId?: unknown;
  inventoryDetails?: {
    kubeSpaceId?: unknown;
    KubeSpaceId?: unknown;
  };
}

/* -------------------------------------------------------------------------- */
/* Profile and credits                                                         */
/* -------------------------------------------------------------------------- */

/** `GET /wework-yardi/user/get-user-profile`. */
export interface RawProfileResponse extends RawEnvelope {
  uuid?: unknown;
  userUUID?: unknown;
  email?: unknown;
  emailAddress?: unknown;
  name?: unknown;
  fullName?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  membershipType?: unknown;
  membership?: unknown;
  homeLocationUUID?: unknown;
  homeLocationUuid?: unknown;
  defaultLocationUUID?: unknown;
  /** Some builds wrap everything in `userProfile`. */
  userProfile?: RawProfileResponse;
  /** Live shape: `{ uuid, name, currency, timeZone, address{city,country} }`. */
  homeLocation?: { uuid?: unknown; currency?: unknown; timeZone?: unknown } | null;
  /** Live shape: `[{ uuid, name, preferredMembershipNullable: { membershipType, productName } }]`. */
  companies?: unknown;
}

/** `GET /common-account/monthly-credits`. */
export interface RawMonthlyCreditsResponse extends RawEnvelope {
  totalCredits?: unknown;
  remainingCredits?: unknown;
  availableCredits?: unknown;
  usedCredits?: unknown;
  creditsUsed?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  /** Observed wrapper key. */
  monthlyCredits?: RawMonthlyCreditsResponse;
}

/* -------------------------------------------------------------------------- */
/* Quote and booking                                                           */
/* -------------------------------------------------------------------------- */

/** The `MailData` block. Every value must be a string — `null` is rejected upstream. */
export interface MailData {
  /** e.g. `"Monday, September 21"` (en-US, location-local). */
  dayFormatted: string;
  /** e.g. `"09:00 AM"` (location-local). */
  startTimeFormatted: string;
  endTimeFormatted: string;
  floorAddress: string;
  locationAddress: string;
  /** Credits as a string, e.g. `"10"`. */
  creditsUsed: string;
  /** Desk capacity as a string, usually `"1"`. */
  Capacity: string;
  /** e.g. `"GMT +02:00"`. */
  TimezoneUsed: string;
  /** IANA zone, e.g. `"Europe/Berlin"`. */
  TimezoneIana: string;
  /** `"YYYY-MM-DD HH:MM"` location-local. */
  startDateTime: string;
  endDateTime: string;
  locationName: string;
  locationCity: string;
  locationCountry: string;
  locationState: string;
}

/** Body of `POST /common-booking/quote`. */
export interface QuoteRequestBody {
  SpaceType: number;
  ReservationID: string;
  TriggerCalendarEvent: boolean;
  /** Must be a string, never `null` — the field is typed `string` upstream. */
  Notes: string;
  MailData: MailData;
  LocationType: number;
  UTCOffset: string;
  Currency: string;
  LocationID: string;
  SpaceID: string;
  WeWorkSpaceID: string;
  StartTime: string;
  EndTime: string;
}

/** Body of `POST /common-booking/` — the quote body plus three booking-only fields. */
export interface BookingRequestBody extends QuoteRequestBody {
  ApplicationType: string;
  PlatformType: string;
  CreditRatio: number;
}

/** `POST /common-booking/quote`. */
export interface RawQuoteResponse extends RawEnvelope {
  grandTotal?: {
    creditRatio?: unknown;
    credits?: unknown;
    total?: unknown;
    amount?: unknown;
    currency?: unknown;
  };
  creditRatio?: unknown;
  credits?: unknown;
}

/**
 * `POST /common-booking/`.
 *
 * Arrives with HTTP 200 whether the booking succeeded or not: only
 * `BookingStatus === "BookingSuccess"` with a non-empty `ReservationID` and no
 * `Errors` means a desk was actually reserved.
 */
export interface RawBookingResponse extends RawEnvelope {
  BookingStatus?: unknown;
  ReservationID?: unknown;
  ReservationId?: unknown;
  UUID?: unknown;
  Errors?: unknown;
  ErrorMessage?: unknown;
  Message?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Bookings list and cancel                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One upcoming booking.
 *
 * The time fields are the classic trap: they are **local wall clock stamped with
 * `Z`**. `"2026-09-14T09:00:00Z"` at a Berlin location means 09:00 Berlin time, not
 * 11:00. Converting them is the bug; re-anchoring them in the location's zone is
 * the fix. See `mappers.ts`.
 */
export interface RawUpcomingBooking {
  uuid?: unknown;
  bookingId?: unknown;
  BookingId?: unknown;
  reservationId?: unknown;
  ReservationID?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  StartTime?: unknown;
  EndTime?: unknown;
  credits?: unknown;
  creditsUsed?: unknown;
  creditPrice?: unknown;
  status?: unknown;
  bookingStatus?: unknown;
  isCancellable?: unknown;
  cancellationDeadline?: unknown;
  cancelBy?: unknown;
  /** Needed by the cancel payload. */
  reservableId?: unknown;
  spaceId?: unknown;
  spaceUUID?: unknown;
  isBookingApprovalOn?: unknown;
  bookingType?: unknown;
  locationId?: unknown;
  locationUUID?: unknown;
  location?: RawLocation;
  locationName?: unknown;
  spaceName?: unknown;
  timeZone?: unknown;
  timezone?: unknown;
  /** Live shape (2026-09): `startDate`/`endDate` are local wall clock stamped `Z`. */
  startDate?: unknown;
  endDate?: unknown;
  bookingDate?: unknown;
  creditCost?: unknown;
  isCancelled?: unknown;
  isPendingApproval?: unknown;
  /** Live: also local wall clock stamped `Z`; the same-day window is 5 minutes after creation. */
  modificationDeadlineTime?: unknown;
  kubeBookingExternalReference?: unknown;
  spaceExternalReference?: unknown;
  spaceTypeName?: unknown;
  bookingCurrency?: unknown;
  bookingCurrencySymbol?: unknown;
  spaceCapacity?: unknown;
}

/** The `mailParams` block on a cancellation. `workspaceType` 1 is a shared desk. */
export interface CancelMailParams {
  /** Always `1` for a shared desk. */
  workspaceType: number;
  dayFormatted: string;
  startTimeFormatted: string;
  endTimeFormatted: string;
  floorAddress: string;
  locationAddress: string;
  locationCountry: string;
}

/** Body of `POST /common-booking/cancel`. */
export interface CancelRequestBody {
  bookingId: string;
  /** `location.sourceType`, *not* `accountType`. */
  bookingLocationType: number;
  creditsUsed: number;
  /** `"YYYY-MM-DDTHH:MM:SS.000"` — local wall clock, with no `Z`. */
  startTime: string;
  endTime: string;
  locationId: string;
  reservableId: string;
  spaceId: string;
  isBookingApprovalOn: boolean;
  bookingType: number;
  cancellationNote: string;
  reservationId: string;
  mailParams: CancelMailParams;
}
