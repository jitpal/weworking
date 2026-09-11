# WeWork member API notes (unofficial, reverse-engineered)

Everything below was derived by reading open-source clients and browser captures, not
from any WeWork documentation, there is no public API. Treat it as a field report:
endpoints and payload shapes change without notice, and anything marked *inferred* has
not been exercised end to end.

Labels used here:

- **verified**, observed in at least two independent implementations, or confirmed
  against a live capture.
- **inferred**, read from one source, or deduced from surrounding behaviour. Expect
  to have to fix it.

Last reviewed: 2026-09-11.

## WeWork API. **Verified** (cross-checked against dvcrn/wework-cli, jeromewir/webook, benoib/webook, hotdesker)
- Auth0 tenant: idp.wework.com ; client_id zE51Ep7FttlmtQV6ZEGyJKsY2jD1EtAu ; audience "wework" ; realm "id-wework"
- scope "openid profile email offline_access" -> refresh_token obtainable (jeromewir refresh() works)
- redirect_uri https://members.wework.com/workplaceone/api/auth0/v2/callback?domain=members.wework.com/workplaceone
- Config discovery: GET members.wework.com/workplaceone/api/auth0/v2/config?domain=members.wework.com%2Fworkplaceone -> {domain, clientId, authorizationParams{scope,audience,redirect_uri}}
- Flow: POST idp/co/authenticate {client_id,username,password,realm,credential_type:"http://auth0.com/oauth/grant-type/password-realm"} (+Origin/Referer/Auth0-Client headers) -> login_ticket
  -> set cookies a0.spajs.txs.<client_id> & _legacy_ on idp domain = urlencoded JSON {nonce,code_verifier,scope,audience,redirect_uri,state}
  -> GET idp/authorize?...login_ticket&code_challenge S256&response_mode=query -> follow redirects manually (8-12 hops), handle /u/mfa-detect-browser-capabilities form (state, action=default, js-available=true, webauthn-available=false, webauthn-platform-available=false, is-brave=false) -> callback ?code=
  -> POST idp/oauth/token grant authorization_code {client_id, code, code_verifier, redirect_uri} -> access_token (IS the API bearer), id_token, refresh_token, expires_in
  -> refresh: POST idp/oauth/token {grant_type:refresh_token, client_id, refresh_token, redirect_uri}
- Legacy 404 now: /auth0/config (v1), /auth0/login-by-auth0-token
- Auth0-Client header: eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjIuMS4yIn0= (auth0-spa-js 2.1.2)
- Headers on every API call: Authorization: Bearer; WeWorkAuth: Bearer; WeWorkUUID: <JWT claim https://wework.com/user_uuid>; WeWorkMemberType: 2; Request-Source: com.wework.ondemand/WorkplaceOne/Prod/iOS/2.71.0(26.1) (or MemberWeb/WorkplaceOne/Prod); fe-pg: /workplaceone/content2/dashboard; Origin/Referer members.wework.com; Content-Type/Accept json
- Base https://members.wework.com/workplaceone/api
  - GET /wework-yardi/ondemand/get-locations-by-geo?isAuthenticated=true&city=&isOnDemandUser=false&isWeb=true (+userLatitude/userLongitude/boundnwLat/boundnwLng/boundseLat/boundseLng, optional accountUUID) -> locationsByGeo[]
  - GET /wework-yardi/location/get-city-details
  - GET /wework-yardi/user/get-user-profile
  - POST /app-bootstrap/bootstrap
  - GET /spaces/get-spaces?locationUUIDs=csv&date=YYYY-MM-DD&duration=30&locationOffset=+HH:MM&type=0&capacity=0&offset=0&limit=50&isWeb=true -> getSharedWorkspaces.workspaces[] {uuid, inventoryUuid, capacity, credits, openTime, closeTime, seat{total,available}, reservable.KubeId, location{uuid,accountType,timeZone,timezoneOffset,address}}
  - GET /common-booking/inventory-details?propertyGuid=&spaceGuid=&applicationType=WorkplaceOne -> kubeSpaceId (*inferred*: hotdesker only; the parameter names were renamed Aug 2026)
  - GET /common-account/monthly-credits?startDate=&endDate=
  - POST /common-booking/quote  -> grandTotal.creditRatio
  - POST /common-booking/       -> BookingStatus=="BookingSuccess", ReservationID (HTTP 200 even on refusal!)
  - GET /common-booking/get-app-upcoming-bookings?isPastBooking=false&platFormType=1&startDate=&endDate=
  - POST /common-booking/cancel?isOnDemand=false&platFormType=1 -> literal true
- Booking body: SpaceType 4, ReservationID "", TriggerCalendarEvent true, Notes null/"" (string!), MailData{...}, LocationType=location.accountType, UTCOffset=location.timezoneOffset, Currency "com.wework.credits", LocationID, SpaceID, WeWorkSpaceID=workspace.uuid, StartTime/EndTime UTC Z on 30-min boundaries; booking adds ApplicationType "WorkplaceOne", PlatformType "iOS_APP", CreditRatio from quote
- SpaceID: quote -> inventoryUuid||uuid ; booking -> accountType 2: reservable.KubeId, 4: inventoryUuid, 0: uuid (hotdesker: use kubeSpaceId from inventory-details)
- Bookings list times = local wall clock stamped Z (not UTC). **Verified**, and a frequent source of off-by-hours bugs
- Cancel body: bookingId, bookingLocationType=location.sourceType, creditsUsed, startTime/endTime "YYYY-MM-DDTHH:MM:SS.000" no Z, locationId, reservableId, spaceId, isBookingApprovalOn, bookingType 4, cancellationNote "", reservationId, mailParams{workspaceType:1,...}; headers Request-Source MemberWeb/WorkplaceOne/Prod, fe-pg /workplaceone/content2/your-bookings
- Errors: {"responseStatus":{"type":"error","message","title"}}; 429 w/ Retry-After on /authorize; occasional 403 Cloudflare block
- Risks on Workers (*inferred*, these are predictions about our own deployment, not observations): no cookie jar (manual), redirect:"manual", Auth0 bot detection on datacenter IPs (requires_verification => no headless fix), MFA unsupported, TLS fingerprint, subrequest limits (login ~10-14 subreqs), token ~12h
- Recommendation: login from laptop/browser once -> persist refresh_token -> worker only refreshes. Keep headless login as option.

## Prior art, the sources these notes come from
- dvcrn/wework-cli (Go, reference, updated 2026-09-11) + dvcrn/mcp-server-wework (Go MCP, stdio, env creds)
- SridarDhandapani/hotdesker (Chrome ext, most current endpoint intel)
- jeromewir/webook (Go HTTP server, refresh tokens, 429 handling)
- BugenZhao/wework-book-a-desk (Py, likely broken: uses retired endpoints), SKILL.md style
- benoib/webook (TS, weworkbot.md spec)

## Cloudflare architecture decisions. **Verified** against Cloudflare docs, 2026

(Not WeWork facts; kept here because the two sets of constraints only make sense together. The rationale lives in [DESIGN.md](./DESIGN.md).)
- McpAgent (DO-backed) deprecated/frozen; use createMcpHandler() from agents/mcp/server (stateless, MCP 2026-07-28 + legacy), new McpServer per request (SDK>=1.26)
- MCP SDK v2 split: @modelcontextprotocol/server ; wrangler 4.131.x ; agents 0.23.x ; compatibility_date >= 2026-08-04 (nodejs_compat default)
- Front door: static scoped bearer tokens (sha256 hashes in AUTH_TOKENS secret) Phase 1; @cloudflare/workers-oauth-provider Phase 2 (needed for claude.ai/ChatGPT connectors). Claude Code: claude mcp add --transport http --header. Cursor: headers in mcp.json. ChatGPT: OAuth or none.
- One SQLite Durable Object "session:default": token store, login mutex/coalescing, idempotency, caps, audit. No KV for token. Free plan OK.
- Lazy refresh on 401 + daily cron proactive refresh. /admin/session manual token paste as escape hatch.
- Safety: HMAC-signed quote (10min exp) required by create_booking; idempotency_key; daily/weekly caps; dry_run; read/write scopes; WRITE_ENABLED kill switch; audit log.
- Tools: whoami, list_locations, search_availability, create_booking, list_bookings, cancel_booking ; REST mirror /api/* + /openapi.json ; plugin/ (Agent Plugins 1.0.0: plugin.json, mcp.json, skills/*/SKILL.md)
- Tests: @cloudflare/vitest-pool-workers, scrubbed fixtures, stub fetch. CI: typecheck+test+deploy --dry-run; deploy.yml on main with environment guard.
- OSS: MIT, unofficial disclaimer, no baked creds, .dev.vars.example, Deploy button (verify DO-only), multi-account deferred but accountId seam.

## Live-verified on 2026-09-11 (pay-as-you-go "On Demand" account, London)

Observed from a real deployment on Cloudflare Workers. These supersede the inferred notes above where they differ.

- **Headless Auth0 login from a Worker works.** The password-realm + PKCE flow succeeded on the first attempt from Cloudflare egress, returned a refresh token, and the access token lasted 12 hours.
- **`get-locations-by-geo` item:** `{ uuid, name, latitude, longitude, address: { line1, line2, city, state, country, zip }, timeZone, distance, brandName, accountType, currency, spaceAvailabilityCount, ... }`. On a city search `address.country` is empty and `distance` is meaningless (no origin), so both are dropped. There is no offset field; derive it from `timeZone`.
- **`get-spaces` workspace:** `{ uuid, inventoryUuid, capacity, credits, location, openTime, closeTime, cancellationPolicy, operatingHours, productPrice, seat, seatsAvailable, reservable, isHybridSpace, affiliateSpaceType, SpaceTypeID }`. `productPrice.price = { currency: "GBP", amount: 70, symbol: "£" }` is the pre-tax day rate; `productPrice.halfHourCreditPrices[]` is the credit schedule; `location.currency` is the building's currency; `reservable.KubeId` is the booking id for `accountType` 2.
- **`inventory-details?propertyGuid&spaceGuid&applicationType`** answered HTTP 500 (error code 624402) for an `accountType` 2 building. `reservable.KubeId` works instead, so the call is skipped when that id is present.
- **`quote`:** request `Currency` is echoed back in `grandTotal.currency` and does not change the numbers. Response: `{ uuid, quoteStatus: 1, statusDetails: [], grandTotal: { currency, amount: 84, creditRatio: 20, symbol: "£", creditCharged: 0 }, subTotal: { amount: 70, currency }, taxes: [{ amount: 14, description: "20%", currency, name: "VAT" }], lineItems, adjustments }`. `grandTotal.amount` is the tax-inclusive total to show a cash user.
- **`get-user-profile`:** `{ uuid, email, name, phone, homeLocation: { uuid, name, currency, timeZone, address: { city, country } }, companies: [{ uuid, name, preferredMembershipNullable: { membershipType: "On Demand", productName, accountUuid } }], registrationInfo: { country } }`. `homeLocation.currency` is the account's home currency, not the building's.
- **`monthly-credits`** returns nothing useful for a cash account; `whoami.credits` is absent there.
