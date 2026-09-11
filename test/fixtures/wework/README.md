# WeWork fixtures — hand-written, not recorded

**None of these files came off the wire.** Every one was written by hand from the
public reverse-engineering notes in [`docs/WEWORK_API.md`](../../../docs/WEWORK_API.md)
— which were themselves derived from four open-source clients (dvcrn/wework-cli,
jeromewir/webook, benoib/webook, SridarDhandapani/hotdesker), not from WeWork
documentation, because there is none.

That has two consequences, and both matter:

1. **They are completely synthetic.** There is no member's email, name, home
   address, coordinate, token or cookie anywhere in this directory. Every UUID is
   obviously fake (`aaaa1111-0000-4000-8000-...`), emails use the reserved
   `example.invalid` domain, tokens say `FAKE-...` in the clear, and the JWTs carry
   the literal signature `FAKE-SIGNATURE-THIS-TOKEN-IS-SYNTHETIC-AND-UNVERIFIABLE`.
   Nothing here needs scrubbing, and nothing here is a credential.
2. **They encode our *assumptions*, so a passing test suite is not proof the client
   works.** Field names, casing and nesting are what the notes say they are. Where
   the notes are marked *inferred* (notably `inventory-details`, whose parameters
   were renamed in Aug 2026, and the `MailData` / `mailParams` block shapes), the
   fixture is a best guess. The first run against the live API is the real test; the
   checklist lives in the WeWork engineer's handover notes and in
   [`docs/CAPTURE_GUIDE.md`](../../../docs/CAPTURE_GUIDE.md).

When a real capture becomes available, replace these with
`node scripts/record-fixture.mjs` output (it redacts on the way out), read the file
before committing it, and delete this paragraph's caveat for the endpoints you
replaced.

## The synthetic JWT

`token-response.json`, `token-response-rotated.json`,
`token-response-no-refresh.json` and `localstorage-dump.json` share one fabricated
access token:

| Claim | Value |
| --- | --- |
| `aud` | `["wework", "https://idp.wework.com/userinfo"]` |
| `https://wework.com/user_uuid` | `11111111-2222-4333-8444-555555555555` |
| `iat` | `1789927200` (2026-09-20T18:00:00Z) |
| `exp` | `1789970400` (2026-09-21T06:00:00Z) |

Tests freeze the clock inside that window. The signature segment is not base64 and
will never verify — which is fine, because nothing in this codebase verifies it (see
`decodeJwtPayload`; we are not the audience and hold none of Auth0's keys).

`localstorage-dump.json` also contains a *second*, deliberately unsuitable entry
(audience `https://idp.wework.com/userinfo`, no member id, an earlier `exp`) so the
"pick the wework-audience token with the latest exp" rule in `parseManualSession`
is actually exercised rather than passing by luck.

## Deliberate traps

These fixtures are not tidied-up. Each oddity below is in there because the real API
does it and a clean fixture would hide a bug:

| File | Trap |
| --- | --- |
| `locations-by-geo.json`, `get-spaces.json` | `openTime` is `"9:00"` and `"8:0"` — **not** zero-padded. |
| `upcoming-bookings.json` | Times are local wall clock stamped `Z`: `"2026-09-22T09:00:00Z"` means 09:00 in Berlin, not 11:00. Converting it is the bug. |
| `get-spaces.json` | Three workspaces across two locations: `accountType` 2 (with `reservable.KubeId`) and `accountType` 4 (with `inventoryUuid` and an empty `reservable`), so both `SpaceID` rules are covered. One workspace has `seat.available: 0`. |
| `get-spaces.json` | The nested `location` is **partial** (no `name`), as upstream returns it — the client merges it with what `listLocations*` already fetched. |
| `booking-refused.json` | HTTP **200** with `BookingStatus: "BookingFailed"`. This is how WeWork declines a booking. |
| `cancel-true.json` | The whole body is the JSON literal `true`. |
| `city-details.json` | `"Berlin"` appears twice, differently cased, to exercise de-duplication. |
| `error-envelope.json` | `{responseStatus:{type:"error"}}`, which also arrives with HTTP 200. |
| `inventory-details-empty.json` | `kubeSpaceId: ""` — the client must fall back to the `accountType` rules rather than book an empty space id. |

## Index

| File | Endpoint |
| --- | --- |
| `auth0-config.json` | `GET /workplaceone/api/auth0/v2/config` |
| `co-authenticate-ok.json` | `POST idp.wework.com/co/authenticate` |
| `co-authenticate-blocked.json` | same, with `requires_verification` |
| `token-response*.json` | `POST idp.wework.com/oauth/token` |
| `localstorage-dump.json` | the browser bookmarklet's clipboard payload |
| `city-details.json` | `GET /wework-yardi/location/get-city-details` |
| `locations-by-geo.json` | `GET /wework-yardi/ondemand/get-locations-by-geo` |
| `profile.json` | `GET /wework-yardi/user/get-user-profile` |
| `monthly-credits.json` | `GET /common-account/monthly-credits` |
| `get-spaces.json` | `GET /spaces/get-spaces` |
| `inventory-details.json`, `inventory-details-empty.json` | `GET /common-booking/inventory-details` |
| `quote.json` | `POST /common-booking/quote` |
| `booking-success.json`, `booking-refused.json` | `POST /common-booking/` |
| `upcoming-bookings.json` | `GET /common-booking/get-app-upcoming-bookings` |
| `cancel-true.json` | `POST /common-booking/cancel` |
| `error-envelope.json` | any endpoint's 200-with-error |
