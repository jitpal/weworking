# Design

How weworking is put together, and why. This is the architecture document: if you are
deploying rather than modifying, start with [SELF_HOSTING.md](./SELF_HOSTING.md).

Open source (MIT). Unofficial; the authors are unaffiliated with WeWork. Self-hostable:
one deployment per WeWork account.

## 1. Goal

A Cloudflare Worker exposing WeWork hot-desk search and booking to AI agents twice
over: as a remote MCP server (Streamable HTTP, stateless, at `/mcp`) and as a REST API
with OpenAPI (`/api/*`). Both front doors take the same two credentials, an OAuth 2.1
access token issued by this worker or an API key the operator minted at `/admin/keys`.
WeWork session tokens live in one SQLite Durable Object and never leave it.

Phase 1 books hot desks only. Every schema already carries `space_type`, so meeting
rooms and private offices could land without a new schema version.

## 2. Stack

- TypeScript strict, ESM. Node 22 for tooling. npm, lockfile committed.
- wrangler 4.131.x, `wrangler.jsonc`, `compatibility_date: "2026-08-04"`,
  `compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"]`.
- hono ^4.13 (router), zod ^4 (schemas, and `z.toJSONSchema` for the OpenAPI document).
- MCP: `createMcpHandler` from `agents@0.23`'s `agents/mcp/server`, wrapping
  `McpServer` from `@modelcontextprotocol/server@2.0.0`. A fresh `McpServer` per
  request, built by a factory.
- OAuth: `@cloudflare/workers-oauth-provider@0.10.x`, which needs the `OAUTH_KV`
  binding.
- Tests: vitest ^4.1 with `@cloudflare/vitest-pool-workers@0.22.x` (the `cloudflareTest`
  plugin in `vitest.config.ts`, pointed at `wrangler.jsonc`). Tests never reach the real
  network; upstream responses come from `test/fixtures/`.
- Lint and format: `@biomejs/biome` 2.x. `npm run check` is biome + `tsc --noEmit` +
  `vitest run`.
- Binding types: `wrangler types` writes `worker-configuration.d.ts`, which is committed.

Exact exported signatures for the pinned libraries are in
[DEPENDENCY_NOTES.md](./DEPENDENCY_NOTES.md).

## 3. Bindings, secrets and vars

Bindings (`wrangler.jsonc`):

- `SESSION`, Durable Object class `WeWorkSession`, created by the `new_sqlite_classes`
  migration `v1`.
- `OAUTH_KV`, KV namespace for the OAuth provider's clients, grants and tokens. The
  committed config carries a placeholder id; the self-hoster creates their own.
- Cron trigger `"17 5 * * *"`, daily refresh and prune.
- `OAUTH_PROVIDER` is injected at request time by the provider. It is declared on `Env`
  and has no entry in `wrangler.jsonc`.

Secrets (`wrangler secret put`, or `.dev.vars` locally; `.dev.vars.example` is committed):

- `ADMIN_PASSWORD`, required. Gates `/admin/*` and the OAuth approval screen.
- `QUOTE_SIGNING_KEY`, required. 32+ random bytes, hex.
- `COOKIE_SIGNING_KEY`, required. 32+ random bytes, hex.
- `WEWORK_USERNAME`, `WEWORK_PASSWORD`, optional. Only headless login needs them.

There is no secret for agent credentials. API keys are minted at `/admin/keys` and only
their SHA-256 is stored, in the Durable Object.

Vars (plain values in `wrangler.jsonc`, parsed and validated by `src/env.ts#parseConfig`):
`WRITE_ENABLED="true"`, `MAX_BOOKINGS_PER_DAY="1"`, `MAX_BOOKINGS_PER_WEEK="7"`,
`MAX_CREDITS_PER_BOOKING="0"` (`0` allows only bookings that cost no credits,
`"unlimited"` removes the cap), `MAX_CASH_PER_BOOKING="0"` (the same cap for money, in
the building's own currency, for pay-as-you-go desks), `LOGIN_STRATEGY="auto"`
(`auto` | `headless` | `manual`), `PUBLIC_BASE_URL=""`.

The quote lifetime is not configurable. It is the `QUOTE_TTL_SECONDS` constant in
`src/core/booking-service.ts`, ten minutes.

## 4. Repo layout

```
README.md LICENSE SECURITY.md
package.json tsconfig.json vitest.config.ts biome.jsonc wrangler.jsonc worker-configuration.d.ts
.gitignore .dev.vars.example .editorconfig .nvmrc
.github/PULL_REQUEST_TEMPLATE.md  .github/workflows/close-pull-requests.yml  .github/ISSUE_TEMPLATE/bug_report.md
docs/ DESIGN.md SELF_HOSTING.md CLIENTS.md API.md LOCATION_AND_TIME.md
      WEWORK_API.md THREAT_MODEL.md DEPENDENCY_NOTES.md
skills/book-a-desk/SKILL.md  (plain Agent Skill; no plugin manifest)
scripts/ record-fixture.mjs (manual, live, redacts)  wrangler.mjs (config picker)
src/
  index.ts                 # composes everything; default fetch + scheduled, exports the DO class
  env.ts                   # Env bindings + parseConfig(): vars -> typed Config
  errors.ts                # AppError { code, message, hint, status } + the code taxonomy
  redact.ts                # redact(), redactHeaders(), redactUrl() for logging
  core/
    types.ts               # domain types, the shared contract (see §5)
    quote.ts               # signQuote / verifyQuote (HMAC-SHA-256, base64url)
    booking-service.ts     # search -> quotes; book(quote) -> caps, idempotency, audit, upstream
    time.ts                # local <-> UTC, 30-minute rounding, IANA zones via Intl
  wework/
    client.ts              # WeWorkClient: every members.wework.com call
    headers.ts             # the header block upstream expects
    mappers.ts             # raw JSON -> domain types
    raw-types.ts           # raw upstream shapes, only the fields we read
    auth/
      index.ts             # the barrel the session DO imports
      config.ts            # auth0/v2/config discovery
      headless-login.ts    # full Auth0 PKCE flow with manual redirects and cookies
      token-exchange.ts    # the /oauth/token wrapper
      refresh.ts           # refresh_token grant
      manual.ts            # parses a pasted session (SPA cache, JSON, or bare token)
      cookie-jar.ts pkce.ts
  session/
    do.ts                  # WeWorkSession Durable Object (SQLite)
    token-store.ts         # TokenStore: DO-backed and in-memory implementations
    cron.ts                # scheduled(): refresh if expiring, prune
  auth/
    guard.ts               # Actor resolution, requireScope, the 401 challenge
    tokens.ts              # API key minting, SHA-256, constant-time compare
    oauth.ts               # OAuthProvider wiring + the approval page
    admin-session.ts       # signed admin cookie, login form, CSRF
    sign.ts rate-limit.ts
  mcp/
    server.ts              # mountMcp(): the /mcp route, instructions text, host checks
    tools.ts               # tool registration and annotations
    schemas.ts             # zod request/response schemas, shared with REST and OpenAPI
    operations.ts          # the six operations, called by both front doors
  http/
    api.ts                 # REST routes /api/*
    openapi.ts             # OpenAPI 3.1 from the same zod schemas, plus /api/docs
    admin.ts               # /admin pages: status, connect, keys, audit
    admin-html.ts          # the shared page shell and escaping
    health.ts              # GET /healthz
test/
  fixtures/wework/*.json   # synthetic upstream bodies
  helpers/fake-fetch.ts    # route-table fetch stub
  **/*.test.ts
```

## 5. Domain types

`src/core/types.ts` is authoritative and documented inline; it is not duplicated here,
because a copy drifts. The names it defines are `Scope`, `Actor`, `SpaceType`,
`Location`, `SpaceAvailability`, `QuotePayload`, `Booking`, `Credits`, `Profile`,
`SessionInfo`, `SessionRecord`, `TokenStore`, `LoginStrategy`, the argument and result
shapes for each operation, and the `BookingService` interface itself.

Two rules hold for the whole file: response fields are `camelCase` and are serialised
straight out as MCP `structuredContent` and as REST JSON bodies, so renaming one is a
breaking API change; and request parameters are `snake_case` everywhere, whether they
arrive as a tool argument, a JSON body or a query string.

`src/core/booking-service.ts` adds `SearchArgs` (`SearchAvailabilityArgs` plus `limit`)
and `WhoamiResultWithCaps` (`WhoamiResult` plus `capsRemaining`), both additive.

Error codes live in `src/errors.ts` and are listed with their meanings in
[API.md](./API.md). Every one carries a `hint` written for an agent.

## 6. WeWork upstream

[WEWORK_API.md](./WEWORK_API.md) has the endpoint-level detail. The rules that shape
the code: the Auth0 access token *is* the API bearer; a fixed header block goes on every
call; which id lands in `SpaceID` depends on the building's `accountType`; times go up
as UTC `Z` on 30-minute boundaries; a booking returns HTTP 200 even when refused, so
`BookingStatus === "BookingSuccess"` is what success means; the bookings list stamps
local wall clock with `Z`; `get-spaces` needs the building's own offset for the
requested date. The places-and-clocks rules are stated once in
[LOCATION_AND_TIME.md](./LOCATION_AND_TIME.md).

## 7. Quote token

```text
quote = base64url(json(QuotePayload)) "." base64url(hmacSha256(QUOTE_SIGNING_KEY, payloadB64))
```

Verification is a constant-time compare, then an `exp` check, then an `accountId` match
against the calling actor. `create_booking` accepts a quote and nothing else, so an
agent cannot describe a booking in free text.

## 8. Durable Object `WeWorkSession`

One instance, `session:default`, SQLite-backed. Tables: `session`, `api_keys`,
`idempotency`, `bookings_ledger`, `audit`, `locations`.

RPC surface (the class extends `DurableObject`, so these are direct RPC calls):
`getAccessToken`, `setSession`, `getSessionInfo`, `clearSession`, `reserveBooking`,
`confirmBooking`, `releaseBooking`, `cancelLedger`, `capsRemaining`, `idempotencyGet`,
`idempotencyPut`, `rememberLocations`, `getLocation`, `createApiKey`, `listApiKeys`,
`revokeApiKey`, `matchApiKey`, `audit`, `listAudit`, `maintain`, `ping`.

`getAccessToken` coalesces concurrent logins and refreshes on an instance field, and
tries refresh first, then headless login when credentials are present and
`LOGIN_STRATEGY` is not `manual`, then raises `SESSION_MISSING` or `UPSTREAM_BLOCKED`.
Nothing in this class logs a token.

The `locations` table is what makes a search by bare `location_id` work in any isolate:
every listing writes the buildings it saw, and the write is awaited.

## 9. Front door

- `/mcp` and `/api/*` are protected. The `OAuthProvider` validates OAuth access tokens
  and, through its `resolveExternalToken` seam, API keys presented as
  `Authorization: Bearer ww_...` and matched by SHA-256 against the `api_keys` table.
  Either way the caller's props arrive on `ctx.props` and `src/auth/guard.ts` turns
  them into an `Actor`. The provider does not enforce scope, so the operations do.
- An unauthenticated request gets 401 with
  `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`,
  which is how an MCP client discovers that this server speaks OAuth.
- OAuth endpoints: `/oauth/authorize` (our approval page), `/oauth/token` and
  `/oauth/register` (the provider's). The approval page asks for `ADMIN_PASSWORD`,
  shows the client name and the requested scopes with only `read` pre-ticked, and
  calls `completeAuthorization` with the actor props. Dynamic client registration and
  CIMD are on; a registered client expires after 30 days and registrations are rate
  limited per IP.
- `/admin/*` takes the signed admin cookie and nothing else. The same cookie signs off
  OAuth approvals, so the operator types the password once per browser. Pages: the
  dashboard, `/admin/connect`, `POST /admin/session`, `/admin/keys`, `/admin/audit`,
  `/admin/status`.
- `/healthz`, `/api/openapi.json` and `/api/docs` are public and secret-free.
- The connect page accepts the Auth0 SPA `localStorage` cache entry (key prefix
  `@@auth0spajs@@`), a raw `{access_token, refresh_token?, expires_in|expires_at}`
  object, or a bare bearer token. A bookmarklet copies the cache to the clipboard
  rather than posting it here: the admin cookie is `SameSite=Lax`, so a cross-site
  fetch from `members.wework.com` would not carry it.

## 10. Tools and routes

MCP tools, names exact: `whoami`, `list_locations`, `search_availability`,
`create_booking`, `list_bookings`, `cancel_booking`. Each returns
`content: [{ type: "text", text: summary }]` plus `structuredContent`; a failure is
`isError: true` carrying `{ code, message, hint }`. Reads are annotated `readOnlyHint`,
cancel `destructiveHint`.

REST mirror: `GET /api/whoami`, `GET /api/locations`, `GET /api/availability`,
`POST /api/bookings`, `GET /api/bookings`, `DELETE /api/bookings/:id`, plus the public
`GET /api/openapi.json` and `GET /api/docs`. Both front doors go through
`src/mcp/operations.ts`, so a REST body and the matching `structuredContent` are the
same bytes.

## 11. Conventions

- No secret, token, cookie or password in a log line, an error, or a tool result. Log
  output goes through `redact()`.
- Every upstream call goes through `WeWorkClient` with an injected `fetch` and a
  `TokenStore`. On a 401 it forces one refresh and retries once.
- Rate limiting: honour `Retry-After` up to three attempts on auth operations; never
  retry a booking.
- Commit style is Conventional Commits. Never commit `.dev.vars`, `.wrangler/` or
  `wrangler.local.jsonc`.
