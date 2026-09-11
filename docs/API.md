# API reference

Two front doors over the same service layer. MCP tools and REST routes return the same JSON shapes: what a tool puts in `structuredContent` is exactly what the matching REST route returns as its body.

- MCP: `POST|GET https://<your-worker>.workers.dev/mcp` (Streamable HTTP, stateless)
- REST: `https://<your-worker>.workers.dev/api/*`
- OpenAPI 3.1: `GET /api/openapi.json` (public, no auth)
- Health: `GET /healthz` (public, no auth)

Everything else requires an OAuth 2.1 access token or a static bearer token (see [CLIENTS.md](CLIENTS.md)). Reads need `read`; `create_booking` and `cancel_booking` need `write`; `/admin/*` needs `admin`.

Naming: every request parameter is `snake_case`, whether it is an MCP tool argument, a REST JSON body, or a REST query string (`location_id`, `start_time`, `dry_run`, `idempotency_key`). Every response field is `camelCase`, matching the domain types in `src/core/types.ts` (`locationId`, `startLocal`, `seatsAvailable`).

## Conventions

- **Dates** are `YYYY-MM-DD` in the building's local time zone. **Times** passed in are local `HH:MM` at the building, rounded to 30-minute boundaries.
- Responses carry both local and UTC instants: `startLocal`/`endLocal` (local wall clock) and `startUtc`/`endUtc` (true UTC, `Z`). Show the user local times.
- **Credits** are WeWork credits, not currency. `cashPrice` appears only when the upstream offers one.
- **`space_type`** is `desk` | `meeting_room` | `private_office`. Only `desk` is implemented; anything else returns `UNSUPPORTED_SPACE_TYPE`. See [CAPTURE_GUIDE.md](CAPTURE_GUIDE.md).
- **Quotes** are opaque signed strings from `search_availability`. `create_booking` takes nothing else to identify a space. They expire after `QUOTE_TTL_SECONDS` (default 600).
- **Idempotency**: pass `idempotency_key` (any unique string, a UUID is ideal) on writes. A replay with the same key returns the stored result instead of acting again.
- Every tool result also includes a human-readable `summary` string; MCP returns it as the `content[0].text`.

## Tools and routes

| Tool | REST | Scope | Notes |
| --- | --- | --- | --- |
| `whoami` | `GET /api/whoami` | `read` | no params |
| `list_locations` | `GET /api/locations` | `read` | |
| `search_availability` | `GET /api/availability` | `read` | issues quotes |
| `create_booking` | `POST /api/bookings` | `write` | quote required |
| `list_bookings` | `GET /api/bookings` | `read` | |
| `cancel_booking` | `DELETE /api/bookings/:id` | `write` | destructive |

### whoami

No parameters. Call this first if you do not know whether the deployment is connected to WeWork, or what you are allowed to do.

```json
{
  "profile": {
    "userId": "8f1c2d3e-0000-4aaa-bbbb-1234567890ab",
    "email": "you@example.com",
    "name": "Example Member",
    "membershipType": "WeWork All Access",
    "homeLocationId": "5a9c1f70-0000-4bbb-cccc-0987654321fe"
  },
  "credits": {
    "remaining": 7.5,
    "total": 10,
    "periodStart": "2026-09-01",
    "periodEnd": "2026-09-30"
  },
  "session": {
    "state": "valid",
    "source": "manual",
    "obtainedAt": "2026-09-11T08:12:00.000Z",
    "expiresAt": "2026-09-11T20:12:00.000Z",
    "hasRefreshToken": true
  },
  "actor": { "kind": "bearer", "name": "claude-code", "scopes": ["read", "write"], "accountId": "default" },
  "caps": { "maxBookingsPerDay": 1, "maxBookingsPerWeek": 5, "maxCreditsPerBooking": 0 },
  "capsRemaining": { "day": 1, "week": 3 },
  "writeEnabled": true
}
```

`whoami` never returns a WeWork token. If `session.state` is `none` or `expired`, stop and tell the user to reconnect.

### Credits or cash

WeWork bills some memberships in monthly credits and others (such as "On Demand") in money. Every availability result carries both fields:

- `credits`: the credit cost from WeWork's listing. `0` on a pay-as-you-go account.
- `cashPrice`: `{ "amount": 84, "currency": "GBP" }`, present on pay-as-you-go accounts. It is the tax-inclusive total from WeWork's quote call, which prices a slot without reserving it, so a cash-account search costs one extra upstream request per space.

The `summary` line shows whichever applies ("84 credits" or "£84.00"), or "price unavailable" if the quote call failed. Booking re-checks the price against the signed quote and refuses with `BOOKING_REFUSED` if it moved. `whoami.credits` is absent on cash accounts, and `whoami.profile.membershipType` reads "On Demand" for them.

### list_locations

| Param | Type | Notes |
| --- | --- | --- |
| `query` | string | free text matched against name, city, address |
| `city` | string | city name |
| `lat`, `lng` | number | centre point; requires both |
| `radius_km` | number | with `lat`/`lng`; default 5 |
| `limit` | integer | default 20, max 100 |

At least one of `query`, `city`, or `lat`+`lng` is required.

`GET /api/locations?city=London&limit=2`

```json
{
  "locations": [
    {
      "locationId": "5a9c1f70-0000-4bbb-cccc-0987654321fe",
      "name": "1 Poultry",
      "address": "1 Poultry",
      "city": "London",
      "country": "GBR",
      "timezone": "Europe/London",
      "timezoneOffset": "+01:00",
      "latitude": 51.5136,
      "longitude": -0.0907,
      "distanceKm": 0.4,
      "accountType": 2,
      "openTime": "08:00",
      "closeTime": "18:00"
    }
  ]
}
```

`accountType` and `timezoneOffset` are upstream details that end up in the quote; you do not need to interpret them.

### search_availability

| Param | Type | Notes |
| --- | --- | --- |
| `location_id` | string | one building; mutually exclusive with `city` |
| `city` | string | search every building in the city |
| `date` | string | **required**, `YYYY-MM-DD` local |
| `start_time` | string | local `HH:MM`, 30-minute boundary; defaults to the building's opening time |
| `end_time` | string | local `HH:MM`; defaults to closing time |
| `space_type` | string | `desk` (default) |
| `capacity` | integer | minimum seats; desks are 1 |
| `limit` | integer | default 20 |

One of `location_id` or `city` is required.

`GET /api/availability?location_id=5a9c1f70-...&date=2026-09-21&start_time=09:00&end_time=17:00`

```json
{
  "results": [
    {
      "spaceId": "c3f4a5b6-0000-4ccc-dddd-1122334455aa",
      "inventoryUuid": "d4e5f6a7-0000-4ddd-eeee-2233445566bb",
      "kubeId": "KUBE-123456",
      "spaceName": "Hot Desk, 3rd Floor",
      "spaceType": "desk",
      "capacity": 1,
      "seatsAvailable": 12,
      "seatsTotal": 40,
      "credits": 1,
      "cashPrice": { "amount": 29, "currency": "GBP" },
      "location": { "locationId": "5a9c1f70-0000-4bbb-cccc-0987654321fe", "name": "1 Poultry", "city": "London", "timezone": "Europe/London" },
      "date": "2026-09-21",
      "startLocal": "2026-09-21T09:00:00",
      "endLocal": "2026-09-21T17:00:00",
      "startUtc": "2026-09-21T08:00:00Z",
      "endUtc": "2026-09-21T16:00:00Z",
      "timezone": "Europe/London",
      "quote": "eyJ2IjoxLCJhY2NvdW50SWQiOiJkZWZhdWx0Iiw...RG9Ob3RUcnVzdFRoaXM",
      "summary": "1 Poultry, London - Hot Desk, 3rd Floor, Mon 21 Sep 09:00-17:00 (Europe/London), 1 credit, 12 of 40 seats free"
    }
  ],
  "quoteExpiresAt": "2026-09-11T09:22:00.000Z"
}
```

`location` is abbreviated above; the real payload contains the full `Location` object.

### create_booking

| Param | Type | Notes |
| --- | --- | --- |
| `quote` | string | **required**, from `search_availability` |
| `idempotency_key` | string | strongly recommended |
| `dry_run` | boolean | default `false`; validate and report without booking |
| `note` | string | optional note sent to WeWork |

`POST /api/bookings`

```json
{ "quote": "eyJ2IjoxLCJhY2NvdW50SWQi...", "idempotency_key": "0b9c2f4a-1111-4eee-ffff-556677889900", "dry_run": false }
```

```json
{
  "booking": {
    "bookingId": "BK-8891234",
    "reservationId": "RES-554433",
    "locationId": "5a9c1f70-0000-4bbb-cccc-0987654321fe",
    "locationName": "1 Poultry",
    "address": "1 Poultry, London",
    "date": "2026-09-21",
    "startLocal": "2026-09-21T09:00:00",
    "endLocal": "2026-09-21T17:00:00",
    "timezone": "Europe/London",
    "status": "confirmed",
    "credits": 1,
    "cancelDeadlineLocal": "2026-09-21T08:00:00"
  },
  "dryRun": false,
  "creditsCharged": 1,
  "capsRemaining": { "day": 0, "week": 2 },
  "summary": "Booked 1 Poultry, London for Mon 21 Sep 09:00-17:00. 1 credit. Booking BK-8891234. Free cancellation until 08:00 local."
}
```

With `dry_run: true`, `dryRun` is `true`, `creditsCharged` is what *would* be charged, `booking.status` is `pending`, and `bookingId` is a placeholder. Nothing is sent to WeWork's booking endpoint and no cap is consumed.

WeWork returns HTTP 200 even when it refuses a booking, so the service checks the upstream `BookingStatus` and raises `BOOKING_REFUSED` when it is not `BookingSuccess`. A `BOOKING_REFUSED` means nothing was charged.

### list_bookings

| Param | Type | Notes |
| --- | --- | --- |
| `from` | string | `YYYY-MM-DD`, default today |
| `to` | string | `YYYY-MM-DD`, default 30 days out |
| `include_past` | boolean | default `false` |

`GET /api/bookings?from=2026-09-11&to=2026-10-11`

```json
{
  "bookings": [
    {
      "bookingId": "BK-8891234",
      "locationId": "5a9c1f70-0000-4bbb-cccc-0987654321fe",
      "locationName": "1 Poultry",
      "date": "2026-09-21",
      "startLocal": "2026-09-21T09:00:00",
      "endLocal": "2026-09-21T17:00:00",
      "timezone": "Europe/London",
      "status": "confirmed",
      "credits": 1,
      "cancelDeadlineLocal": "2026-09-21T08:00:00"
    }
  ]
}
```

Upstream stamps these times as `Z` even though they are local wall clock; the mapper corrects that, so `startLocal` is genuinely local.

### cancel_booking

| Param | Type | Notes |
| --- | --- | --- |
| `booking_id` | string | **required** (path parameter in REST) |
| `idempotency_key` | string | recommended |
| `dry_run` | boolean | default `false` |

`DELETE /api/bookings/BK-8891234`

```json
{
  "bookingId": "BK-8891234",
  "status": "cancelled",
  "creditsRefunded": 1,
  "summary": "Cancelled BK-8891234 at 1 Poultry on Mon 21 Sep. 1 credit refunded."
}
```

`creditsRefunded` echoes the booking's credit cost. WeWork does not report the actual refund, and cancelling after `cancelDeadlineLocal` usually refunds nothing, so treat the figure as the upper bound.

## Admin routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /admin/connect` | admin cookie | paste a WeWork session |
| `POST /admin/session` | admin cookie or `admin` scope | submit a session as JSON |
| `GET /admin/status` | admin cookie or `admin` scope | session detail |
| `GET /admin/audit?limit=50` | admin cookie or `admin` scope | audit log, redacted |

## Errors

Every failure, on both front doors, uses one envelope:

```json
{ "error": { "code": "SESSION_EXPIRED", "message": "The stored WeWork session has expired and could not be refreshed.", "hint": "Ask the user to open https://<your-worker>.workers.dev/admin/connect and paste a fresh session." } }
```

`code` is stable and is what you should branch on. `message` is for humans. `hint` is written for an agent: it says what to do next. MCP returns the same object as `isError: true` with the JSON as text.

| Code | HTTP | Meaning | What the agent should do |
| --- | --- | --- | --- |
| `UNAUTHORIZED` | 401 | no credential, or it did not match | stop. A human must fix the client config; the 401 carries `WWW-Authenticate` with the OAuth metadata URL if you can run that flow |
| `FORBIDDEN_SCOPE` | 403 | credential lacks the required scope | stop and tell the user which scope is missing. Do not retry |
| `WRITE_DISABLED` | 403 | `WRITE_ENABLED="false"` | stop. Reads still work; tell the user writes are switched off on this deployment |
| `SESSION_MISSING` | 503 | no WeWork session stored | tell the user to open `/admin/connect`. Never ask them for their password |
| `SESSION_EXPIRED` | 503 | stored session expired and could not refresh | same: reconnect at `/admin/connect` |
| `UPSTREAM_AUTH` | 502 | WeWork rejected the token | retried once internally already. Tell the user to reconnect |
| `UPSTREAM_BLOCKED` | 502 | Auth0 demanded human verification or a captcha for automatic login | stop retrying; it will not clear. Tell the user to connect via `/admin/connect` |
| `UPSTREAM_RATE_LIMITED` | 429 | WeWork returned 429 | wait and retry once, well after any `Retry-After`. Do not loop |
| `UPSTREAM_ERROR` | 502 | upstream error or unparseable response | retry once for reads; never auto-retry a booking. Report and stop |
| `QUOTE_INVALID` | 400 | signature failed, wrong deployment, or mangled quote | run `search_availability` again and use a fresh quote verbatim |
| `QUOTE_EXPIRED` | 409 | quote older than `QUOTE_TTL_SECONDS` | search again and book promptly |
| `CAP_EXCEEDED` | 429 | daily/weekly booking cap or credit ceiling reached | stop. Explain the cap and that the user can raise it in `wrangler.jsonc`. Do not look for a workaround |
| `NOT_AVAILABLE` | 409 | the space was taken between the search and the booking | search again and offer the user the new options |
| `BOOKING_REFUSED` | 409 | WeWork accepted the request but refused the booking (no credits, policy, overlap) | report the reason. Nothing was charged. Do not retry blindly |
| `NOT_FOUND` | 404 | unknown booking id or location id | re-list and use an id from the result |
| `UNSUPPORTED_SPACE_TYPE` | 400 | meeting rooms and private offices are not implemented | tell the user hot desks only, and point at `docs/CAPTURE_GUIDE.md` if they want to help |
| `VALIDATION` | 400 | bad or missing parameters | read `message`, fix the arguments, retry once |

Errors never contain tokens, cookies, passwords, or raw upstream auth payloads.
