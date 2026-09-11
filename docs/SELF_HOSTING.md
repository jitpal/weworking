# Self-hosting weworking

The long version of the README quick start, with troubleshooting. One deployment serves one WeWork account, yours.

Before you start, re-read the disclaimer in the [README](../README.md#unofficial-read-this-first). This software spends your credits and may violate WeWork's terms of service.

## Requirements

- Cloudflare account. The free plan is sufficient, see [Free plan notes](#free-plan-notes).
- Node 22 and npm.
- A WeWork account with hot-desk credits and access to `members.wework.com` in a browser.

## 1. Clone and install

```sh
git clone https://github.com/<you>/weworking.git
cd weworking
npm install
npx wrangler login
```

## 2. Create the KV namespace

The OAuth provider stores clients, grants, and tokens in KV. The repo ships with a placeholder id.

```sh
npx wrangler kv namespace create OAUTH_KV
```

Copy the printed `id` into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "paste-the-id-here" }
]
```

If you leave the `REPLACE_ME...` placeholder in place, deploy fails with an unknown-namespace error. The Durable Object binding (`SESSION` / `WeWorkSession`) needs no setup; the `new_sqlite_classes` migration creates it on first deploy.

## 3. Set secrets

```sh
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put QUOTE_SIGNING_KEY
npx wrangler secret put COOKIE_SIGNING_KEY
```

Generate the two signing keys separately. Do not reuse one value for both:

```sh
openssl rand -hex 32
```

Optional:

```sh
npx wrangler secret put AUTH_TOKENS      # static scoped bearer tokens, JSON array
npx wrangler secret put WEWORK_USERNAME  # only if you want automatic login
npx wrangler secret put WEWORK_PASSWORD
```

| Secret | Purpose | Notes |
| --- | --- | --- |
| `ADMIN_PASSWORD` | gates `/admin/*` and the OAuth approval screen | the only thing between the internet and your session store; make it long |
| `QUOTE_SIGNING_KEY` | HMAC-SHA-256 key for booking quotes | rotating it invalidates outstanding quotes (harmless) |
| `COOKIE_SIGNING_KEY` | signs the admin session cookie | rotating it logs you out of `/admin` |
| `AUTH_TOKENS` | static bearer tokens as `[{name, sha256, scopes}]` | hashes only; omit entirely to use OAuth alone |
| `WEWORK_USERNAME` / `WEWORK_PASSWORD` | automatic Auth0 login | often blocked from datacenter IPs; impossible with MFA |

For local development put the same names in `.dev.vars` (copy `.dev.vars.example`). Never commit it.

### Vars

Plain values in `wrangler.jsonc` under `vars`. Edit and redeploy to change them.

| Var | Default | Effect |
| --- | --- | --- |
| `WRITE_ENABLED` | `"true"` | `"false"` rejects every write with `WRITE_DISABLED` |
| `MAX_BOOKINGS_PER_DAY` | `"1"` | enforced in the Durable Object ledger |
| `MAX_BOOKINGS_PER_WEEK` | `"5"` | same |
| `MAX_CREDITS_PER_BOOKING` | `"0"` | `0` = no ceiling |
| `QUOTE_TTL_SECONDS` | `"600"` | quote lifetime |
| `LOGIN_STRATEGY` | `"auto"` | `auto` tries refresh then headless login; `headless` forces login attempts; `manual` never logs in, so only a pasted session works |
| `PUBLIC_BASE_URL` | `""` | set to your canonical origin if you use a custom domain, so OAuth metadata and error hints use it |

## 4. Deploy

```sh
npm run deploy
```

Wrangler prints the deployed URL. The root of that URL is a small landing page with links to the health check, the admin pages, and the OpenAPI document. Then:

```sh
curl -s https://<your-worker>.workers.dev/healthz | jq
```

## 5. Connect WeWork

### Option A: automatic login

Set `WEWORK_USERNAME` and `WEWORK_PASSWORD`, keep `LOGIN_STRATEGY="auto"`, and make any read call. The Worker performs the Auth0 password-realm and PKCE flow, stores the access token and refresh token in the Durable Object, and refreshes from then on. Once it holds a refresh token it does not log in again, so the bot-detection risk is confined to the first login.

This fails in two cases, and neither clears on retry:

- **Auth0 bot detection.** Logins from Cloudflare's datacenter IPs may get `requires_verification` or a captcha. You will see `UPSTREAM_BLOCKED`. No header or retry fixes it.
- **MFA on the account.** Not supported. Use option B.

### Option B: paste a session

1. Open `https://<your-worker>.workers.dev/admin/connect`. You are sent to `/admin/login` first; sign in with `ADMIN_PASSWORD` (the cookie lasts 12 hours).
2. In another tab, sign in to `https://members.wework.com` as normal.
3. Follow the instructions on the connect page to copy your session. It accepts any of:
   - the Auth0 SPA cache entry from `localStorage` (the key starting `@@auth0spajs@@`). This is the best option because it includes the refresh token;
   - a raw JSON object `{"access_token": "...", "refresh_token": "...", "expires_in": 43200}`;
   - a bare access token string (works, but expires in ~12 hours with no refresh).
4. Paste it into the textarea and submit. The page decodes the token for its expiry and the `https://wework.com/user_uuid` claim and reports the new session state.

Access tokens last about 12 hours. With a refresh token the Worker renews itself (lazily on 401, and proactively via the `17 5 * * *` cron when under 6 hours remain), so in practice you revisit this page monthly at most, usually only after you change your WeWork password or sign out everywhere.

## 6. Issue a static token (optional)

```sh
node scripts/hash-token.mjs --name claude-code --scopes read,write
```

Copy the printed token into your client config (it is shown once), merge the printed JSON entry into your `AUTH_TOKENS` array, and push the whole array:

```sh
npx wrangler secret put AUTH_TOKENS
```

Use `--scopes read` for anything that should never spend credits. `admin` additionally allows `POST /admin/session` and `GET /admin/audit`.

## 7. Connect an agent

See [CLIENTS.md](CLIENTS.md).

## Troubleshooting

### Reading /healthz

`GET /healthz` is public and contains no secret values:

```json
{
  "ok": true,
  "version": "0.1.0",
  "secrets": {
    "weworkCredentials": false,
    "adminPassword": true,
    "quoteKey": true,
    "cookieKey": true,
    "authTokens": 2
  },
  "session": {
    "state": "valid",
    "source": "manual",
    "obtainedAt": "2026-09-11T08:12:00.000Z",
    "expiresAt": "2026-09-11T20:12:00.000Z",
    "hasRefreshToken": true
  },
  "writeEnabled": true
}
```

| Field | Meaning |
| --- | --- |
| `secrets.*` | presence only. `adminPassword` or `quoteKey` false means you skipped a required secret. `authTokens` is the number of entries parsed. `0` with a secret set means malformed JSON |
| `session.state` | `none` (never connected), `valid`, `expiring` (under 6h left), `expired` |
| `session.source` | `login` (automatic), `manual` (pasted), `refresh`, `none` |
| `session.hasRefreshToken` | `false` means the session dies at `expiresAt` and you must reconnect |
| `session.lastError` | last failure from a login or refresh attempt, redacted. Present after `UPSTREAM_BLOCKED` |
| `writeEnabled` | the `WRITE_ENABLED` kill switch |

### `UPSTREAM_BLOCKED`

Auth0 refused the automatic login and asked for human verification (bot detection, captcha, or `requires_verification`). Logging in from a datacenter IP makes this more likely, and it does not clear by retrying, changing headers, or waiting.

Fix: connect via `/admin/connect` (option B above). Once you have a refresh token, the Worker never needs to log in again, and refresh requests are not subject to this check. Optionally set `LOGIN_STRATEGY="manual"` so it stops trying.

### `SESSION_EXPIRED` / `SESSION_MISSING`

- `SESSION_MISSING`: nothing is stored. Either you never connected, or the session was cleared. Open `/admin/connect`.
- `SESSION_EXPIRED`: a session exists but the access token is past its expiry and could not be refreshed (no refresh token, or the refresh was rejected because you changed your password or signed out everywhere on WeWork). Reconnect via `/admin/connect`.

Check `/healthz` to tell them apart before debugging anything else. Agents get the same distinction in the error `hint`.

### `UPSTREAM_AUTH` on every call

The stored token is being rejected by WeWork even though it has not expired. Usually this is a token from a different account or a truncated paste. Reconnect.

### `UPSTREAM_RATE_LIMITED`

WeWork returned 429. The client honours `Retry-After` up to three attempts on auth operations and does not retry bookings. Wait it out; do not loop.

### `QUOTE_EXPIRED` / `QUOTE_INVALID`

Quotes live `QUOTE_TTL_SECONDS` (default 600). Expired means search again and book with the fresh quote. Invalid means the signature did not verify: a mangled copy/paste, a quote from another deployment, or `QUOTE_SIGNING_KEY` changed since it was issued.

### `CAP_EXCEEDED`

The daily or weekly cap, or `MAX_CREDITS_PER_BOOKING`, would be exceeded. The error states which. Raise the relevant var in `wrangler.jsonc` and redeploy if that is what you want.

### Deploy fails on the Durable Object migration

If you renamed the class or removed the `new_sqlite_classes` migration, wrangler refuses. Keep the existing migration entries and append new ones; never rewrite history there, or you lose the stored session.

### Rotating tokens

- **Static bearer token.** Generate a replacement with `scripts/hash-token.mjs`, put both the old and new entries in `AUTH_TOKENS`, `wrangler secret put AUTH_TOKENS`, update the client, then remove the old entry and put the secret again. Removal takes effect on the next request after the secret propagates; there is no cache to clear.
- **`QUOTE_SIGNING_KEY`.** `wrangler secret put QUOTE_SIGNING_KEY` with a new `openssl rand -hex 32`. Outstanding quotes become `QUOTE_INVALID`; clients just search again.
- **`COOKIE_SIGNING_KEY`.** Same; existing admin cookies stop working and you sign in to `/admin` again.
- **`ADMIN_PASSWORD`.** Put a new value, then rotate `COOKIE_SIGNING_KEY` too if you believe the old password leaked, so any live admin cookie dies with it.
- **WeWork session.** Sign out on `members.wework.com` (this invalidates the refresh token), then paste a fresh session at `/admin/connect`. Clearing the stored session from the admin page removes it from the Durable Object but does not revoke it upstream. Do both.

### Revoking a client

- **OAuth client.** Grants and tokens live in `OAUTH_KV`. List and delete the keys belonging to that client:

  ```sh
  npx wrangler kv key list --binding OAUTH_KV
  npx wrangler kv key delete --binding OAUTH_KV "<key>"
  ```

  Deleting the grant immediately invalidates its access and refresh tokens. To revoke everything at once, delete all keys in the namespace (or delete and recreate the namespace). Every client then has to re-authorise.
- **Static token.** Remove its entry from `AUTH_TOKENS` and `wrangler secret put AUTH_TOKENS`.
- **Everything, right now.** Set `WRITE_ENABLED="false"` and `npm run deploy` to stop all writes, then clear the WeWork session from `/admin` so reads stop too.

Check `/admin/audit` afterwards to see what the credential did while it was valid.

## Free plan notes

The default architecture fits the Cloudflare free plan:

- **SQLite Durable Objects** are available on the free plan, which is why the session, idempotency records, caps ledger, and audit log all live in one DO (`session:default`) rather than in KV or D1.
- **Workers KV** is on the free plan, and is used only by the OAuth provider.
- **Cron triggers** are on the free plan. One daily run at `17 5 * * *`.
- Worker CPU and subrequest limits matter mainly for the headless login path (10-14 subrequests for the Auth0 redirect chain). Normal reads and bookings are a handful of subrequests.

Options that are deliberately not used today:

- **Browser Rendering** (Puppeteer in a real browser inside the Worker) would pass the fingerprint side of Auth0's checks for automatic login. It is not built yet and has its own quotas. The `/admin/connect` paste flow exists so you do not need it.
- **A relay on a residential IP.** A tiny local process that logs in from your own network and pushes the session to `POST /admin/session` achieves the same thing for free, at the cost of running something locally. A cron'd `curl` against the admin endpoint is enough.
