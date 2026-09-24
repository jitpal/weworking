# Self-hosting weworking

The long version of the README quick start, with troubleshooting. One deployment serves one WeWork account, yours.

Before you start, re-read the disclaimer in the [README](../README.md). This software spends your credits and may violate WeWork's terms of service.

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

## 2. Make your copy of the config

The OAuth provider stores clients, grants, and tokens in a KV namespace. There is nothing to create by hand: the committed `wrangler.jsonc` binds `OAUTH_KV` without an `id`, so the first `npm run deploy` creates the namespace (wrangler may ask whether to create a new one or reuse one; create a new one) and records its id in the config it deployed with. The Deploy to Cloudflare button does the same.

Copy `wrangler.jsonc` to `wrangler.local.jsonc` before that first deploy. The local file is gitignored, and `npm run dev`, `npm run deploy`, and `npm run types` all use it when it exists, so the id lands in your copy, the committed config stays untouched, and your fork stays mergeable:

```sh
cp wrangler.jsonc wrangler.local.jsonc
```

Put anything else specific to your deployment there too: a custom domain (`routes` plus `PUBLIC_BASE_URL`) or different caps. To reuse a namespace you already have, add its id yourself:

```jsonc
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "your-namespace-id" }
]
```

The Durable Object binding (`SESSION` / `WeWorkSession`) needs no setup either; the `new_sqlite_classes` migration creates it on first deploy.

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
npx wrangler secret put WEWORK_USERNAME  # only if you want automatic login
npx wrangler secret put WEWORK_PASSWORD
```

| Secret | Purpose | Notes |
| --- | --- | --- |
| `ADMIN_PASSWORD` | gates `/admin/*` and the OAuth approval screen | the only thing between the internet and your session store; make it long |
| `QUOTE_SIGNING_KEY` | HMAC-SHA-256 key for booking quotes | rotating it invalidates outstanding quotes (harmless) |
| `COOKIE_SIGNING_KEY` | signs the admin session cookie | rotating it logs you out of `/admin` |
| `WEWORK_USERNAME` / `WEWORK_PASSWORD` | automatic Auth0 login | often blocked from datacenter IPs; impossible with MFA |

For local development put the same names in `.dev.vars` (copy `.dev.vars.example`). Never commit it.

### Vars

Plain values in `wrangler.jsonc` under `vars`. Edit and redeploy to change them.

| Var | Default | Effect |
| --- | --- | --- |
| `WRITE_ENABLED` | `"true"` | `"false"` rejects every write with `WRITE_DISABLED` |
| `MAX_BOOKINGS_PER_DAY` | `"1"` | enforced in the Durable Object ledger |
| `MAX_BOOKINGS_PER_WEEK` | `"7"` | same |
| `MAX_CREDITS_PER_BOOKING` | `"0"` | `0` allows only bookings that cost no credits, which is every desk included in an All Access plan; a number caps credits per booking; `"unlimited"` removes the cap |
| `MAX_CASH_PER_BOOKING` | `"0"` | `0` refuses every booking with a cash price, which is what a pay-as-you-go desk has; a number (decimals allowed) caps the quoted total in the building's own currency; `"unlimited"` removes the cap |
| `LOGIN_STRATEGY` | `"auto"` | `auto` tries refresh then headless login; `headless` forces login attempts; `manual` never logs in, so only a pasted session works |
| `PUBLIC_BASE_URL` | `""` | set to your canonical origin if you use a custom domain, so OAuth metadata and error hints use it |

## 4. Deploy

Deployment is manual and runs from your machine. There is no continuous integration or deploy automation in this repo, and it never needs `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` stored in GitHub; `npm run deploy` uses the wrangler login from step 1 and your `wrangler.local.jsonc`.

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

## 6. Mint an API key (optional)

An agent that can send a header does not need the OAuth flow. Open `https://<your-worker>.workers.dev/admin/keys`, sign in with `ADMIN_PASSWORD`, name the key, tick its scopes and press Create key.

The key looks like `ww_` followed by 43 characters and is sent as a plain bearer header:

```
Authorization: Bearer ww_<your-key>
```

The page shows it once, with the Claude Code, Cursor and curl lines already filled in. Copy it then: the worker keeps only its SHA-256, so it cannot be shown again. Lose it and you mint a new one.

Tick `read` only for anything that should never spend credits. `write` adds booking and cancelling, within the caps. `admin` grants nothing beyond `write` today: these pages need the admin password in a browser, not a key.

Press Revoke on the same page to retire a key. It stops working on the next request.

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
    "cookieKey": true
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
| `secrets.*` | presence only. `adminPassword` or `quoteKey` false means you skipped a required secret |
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

Quotes live ten minutes. Expired means search again and book with the fresh quote. Invalid means the signature did not verify: a mangled copy/paste, a quote from another deployment, or `QUOTE_SIGNING_KEY` changed since it was issued.

### `CAP_EXCEEDED`

The daily or weekly cap, or `MAX_CREDITS_PER_BOOKING`, or `MAX_CASH_PER_BOOKING`, would be exceeded. The error states which. Raise the relevant var in `wrangler.jsonc` and redeploy if that is what you want. Cancelling a booking does not give its day or week slot back: the counters record bookings made, so that an agent cannot cancel and rebook its way around them.

### Deploy fails on the Durable Object migration

If you renamed the class or removed the `new_sqlite_classes` migration, wrangler refuses. Keep the existing migration entries and append new ones; never rewrite history there, or you lose the stored session.

### Rotating credentials

- **API key.** Mint the replacement at `/admin/keys`, paste it into the client, then revoke the old one on the same page. Revocation takes effect on the next request; there is no cache to clear and no redeploy.
- **`QUOTE_SIGNING_KEY`.** `wrangler secret put QUOTE_SIGNING_KEY` with a new `openssl rand -hex 32`. Outstanding quotes become `QUOTE_INVALID`; clients just search again.
- **`COOKIE_SIGNING_KEY`.** Same; existing admin cookies stop working and you sign in to `/admin` again.
- **`ADMIN_PASSWORD`.** Put a new value. Every live admin session ends there and then: the `ww_admin` cookie carries a short digest of the password it was minted under, and is refused once that digest stops matching. So rotating the password is enough on its own, and you do not have to rotate `COOKIE_SIGNING_KEY` as well to kick out a copied cookie.
- **WeWork session.** Sign out on `members.wework.com` (this invalidates the refresh token), then paste a fresh session at `/admin/connect`. Clearing the stored session from the admin page removes it from the Durable Object but does not revoke it upstream. Do both.

### Revoking a client

- **OAuth client.** Grants and tokens live in `OAUTH_KV`. List and delete the keys belonging to that client:

  ```sh
  npx wrangler kv key list --binding OAUTH_KV
  npx wrangler kv key delete --binding OAUTH_KV "<key>"
  ```

  Deleting the grant immediately invalidates its access and refresh tokens. To revoke everything at once, delete all keys in the namespace (or delete and recreate the namespace). Every client then has to re-authorise.
- **API key.** Press Revoke next to it at `/admin/keys`.
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
