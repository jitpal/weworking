/**
 * The request and response schemas for both front doors — one source of truth.
 *
 * The MCP tools (`src/mcp/tools.ts`), the REST routes (`src/http/api.ts`) and the
 * OpenAPI document (`src/http/openapi.ts`) all use the objects below, so a parameter
 * cannot mean one thing over MCP and another over HTTP, and the published OpenAPI can
 * never drift from what the code actually accepts.
 *
 * Naming:
 * - **requests are `snake_case`** (`location_id`, `start_time`, `dry_run`) — for MCP
 *   tool arguments, REST JSON bodies *and* REST query strings;
 * - **responses are `camelCase`**, the domain field names from `src/core/types.ts`,
 *   serialised unchanged.
 *
 * Descriptions are written for an agent reading `tools/list` with no other context:
 * they say what a value means, what units it is in, and what it costs.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Shared field schemas                                                        */
/* -------------------------------------------------------------------------- */

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .describe("Local calendar date at the building, YYYY-MM-DD.");

const timeField = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM.")
  .describe(
    "Local wall-clock time at the building, 24-hour HH:MM. Snapped to a 30-minute boundary.",
  );

const spaceTypeField = z
  .enum(["desk", "meeting_room", "private_office"])
  .describe(
    "Kind of space. Only 'desk' (hot desk) is implemented; anything else returns UNSUPPORTED_SPACE_TYPE.",
  );

const limitField = z
  .number()
  .int()
  .min(1)
  .max(100)
  .describe("Maximum number of results. Default 20.");

const idempotencyKeyField = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Replay guard, any unique string (a UUID is ideal). Calling again with the same key returns the first result instead of acting twice.",
  );

const dryRunField = z
  .boolean()
  .describe(
    "When true, validate, price and check the caps but send nothing to WeWork. Default false.",
  );

/* -------------------------------------------------------------------------- */
/* Tool inputs                                                                 */
/* -------------------------------------------------------------------------- */

/** `whoami` takes no arguments; an empty object is friendlier to clients than omitting the schema. */
export const whoamiInput = z.object({});

export const listLocationsInput = z.object({
  query: z
    .string()
    .min(1)
    .optional()
    .describe("Free text matched against city names, then building names and addresses."),
  city: z.string().min(1).optional().describe("City name, e.g. 'London'."),
  lat: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe("Latitude of a geographic search; requires lng."),
  lng: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe("Longitude of a geographic search; requires lat."),
  radius_km: z
    .number()
    .min(0.1)
    .max(100)
    .optional()
    .describe("Search radius in kilometres around lat/lng. Default 5."),
  limit: limitField.optional(),
});

export const searchAvailabilityInput = z.object({
  location_id: z
    .string()
    .min(1)
    .optional()
    .describe("One building, from list_locations. Mutually exclusive with city and lat/lng."),
  city: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Search every building in this city (up to 10). Mutually exclusive with location_id and lat/lng.",
    ),
  lat: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe("Latitude for a nearby search (up to 10 nearest buildings); requires lng."),
  lng: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe("Longitude for a nearby search; requires lat."),
  radius_km: z
    .number()
    .min(0.1)
    .max(100)
    .optional()
    .describe("Radius for the nearby search, in km. Default 5."),
  timezone: z
    .string()
    .min(1)
    .optional()
    .describe(
      "IANA zone of the building, e.g. 'America/New_York', as returned by list_locations. Optional with location_id; pass it when you have it.",
    ),
  date: dateField,
  start_time: timeField
    .optional()
    .describe(
      "Local start time at the building, HH:MM. Defaults to the building's opening time. Rounded down to a 30-minute boundary.",
    ),
  end_time: timeField
    .optional()
    .describe(
      "Local end time at the building, HH:MM. Defaults to the building's closing time. Rounded up to a 30-minute boundary.",
    ),
  space_type: spaceTypeField.optional(),
  capacity: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Minimum seats the space must have. Hot desks are 1."),
  limit: limitField.optional(),
});

export const createBookingInput = z.object({
  quote: z
    .string()
    .min(1)
    .describe(
      "An opaque signed quote from search_availability, passed verbatim. It is the only way to identify what to book; it cannot be constructed or edited, and it expires ten minutes after the search that issued it.",
    ),
  idempotency_key: idempotencyKeyField.optional(),
  dry_run: dryRunField.optional(),
  note: z.string().max(500).optional().describe("Optional note stored with the booking."),
});

export const listBookingsInput = z.object({
  from: dateField
    .optional()
    .describe("Earliest local date to include, YYYY-MM-DD. Defaults to today."),
  to: dateField
    .optional()
    .describe("Latest local date to include, YYYY-MM-DD. Defaults to 30 days out."),
  include_past: z
    .boolean()
    .optional()
    .describe("Include bookings that have already ended. Default false."),
});

export const cancelBookingInput = z.object({
  booking_id: z.string().min(1).describe("bookingId from list_bookings or create_booking."),
  idempotency_key: idempotencyKeyField.optional(),
  dry_run: dryRunField.optional(),
});

/* -------------------------------------------------------------------------- */
/* Response schemas                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every response object is a *loose* schema: upstream may start reporting a new field
 * and the domain types may gain optional ones, and neither should make a validating
 * client reject an otherwise good answer.
 */
const locationOut = z.looseObject({
  locationId: z.string(),
  name: z.string(),
  address: z.string(),
  city: z.string(),
  country: z.string(),
  timezone: z.string().describe("IANA zone; every *Local field is in this zone."),
  timezoneOffset: z.string(),
  accountType: z.number(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  distanceKm: z.number().optional(),
  openTime: z.string().optional(),
  closeTime: z.string().optional(),
});

const availabilityOut = z.looseObject({
  spaceId: z.string(),
  spaceName: z.string(),
  spaceType: z.string(),
  capacity: z.number(),
  seatsAvailable: z.number(),
  seatsTotal: z.number(),
  credits: z.number().describe("WeWork credits this booking would cost."),
  cashPrice: z.looseObject({ amount: z.number(), currency: z.string() }).optional(),
  location: locationOut,
  date: z.string(),
  startLocal: z.string().describe("Local wall clock, no zone suffix."),
  endLocal: z.string(),
  startUtc: z.string().describe("True UTC instant, 30-minute boundary."),
  endUtc: z.string(),
  timezone: z.string(),
  quote: z.string().describe("Pass verbatim to create_booking."),
  summary: z.string(),
});

const bookingOut = z.looseObject({
  bookingId: z.string(),
  reservationId: z.string().optional(),
  locationId: z.string(),
  locationName: z.string(),
  address: z.string().optional(),
  date: z.string(),
  startLocal: z.string(),
  endLocal: z.string(),
  timezone: z.string(),
  status: z.enum(["confirmed", "cancelled", "pending", "unknown"]),
  credits: z.number(),
  cancelDeadlineLocal: z.string().optional(),
});

const capsRemainingOut = z.looseObject({
  day: z.number().describe("Bookings still allowed today."),
  week: z.number().describe("Bookings still allowed this ISO week."),
});

export const whoamiOutput = z.looseObject({
  profile: z.looseObject({
    userId: z.string(),
    email: z.string().optional(),
    name: z.string().optional(),
    membershipType: z.string().optional(),
    homeLocationId: z.string().optional(),
  }),
  credits: z
    .looseObject({
      remaining: z.number(),
      total: z.number(),
      periodStart: z.string(),
      periodEnd: z.string(),
    })
    .optional(),
  session: z.looseObject({
    state: z.enum(["none", "valid", "expiring", "expired"]),
    source: z.enum(["login", "manual", "refresh", "none"]),
    obtainedAt: z.string().optional(),
    expiresAt: z.string().optional(),
    hasRefreshToken: z.boolean(),
    lastError: z.string().optional(),
  }),
  actor: z.looseObject({
    kind: z.string(),
    name: z.string(),
    scopes: z.array(z.string()),
    accountId: z.string(),
  }),
  caps: z.looseObject({
    maxBookingsPerDay: z.number(),
    maxBookingsPerWeek: z.number(),
    maxCreditsPerBooking: z.number().describe("0 allows only free desks; -1 means no limit."),
    maxCashPerBooking: z
      .number()
      .describe("0 allows no cash bookings; -1 means no limit. In the building's currency."),
  }),
  capsRemaining: capsRemainingOut,
  writeEnabled: z.boolean(),
});

export const listLocationsOutput = z.looseObject({ locations: z.array(locationOut) });

export const searchAvailabilityOutput = z.looseObject({
  results: z.array(availabilityOut),
  quoteExpiresAt: z
    .string()
    .optional()
    .describe("When every quote in this result expires, ISO-8601 UTC."),
  note: z.string().optional().describe("Present when results is empty: why, and what to try next."),
});

export const createBookingOutput = z.looseObject({
  booking: bookingOut,
  dryRun: z.boolean(),
  creditsCharged: z.number(),
  capsRemaining: capsRemainingOut,
  summary: z.string(),
});

export const listBookingsOutput = z.looseObject({ bookings: z.array(bookingOut) });

export const cancelBookingOutput = z.looseObject({
  bookingId: z.string(),
  status: z.enum(["confirmed", "cancelled", "pending", "unknown"]),
  creditsRefunded: z.number().optional(),
  summary: z.string(),
});

/** The error envelope both front doors return, identical to `src/errors.ts#ErrorBody`. */
export const errorOutput = z.looseObject({
  error: z.looseObject({
    code: z.string().describe("Stable machine-readable code; branch on this."),
    message: z.string(),
    hint: z.string().optional().describe("What to do next, written for an agent."),
    details: z.unknown().optional(),
  }),
});

/* -------------------------------------------------------------------------- */
/* Query-string coercion                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Query-string parameters that are numbers in JSON.
 *
 * The schemas above are the JSON shapes (a number is a number), because that is what
 * MCP tool arguments and the OpenAPI document need. A URL carries only strings, so
 * `src/http/api.ts` runs the query through {@link coerceQuery} first rather than
 * weakening the schemas with unions.
 */
export const QUERY_NUMBER_FIELDS = ["lat", "lng", "radius_km", "limit", "capacity"] as const;

/** Query-string parameters that are booleans in JSON. */
export const QUERY_BOOLEAN_FIELDS = ["include_past", "dry_run"] as const;

/**
 * Converts a REST query object into the JSON shape the schemas expect.
 *
 * Unparseable values are left as-is so zod reports a proper `VALIDATION` error naming
 * the field, instead of silently turning `limit=banana` into `NaN`.
 */
export function coerceQuery(query: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    if ((QUERY_NUMBER_FIELDS as readonly string[]).includes(key)) {
      const asNumber = Number(value);
      out[key] = Number.isFinite(asNumber) ? asNumber : value;
      continue;
    }
    if ((QUERY_BOOLEAN_FIELDS as readonly string[]).includes(key)) {
      const lowered = value.toLowerCase();
      out[key] =
        lowered === "true" || lowered === "1"
          ? true
          : lowered === "false" || lowered === "0"
            ? false
            : value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Inferred types                                                              */
/* -------------------------------------------------------------------------- */

export type ListLocationsInput = z.infer<typeof listLocationsInput>;
export type SearchAvailabilityInput = z.infer<typeof searchAvailabilityInput>;
export type CreateBookingInput = z.infer<typeof createBookingInput>;
export type ListBookingsInput = z.infer<typeof listBookingsInput>;
export type CancelBookingInput = z.infer<typeof cancelBookingInput>;
