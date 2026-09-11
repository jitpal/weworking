# Design

How weworking is put together, and why. This is the architecture document: if you are
deploying rather than modifying, start with [SELF_HOSTING.md](./SELF_HOSTING.md) instead.

Open source (MIT). Unofficial; the authors are unaffiliated with WeWork. Self-hostable:
one deployment per WeWork account.

## 0. Goal
A Cloudflare Worker exposing WeWork hot-desk search/booking to AI agents via (a) a remote MCP server (Streamable HTTP, stateless) and (b) a REST API with OpenAPI, protected by OAuth 2.1 (workers-oauth-provider) AND static scoped bearer tokens. WeWork session tokens live in one SQLite Durable Object. Phase 1 = hot desks only; schemas carry `space_type` for future rooms.

## 1. Stack (pinned)
- TypeScript strict, ESM. Node 22 for tooling. npm (package-lock committed).
- wrangler 4.131.x, `wrangler.jsonc`, `compatibility_date: "2026-08-04"`, `compatibility_flags: ["nodejs_compat"]`.
- hono ^4.13 (router). zod ^4.
- MCP: `agents@0.23.x` -> `import { createMcpHandler } from "agents/mcp/server"` + `@modelcontextprotocol/server@2.0.0` (`McpServer`, `registerTool`). New McpServer instance per request (factory). The fallback, if `agents` ever becomes unusable, is the `WebStandardStreamableHTTPServerTransport` exported by `@modelcontextprotocol/server`, mounted in Hono. See [DEPENDENCY_NOTES.md](./DEPENDENCY_NOTES.md) for the exact signatures in use.
- OAuth: `@cloudflare/workers-oauth-provider@0.10.x` (needs KV binding `OAUTH_KV`).
- Tests: vitest ^4.1 + `@cloudflare/vitest-pool-workers@0.22.x` (`cloudflareTest` plugin in vitest.config.ts pointing at wrangler.jsonc). Never hit real network in tests. Fixtures under `test/fixtures/`.
- Lint/format: `@biomejs/biome` 2.x (`biome.jsonc`). `npm run check` = biome check + tsc --noEmit + vitest run.
- Types: `wrangler types` -> `worker-configuration.d.ts` (generated, committed).

## 2. Bindings / secrets / vars (wrangler.jsonc)
Bindings:
- `SESSION` Durable Object class `WeWorkSession` (migration `new_sqlite_classes`).
- `OAUTH_KV` KV namespace (workers-oauth-provider). id placeholder `"REPLACE_ME"`; docs tell self-hoster to create.
- Cron trigger `"17 5 * * *"` (daily refresh + prune).
Secrets (`wrangler secret put`, `.dev.vars` locally; `.dev.vars.example` committed):
- `WEWORK_USERNAME`, `WEWORK_PASSWORD` (optional if user only uses connect page)
- `ADMIN_PASSWORD` (gates OAuth approve screen + /admin/*)
- (superseded) `AUTH_TOKENS` static tokens. API keys are minted at `/admin/keys` and stored hashed in the Durable Object instead; there is no token secret.
- `QUOTE_SIGNING_KEY` (32+ random bytes hex)
- `COOKIE_SIGNING_KEY` (admin session cookie)
Vars (plain, in wrangler.jsonc `vars`, overridable):
- `WRITE_ENABLED="true"`, `MAX_BOOKINGS_PER_DAY="1"`, `MAX_BOOKINGS_PER_WEEK="5"`, `MAX_CREDITS_PER_BOOKING="0"` (0=unlimited), `QUOTE_TTL_SECONDS="600"`, `LOGIN_STRATEGY="auto"` (auto|headless|manual), `PUBLIC_BASE_URL=""` (optional override for OAuth issuer/urls).

## 3. Repo layout
```
README.md LICENSE CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md
package.json package-lock.json tsconfig.json vitest.config.ts biome.jsonc wrangler.jsonc worker-configuration.d.ts
.gitignore .dev.vars.example .editorconfig
.github/workflows/ci.yml  .github/workflows/deploy.yml
docs/ DESIGN.md SELF_HOSTING.md CLIENTS.md API.md WEWORK_API.md THREAT_MODEL.md CAPTURE_GUIDE.md
plugin/ plugin.json mcp.json skills/book-a-desk/SKILL.md
scripts/ record-fixture.mjs (manual, live, redacts)
src/
  index.ts                 # composes everything; exports default fetch + scheduled + DO class
  env.ts                   # Env type + config parsing (vars -> typed Config)
  errors.ts                # AppError { code, message, hint, status } + codes enum
  redact.ts                # redact(obj) for logging; redactHeaders
  core/
    types.ts               # DOMAIN TYPES (see §4), shared contract
    quote.ts               # signQuote/verifyQuote (HMAC-SHA-256 via WebCrypto, base64url)
    booking-service.ts     # orchestrates: search -> quotes; book(quote) -> caps/idempotency/audit -> client
    time.ts                # local<->UTC helpers, 30-min rounding, IANA tz via Intl
  wework/
    client.ts              # WeWorkClient class: all members.wework.com calls; takes a TokenProvider
    auth/
      config.ts            # fetch auth0/v2/config (discovery)
      headless-login.ts    # Strategy A: full Auth0 PKCE flow with manual redirects/cookies
      refresh.ts           # refresh_token grant
      cookie-jar.ts        # minimal domain/path-aware jar
      pkce.ts
    mappers.ts             # raw JSON -> domain types
    headers.ts             # header block builder
    raw-types.ts           # raw upstream shapes (only what we read)
  session/
    do.ts                  # WeWorkSession Durable Object (SQLite): token, idempotency, caps, audit
    token-store.ts         # TokenStore interface + DO-backed impl used by worker side
    cron.ts                # scheduled(): refresh if expiring < 6h, prune
  auth/
    guard.ts               # resolves Actor from request: OAuth token (via provider props) or API key
    tokens.ts              # API key minting, sha256 and constant-time compare
    oauth.ts               # OAuthProvider wiring: authorize page (admin password), token endpoints
    admin-session.ts       # signed cookie for /admin pages
  mcp/
    server.ts              # createServer(actor, deps) -> McpServer with tools; instructions text w/ disclaimer
    tools.ts               # tool definitions (zod schemas) mapping to booking-service
  http/
    api.ts                 # Hono routes /api/*
    openapi.ts             # hand-written OpenAPI 3.1 JSON from the same zod schemas (zod v4 toJSONSchema)
    admin.ts               # /admin/connect page + POST /admin/session + GET /admin/audit + /admin/status
    health.ts              # GET /healthz (no secrets; presence booleans, session age)
test/
  fixtures/wework/*.json   # scrubbed upstream responses
  helpers/fake-fetch.ts    # route-table fetch stub
  *.test.ts
```

## 4. Domain types (src/core/types.ts), authoritative names
```ts
export type Scope = "read" | "write" | "admin";
export interface Actor { kind: "oauth" | "bearer" | "admin"; name: string; scopes: Scope[]; accountId: string; } // accountId "default" in phase 1
export type SpaceType = "desk" | "meeting_room" | "private_office"; // phase 1 only "desk" implemented

export interface Location { locationId: string; name: string; address: string; city: string; country: string; timezone: string; latitude?: number; longitude?: number; distanceKm?: number; accountType: number; timezoneOffset: string; openTime?: string; closeTime?: string; }
export interface SpaceAvailability { spaceId: string; inventoryUuid?: string; kubeId?: string; spaceName: string; spaceType: SpaceType; capacity: number; seatsAvailable: number; seatsTotal: number; credits: number; cashPrice?: { amount: number; currency: string }; location: Location; date: string; startLocal: string; endLocal: string; startUtc: string; endUtc: string; timezone: string; }
export interface QuotePayload { v: 1; accountId: string; locationId: string; spaceId: string; wwSpaceId: string; bookingSpaceId: string; accountType: number; date: string; startUtc: string; endUtc: string; credits: number; timezone: string; tzOffset: string; locationName: string; address: string; city: string; country: string; state?: string; exp: number; }
export interface Booking { bookingId: string; reservationId?: string; locationId: string; locationName: string; address?: string; date: string; startLocal: string; endLocal: string; timezone: string; status: "confirmed" | "cancelled" | "pending" | "unknown"; credits: number; cancelDeadlineLocal?: string; raw?: unknown; }
export interface Credits { remaining: number; total: number; periodStart: string; periodEnd: string; }
export interface Profile { userId: string; email?: string; name?: string; membershipType?: string; homeLocationId?: string; }
export interface SessionInfo { state: "none" | "valid" | "expiring" | "expired"; source: "login" | "manual" | "refresh" | "none"; obtainedAt?: string; expiresAt?: string; hasRefreshToken: boolean; lastError?: string; }

export interface SessionRecord { accessToken: string; refreshToken?: string; expiresAt: number; obtainedAt: number; source: "login" | "manual" | "refresh"; userUuid: string; }
export interface TokenStore { getAccessToken(opts?: { forceRefresh?: boolean }): Promise<{ accessToken: string; userUuid: string }>; getSessionInfo(): Promise<SessionInfo>; setSession(rec: Omit<SessionRecord,"obtainedAt">): Promise<void>; clear(): Promise<void>; }
export interface LoginStrategy { name: "headless" | "manual"; login(): Promise<SessionRecord>; }
```
Booking-service API (src/core/booking-service.ts):
```ts
listLocations({ query?, city?, lat?, lng?, radiusKm?, limit? }) -> Location[]
searchAvailability({ locationId?|city?, date, startTime?, endTime?, spaceType="desk", capacity? }) -> Array<SpaceAvailability & { quote: string; summary: string }>
createBooking({ quote, idempotencyKey?, dryRun?, note? }, actor) -> { booking: Booking; dryRun: boolean; creditsCharged: number; capsRemaining: {day:number; week:number}; summary: string }
listBookings({ from?, to?, includePast? }) -> Booking[]
cancelBooking({ bookingId, idempotencyKey?, dryRun? }, actor) -> { bookingId; status; creditsRefunded?; summary }
whoami() -> { profile: Profile; credits?: Credits; session: SessionInfo; actor: Actor; caps: {...}; writeEnabled: boolean }
```
Error codes (src/errors.ts): `UNAUTHORIZED, FORBIDDEN_SCOPE, WRITE_DISABLED, SESSION_MISSING, SESSION_EXPIRED, UPSTREAM_AUTH, UPSTREAM_BLOCKED (auth0 requires_verification/captcha), UPSTREAM_RATE_LIMITED, UPSTREAM_ERROR, QUOTE_INVALID, QUOTE_EXPIRED, CAP_EXCEEDED, NOT_AVAILABLE, BOOKING_REFUSED, NOT_FOUND, UNSUPPORTED_SPACE_TYPE, VALIDATION`. Every error has a `hint` for the agent (e.g. SESSION_MISSING -> "Ask the user to open <base>/admin/connect").

## 5. WeWork upstream facts
See [WEWORK_API.md](./WEWORK_API.md) for the endpoint-level detail. Key rules: access token IS the bearer; header block; SpaceID rules by accountType; UTC Z on 30-min boundaries; booking 200-with-refusal -> check BookingStatus=="BookingSuccess"; bookings list times are local-wall-clock-stamped-Z; cancel body; monthly-credits; discovery via auth0/v2/config. Prefer `inventory-details?propertyGuid&spaceGuid` for kubeSpaceId when present; fall back to accountType rules.

## 6. Quote token
`quote = base64url(json(QuotePayload)) + "." + base64url(hmacSha256(QUOTE_SIGNING_KEY, payloadB64))`. verify: constant-time compare, exp check, accountId match. create_booking accepts ONLY a quote.

## 7. Durable Object `WeWorkSession` (SQLite)
Tables: `session(id TEXT PK, access_token, refresh_token, expires_at INT, obtained_at INT, source, user_uuid, last_error)`, `api_keys(id TEXT PK, name, sha256 UNIQUE, scopes JSON, created_at INT, last_used_at INT, revoked_at INT)`, `idempotency(key PK, kind, result_json, created_at)`, `bookings_ledger(booking_id PK, date, credits, created_at, actor, dry_run INT)`, `audit(id AUTOINC, ts, actor, tool, args_redacted, outcome, booking_id, credits, dry_run)`.
RPC methods (use DO RPC, class extends DurableObject): `getAccessToken({minTtlSec, force})` (coalesce in-flight login/refresh via instance field promise; strategy order: refresh -> headless login (if creds present & LOGIN_STRATEGY != manual) -> throw SESSION_MISSING/UPSTREAM_BLOCKED), `setSession(rec)`, `getSessionInfo()`, `clearSession()`, `checkAndReserveCap({date, credits, dryRun})`, `recordBooking(...)`, `releaseBooking(bookingId)`, `idempotencyGet/Put`, `audit(entry)`, `listAudit({limit})`, `createApiKey({id,name,sha256,scopes})`, `listApiKeys()`, `revokeApiKey(id)`, `matchApiKey(sha256)`, `maintain()` (cron: refresh if <6h, prune). Never log tokens.

## 8. Front door
- `/mcp` (POST/GET) and `/api/*` are protected: Actor from OAuth access token (workers-oauth-provider validates; props {name, scopes}) OR `Authorization: Bearer ww_<key>` matched by sha256 against the `api_keys` table in the Durable Object (superseding the AUTH_TOKENS secret in this section). Guard returns 401 with `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"` so MCP clients discover OAuth.
- OAuth: `OAuthProvider({ apiRoute: ["/mcp","/api/"], apiHandler, defaultHandler, authorizeEndpoint:"/oauth/authorize", tokenEndpoint:"/oauth/token", clientRegistrationEndpoint:"/oauth/register" })`. Authorize page: minimal HTML form, ADMIN_PASSWORD, shows client name + requested scopes, approve -> completeAuthorization with props. Support CIMD/DCR as the lib does by default.
- `/admin/*` (connect page, session POST, API keys, audit, status) gated by the admin cookie only (login form with ADMIN_PASSWORD). The same cookie signs off OAuth approvals, so the operator types the password once per browser.
- `/healthz` public: `{ok, version, secrets:{weworkCredentials:bool, adminPassword:bool, quoteKey:bool, cookieKey:bool}, session:SessionInfo(no tokens), writeEnabled}`.
- Connect page: instructions + textarea to paste (a) the Auth0 SPA localStorage cache entry JSON (key prefix `@@auth0spajs@@`), (b) a raw `{access_token, refresh_token?, expires_in|expires_at}` JSON, or (c) just a bearer token. Bookmarklet: reads all localStorage keys starting `@@auth0spajs@@` on members.wework.com and POSTs to `<base>/admin/session` via fetch with credentials (CORS: allow origin https://members.wework.com on that route only, require admin cookie... NOTE cookie is SameSite so cross-site fetch may not carry it; therefore bookmarklet instead copies JSON to clipboard and opens the connect page, where the user pastes. Keep it simple and reliable.). Parse: decode JWT for exp and `https://wework.com/user_uuid`.

## 9. MCP tools (names exact)
whoami, list_locations, search_availability, create_booking, list_bookings, cancel_booking. Each returns `content:[{type:"text", text: summary}]` + `structuredContent`. Errors -> `isError:true` with `{code, message, hint}` text. Server `instructions` includes disclaimer + "always search then confirm with user before create_booking; report credits; times are local". Tool annotations: readOnlyHint for reads, destructiveHint for cancel.
REST: GET /api/whoami, GET /api/locations, GET /api/availability, POST /api/bookings, GET /api/bookings, DELETE /api/bookings/:id, GET /api/openapi.json (public), GET /api/docs (optional tiny HTML). Same JSON shapes as structuredContent.

## 10. Conventions
- No secrets/tokens in logs, errors, or tool outputs. Use redact().
- All upstream calls through `WeWorkClient` with injected `fetch` (for tests) and `TokenProvider`; on 401 -> forceRefresh once and retry.
- Rate-limit politeness: 429 -> respect Retry-After up to 3 tries on auth; single attempt on booking.
- Tests: unit (quote, time, mappers, tokens, guard), DO tests via vitest-pool-workers (`env.SESSION`), integration via `SELF.fetch` on /mcp (tools/list, tools/call with forged quote -> QUOTE_INVALID; dry_run) with fetch stubbed via a module-level `setUpstreamFetch()` seam or `fetchMock` from cloudflare:test.
- Commit style: conventional commits. Do not commit `.dev.vars`, `.wrangler/`, `node_modules/`.
