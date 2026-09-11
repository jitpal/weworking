# WeWork member API notes (unofficial, reverse-engineered)

Everything below was derived from open-source clients and browser captures, then
checked against a live deployment. There is no public WeWork API and no documentation.
Treat this as a field report: endpoints and payload shapes change without notice.

Each claim is labelled:

- **verified**, seen in at least two independent implementations, or observed against
  the live API from this worker.
- **inferred**, read from one source or deduced from surrounding behaviour. Expect to
  have to fix it.

Live observations were made on 2026-09-11 from a Cloudflare Worker, using a
pay-as-you-go "On Demand" account whose home city is London. Last reviewed 2026-09-11.

## Authentication (Auth0). Verified

- Tenant `idp.wework.com`; `client_id` `zE51Ep7FttlmtQV6ZEGyJKsY2jD1EtAu`; audience
  `wework`; realm `id-wework`.
- Scope `openid profile email offline_access`, which is what makes a refresh token
  obtainable.
- `redirect_uri`
  `https://members.wework.com/workplaceone/api/auth0/v2/callback?domain=members.wework.com/workplaceone`.
- Discovery: `GET members.wework.com/workplaceone/api/auth0/v2/config?domain=members.wework.com%2Fworkplaceone`
  returns `{domain, clientId, authorizationParams{scope, audience, redirect_uri}}`.
  The v1 paths (`/auth0/config`, `/auth0/login-by-auth0-token`) are 404 now.
- `Auth0-Client` header:
  `eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjIuMS4yIn0=` (auth0-spa-js 2.1.2).

The full non-interactive flow, in order:

1. `POST idp/co/authenticate` with
   `{client_id, username, password, realm, credential_type: "http://auth0.com/oauth/grant-type/password-realm"}`
   plus `Origin`, `Referer` and `Auth0-Client`. Returns a `login_ticket`.
2. Set the transaction cookies `a0.spajs.txs.<client_id>` and the `_legacy_` twin on
   the idp domain, url-encoded JSON
   `{nonce, code_verifier, scope, audience, redirect_uri, state}`.
3. `GET idp/authorize?...&login_ticket=...` with `code_challenge` S256 and
   `response_mode=query`, following redirects manually (8 to 12 hops). The
   `/u/mfa-detect-browser-capabilities` form has to be posted back with `state`,
   `action=default`, `js-available=true`, `webauthn-available=false`,
   `webauthn-platform-available=false`, `is-brave=false`. The chain ends at the
   callback with `?code=`.
4. `POST idp/oauth/token`, grant `authorization_code`, with
   `{client_id, code, code_verifier, redirect_uri}`. Returns `access_token` (which *is*
   the members API bearer), `id_token`, `refresh_token` and `expires_in`.
5. Refresh: `POST idp/oauth/token` with
   `{grant_type: "refresh_token", client_id, refresh_token, redirect_uri}`.

Access tokens last about 12 hours.

**This flow does work from a Worker.** It succeeded on the first attempt from
Cloudflare egress and returned a refresh token. It is still not something to depend on:
Auth0's bot protection answers `requires_verification` or a captcha for some
IP and account combinations, and no header or retry clears that. MFA accounts cannot
use it at all. Both are why `/admin/connect` exists, and why the recommended shape is
to obtain a session once and let the worker refresh from then on. Refresh requests are
not subject to the bot check.

## Request headers. Verified

Every members API call carries:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <access_token>` |
| `WeWorkAuth` | `Bearer <access_token>` |
| `WeWorkUUID` | the `https://wework.com/user_uuid` JWT claim |
| `WeWorkMemberType` | `2` |
| `Request-Source` | `com.wework.ondemand/WorkplaceOne/Prod/iOS/2.71.0(26.1)`, or `MemberWeb/WorkplaceOne/Prod` for the bookings and cancel pages |
| `fe-pg` | `/workplaceone/content2/dashboard`, or `/workplaceone/content2/your-bookings` for cancel |
| `Origin`, `Referer` | `https://members.wework.com` |

## Endpoints

Base: `https://members.wework.com/workplaceone/api`.

### `GET /wework-yardi/ondemand/get-locations-by-geo`. Verified

Query: `isAuthenticated=true&city=&isOnDemandUser=false&isWeb=true`, plus
`userLatitude`/`userLongitude` and the `boundnwLat`/`boundnwLng`/`boundseLat`/`boundseLng`
bounding box for a geographic search, plus an optional `accountUUID`.

Each `locationsByGeo[]` item:
`{ uuid, name, latitude, longitude, address: { line1, line2, city, state, country, zip }, timeZone, distance, brandName, accountType, spaceAvailabilityCount, ... }`.

On a city search `address.country` is empty and `distance` is meaningless because there
is no origin, so both are dropped. There is no offset and no currency field here: the
offset is derived from `timeZone` and the currency comes from `get-spaces`.
**`distance` is in metres** (327.37 for a building 330 m away); the worker computes its
own great-circle kilometres whenever a search origin exists.

### `GET /wework-yardi/location/get-city-details`. Verified

The city list. Cities appear with inconsistent casing, so results are de-duplicated.

### `GET /wework-yardi/user/get-user-profile`. Verified

`{ uuid, email, name, phone, homeLocation: { uuid, name, currency, timeZone, address: { city, country } }, companies: [{ uuid, name, preferredMembershipNullable: { membershipType: "On Demand", productName, accountUuid } }], registrationInfo: { country } }`.

`homeLocation.currency` is the *account's* home currency, not the building's.

### `GET /spaces/get-spaces`. Verified

Query: `locationUUIDs=<csv>&date=YYYY-MM-DD&duration=30&locationOffset=+HH:MM&type=0&capacity=0&offset=0&limit=50&isWeb=true`.

Returns `getSharedWorkspaces.workspaces[]`, each
`{ uuid, inventoryUuid, capacity, credits, location, openTime, closeTime, cancellationPolicy, operatingHours, productPrice, seat, seatsAvailable, reservable, isHybridSpace, affiliateSpaceType, SpaceTypeID }`.

- `productPrice.price = { currency: "GBP", amount: 70, symbol: "£" }` is the pre-tax day
  rate; `productPrice.halfHourCreditPrices[]` is the credit schedule.
- `location.currency` is the building's currency, and the nested `location` is partial
  (no `name`), so it is merged with what the listing calls already fetched.
- `reservable.KubeId` is the booking id for `accountType` 2.
- `openTime` and `closeTime` are local wall clock and frequently not zero-padded
  (`"9:00"`, even `"8:0"`).

**`locationOffset` must match the building on the requested date.** Sending `+00:00`
for a New York building returned `totalCount: 0`, while the correct `-04:00` returned
inventory. London tolerated `+00:00` only because it is within the same day. This is
why building metadata is persisted in the Durable Object, and why a never-seen
`location_id` is queried at `+00:00` and then re-queried at the real offset if the
first pass reveals a building in another zone. See
[LOCATION_AND_TIME.md](./LOCATION_AND_TIME.md).

An empty result is not necessarily a request bug. Tokyo (`accountType` 4) returned
`totalCount: 0` for this account on a city sweep with the correct `+09:00` offset, which
is inventory or eligibility. Berlin (EUR) and Sydney (AUD) priced correctly, including a
Sydney start that falls on the previous UTC date.

### `GET /common-booking/inventory-details`. Inferred

Query `propertyGuid`, `spaceGuid`, `applicationType=WorkplaceOne`. Yields
`kubeSpaceId`. Only hotdesker documents it, and the parameter names were renamed in
August 2026.

Live, it answered **HTTP 500** (error code 624402) for an `accountType` 2 building.
`reservable.KubeId` works instead, so the worker skips this call whenever that id is
present and treats any failure as "fall back to the `accountType` rules".

### `GET /common-account/monthly-credits`. Verified

Query `startDate`, `endDate`. Returns nothing useful for a cash account, which is why
`whoami.credits` is absent there.

### `POST /common-booking/quote`. Verified

Response:
`{ uuid, quoteStatus: 1, statusDetails: [], grandTotal: { currency, amount: 84, creditRatio: 20, symbol: "£", creditCharged: 0 }, subTotal: { amount: 70, currency }, taxes: [{ amount: 14, description: "20%", currency, name: "VAT" }], lineItems, adjustments }`.

`grandTotal.amount` is the tax-inclusive total to show a cash user. The request's
`Currency` is echoed back in `grandTotal.currency` and does not change the numbers.
Pricing a slot does not reserve it.

### `POST /common-booking/`. Verified

**HTTP 200 even when the booking is refused.** Success is
`BookingStatus === "BookingSuccess"` with a non-empty `ReservationID` and no `Errors`.

### `GET /common-booking/get-app-upcoming-bookings`. Verified

Query `isPastBooking=false&platFormType=1&startDate=&endDate=`.

**Its times are local wall clock stamped with `Z`.** `"2026-09-22T09:00:00Z"` for a
Berlin building means 09:00 in Berlin, not 11:00. Converting them is the bug;
re-anchoring them in the building's zone is the fix. This is a frequent source of
off-by-hours errors in every client that touches this endpoint.

### `POST /common-booking/cancel`. Verified

Query `isOnDemand=false&platFormType=1`. The response body is the JSON literal `true`.

## Request bodies

Quote and booking share a body. `SpaceType` is `4`, `ReservationID` is `""`,
`TriggerCalendarEvent` is `true`, `Notes` is a string and never `null`,
`LocationType` is the location's `accountType`, `UTCOffset` is its offset string,
`Currency` is `"com.wework.credits"` on a credit account or the ISO code on a cash one,
and `StartTime`/`EndTime` are UTC `Z` on 30-minute boundaries. Booking adds
`ApplicationType: "WorkplaceOne"`, `PlatformType: "iOS_APP"` and the `CreditRatio` from
the quote.

`MailData` is the confirmation-email block. Every value must be a string; a `null`
there is the single most common cause of a 200-with-refusal. Its exact field set is
**inferred** from dvcrn/wework-cli.

Which id goes in `SpaceID` depends on the call and the building:

| Call | `accountType` | `SpaceID` |
| --- | --- | --- |
| quote | any | `inventoryUuid \|\| uuid` |
| booking | 2 | `reservable.KubeId`, or `kubeSpaceId` from `inventory-details` when that call works |
| booking | 4 | `inventoryUuid` |
| booking | 0 | `uuid` |

`WeWorkSpaceID` is always the workspace `uuid`.

The cancel body is different again: `bookingId`, `bookingLocationType` (the location's
`sourceType`, **not** its `accountType`), `creditsUsed`, `startTime`/`endTime` as
`"YYYY-MM-DDTHH:MM:SS.000"` local wall clock with no `Z`, `locationId`, `reservableId`,
`spaceId`, `isBookingApprovalOn`, `bookingType: 4`, `cancellationNote: ""`,
`reservationId`, and a `mailParams` block with `workspaceType: 1`. The `mailParams`
shape is **inferred**.

## Failure modes. Verified

- The error envelope is `{"responseStatus": {"type": "error", "message", "title"}}`, and
  it arrives with HTTP 200 as often as not.
- `/authorize` returns 429 with `Retry-After`.
- Cloudflare in front of WeWork occasionally returns 403.

## Constraints on a Worker

- No cookie jar, so redirects are followed with `redirect: "manual"` and a hand-rolled
  jar. **Verified**, this is what the headless login does.
- The Auth0 redirect chain costs roughly 10 to 14 subrequests. **Verified.**
- TLS fingerprinting is a plausible reason for a bot challenge but has not been
  observed to be the trigger. **Inferred.**

## Prior art

These are the sources the notes above were built from. None is affiliated with this
project.

- [dvcrn/wework-cli](https://github.com/dvcrn/wework-cli) (Go) and
  [dvcrn/mcp-server-wework](https://github.com/dvcrn/mcp-server-wework). The reference
  for the Auth0 login and the booking sequence.
- [SridarDhandapani/hotdesker](https://github.com/SridarDhandapani/hotdesker) (Chrome
  extension). The most current endpoint detail, including `inventory-details`.
- [jeromewir/webook](https://github.com/jeromewir/webook) (Go). Refresh tokens and 429
  handling.
- [benoib/webook](https://github.com/benoib/webook) (TypeScript).
- [BugenZhao/wework-book-a-desk](https://github.com/BugenZhao/wework-book-a-desk)
  (Python). Uses retired endpoints, so read it for shape rather than for behaviour.

How this worker is put together, and why these constraints produced that shape, is in
[DESIGN.md](./DESIGN.md).
