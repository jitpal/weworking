# Threat model

What this software protects, from whom, and what it does not protect. Read this before deploying, and before reporting a vulnerability ([SECURITY.md](../SECURITY.md)).

Scope: one Worker deployment, in the deployer's own Cloudflare account, serving one WeWork account. There is no hosted multi-tenant instance and the design assumes there never will be.

## Assets

| Asset | Where it lives | Worst case if lost |
| --- | --- | --- |
| WeWork username and password | optional secrets `WEWORK_USERNAME` / `WEWORK_PASSWORD` in Cloudflare | full takeover of the WeWork account: bookings, profile, whatever WeWork exposes. Not limited to this tool |
| Auth0 access token (~12h) | `WeWorkSession` Durable Object SQLite | full WeWork API access as the user until it expires |
| Auth0 refresh token | same | renewable API access until revoked by signing out on `members.wework.com` or changing the password |
| `ADMIN_PASSWORD` | Cloudflare secret | can approve OAuth clients, replace the stored session, read the audit log — i.e. bootstrap full access to the deployment |
| `QUOTE_SIGNING_KEY` | Cloudflare secret | lets an attacker forge booking quotes, bypassing the "search first" guarantee. Still subject to scopes, caps, and the kill switch |
| `COOKIE_SIGNING_KEY` | Cloudflare secret | forge an admin session cookie |
| Static bearer tokens | plaintext only in client configs; SHA-256 in `AUTH_TOKENS` | see [per-scope capability](#what-a-leaked-worker-token-can-do) below |
| OAuth access/refresh tokens and grants | `OAUTH_KV` | same as a static token of the granted scopes |
| WeWork credits | WeWork's side | money. A monthly allowance, spendable by anything with `write` |
| Booking history and home location | Durable Object ledger and audit log, plus upstream | discloses where the user works and when they are there |

Credits and physical-presence data are the reason this is worth protecting at all. A compromise is not just data loss; it spends money and reveals a schedule.

## Trust boundaries

```
[ model / LLM ]  <- sees tool results only, never credentials
      |
      | tool call, carrying a Worker credential held by the client runtime
      v
[ MCP client / agent host ]  -- trusted with a Worker token, not with WeWork credentials
      |
      |  HTTPS, OAuth 2.1 or Bearer
      v
================== boundary 1: the Worker's front door ======================
[ Worker: guard -> scopes -> WRITE_ENABLED -> quote verify -> caps -> audit ]
      |
      |  Durable Object RPC (inside the deployer's Cloudflare account)
      v
================== boundary 2: the session store ===========================
[ WeWorkSession DO: access token, refresh token, idempotency, caps, audit ]
      |
      |  HTTPS with Authorization: Bearer <WeWork access token>
      v
================== boundary 3: WeWork / Auth0 ==============================
[ members.wework.com, idp.wework.com ]  -- not under our control, undocumented
```

1. **Front door.** Everything reaching `/mcp`, `/api/*`, or `/admin/*` is untrusted until the guard resolves an `Actor { kind, name, scopes, accountId }`. No anonymous path exists except `/healthz`, `/api/openapi.json`, and the OAuth endpoints.
2. **Session store.** Only the Worker can talk to the Durable Object, and the DO's only exposed operations are "give me a usable token for an upstream call" plus session/cap/audit bookkeeping. No RPC method returns a token to a client-facing response path.
3. **WeWork.** Treated as hostile-by-accident: responses are parsed defensively, HTTP 200 is not taken as success (`BookingStatus` is checked), and nothing from upstream is interpolated into HTML without escaping.

The agent host (Claude Code, Cursor, claude.ai) sits outside boundary 1. It is trusted with a scoped Worker credential and nothing more.

## What a leaked Worker token can do

| Scope | Can | Cannot |
| --- | --- | --- |
| `read` | see profile, email, credit balance, home location, every booking, search availability, issue quotes | book, cancel, change the session, read the audit log |
| `write` | everything `read` can, plus book and cancel within `MAX_BOOKINGS_PER_DAY`, `MAX_BOOKINGS_PER_WEEK`, `MAX_CREDITS_PER_BOOKING`, only from a valid signed quote, only while `WRITE_ENABLED="true"` | exceed the caps, book without a fresh quote, retrieve the WeWork token, read or alter the stored session |
| `admin` | everything above, plus read the audit log, inspect session status, and **replace the stored session** | read back the stored access or refresh token (they are write-only from the outside) |

So the blast radius of a leaked `write` token is bounded in money by the caps: at the defaults, one booking per day and five per week. That is the point of the caps — they are there for a misbehaving or compromised agent, not only for a user's own convenience. A leaked `admin` token is as bad as the admin password for everything except direct token exfiltration.

No scope can retrieve a WeWork credential. Escalating from any Worker token to the WeWork account itself requires a bug, which is exactly what [SECURITY.md](../SECURITY.md) asks you to report.

## Why tokens never reach the model

An LLM's context is effectively public: it is logged by the host, may be used for training or debugging, and will be summarised, quoted, and occasionally pasted into a bug report by the user. It is also attacker-influenced, because prompt injection from any content the agent reads can make the model emit whatever it holds.

Therefore:

- WeWork access and refresh tokens exist only inside the Durable Object and in the `Authorization` header of outbound upstream requests. No tool output, `structuredContent` field, `summary` string, error `message`, or error `hint` contains one.
- `whoami` reports session **state** (`valid`, `expiring`, `expired`, `none`), not session contents.
- `/healthz` reports presence booleans and counts, never values.
- The admin password and signing keys are never echoed, not even masked.
- All logging goes through `src/redact.ts` (`redact`, `redactHeaders`) which strips `Authorization`, `WeWorkAuth`, `Cookie`, `Set-Cookie`, token-ish fields, and email addresses before anything reaches the Workers log stream.
- The `/admin/connect` paste flow keeps the credential on the boundary: the user pastes it into a browser form over HTTPS, never into a chat window. The `book-a-desk` skill instructs agents to refuse to accept a password or token in conversation and to send the user to the connect page instead.

The Worker credential the client holds is the one secret the agent host legitimately has, and it is held by the client runtime (config file, OS keychain, `~/.mcp-auth`) — not passed through the model's context either.

## Single account per deployment

One deployment, one WeWork account, one Durable Object instance (`session:default`). This is a security decision, not only a simplification:

- There is no tenant-selection parameter, so there is no tenant-confusion bug class and no way for a request to reach another person's session.
- The blast radius of any compromise is one account, owned by whoever deployed it.
- Credentials are provided by the person who owns them, to infrastructure they control and pay for. Nobody is asked to hand WeWork credentials to a third party's host.
- Caps, the audit log, and the kill switch are all meaningful because a single human owns the whole deployment.

Running this as a shared service for other people's WeWork accounts is outside the threat model, would concentrate many accounts' credentials in one place, and is asking for trouble with WeWork. Do not.

**The `accountId` seam.** `Actor.accountId` and `QuotePayload.accountId` exist and are always `"default"` in phase 1. Quote verification requires the quote's `accountId` to equal the actor's, so a quote issued under one identity can never be spent under another. The seam exists so a future multi-account version would have to route the Durable Object name, the cap ledger, and the quote audience together; if that ever happens, every one of those must move at once. Until then the constraint is enforced, not just documented.

## Logging and redaction policy

- **Never logged:** WeWork access or refresh tokens, `Authorization` / `WeWorkAuth` header values, cookies, `ADMIN_PASSWORD`, signing keys, bearer token plaintext, Auth0 `login_ticket`, `code`, `code_verifier`, or password form bodies.
- **Logged at error level:** error code, upstream status, route, elapsed time, and a redacted summary of the upstream error envelope (`responseStatus.type` / `title`).
- **The audit log** (`audit` table in the Durable Object) records timestamp, actor name and kind, tool, redacted arguments, outcome, booking id, credits, and the dry-run flag. Arguments pass through `redact()`, so a quote is stored as a fingerprint rather than the signed blob, and free-text notes are truncated.
- **`WeWorkUUID`** and the user's email are treated as personal data: they appear in `whoami` output (the user asked) but are redacted from logs.
- Cloudflare retains Worker logs per your own account settings; the audit log lives in the DO until pruned by the daily cron. Both are visible to anyone with access to your Cloudflare account, which is one more reason to keep that account locked down with a hardware key.

## Residual risks (accepted)

- **Auth0 bot detection.** Automatic login from datacenter IPs is routinely challenged (`UPSTREAM_BLOCKED`). Not fixable from a Worker; the mitigation is the manual connect page. Repeated failed attempts could plausibly draw attention to the account, which is why `LOGIN_STRATEGY="manual"` exists.
- **No MFA support in automatic login.** MFA accounts must use `/admin/connect`. This is a feature, not only a limitation: it keeps the second factor with the human.
- **API churn.** Undocumented endpoints change without notice (parameters were renamed in August 2026). A silent shape change could in principle produce a wrong booking rather than an error; `dry_run` and the `BookingStatus` check reduce but do not eliminate this.
- **Terms of service.** Automating an account may breach WeWork's terms or an employer's agreement. WeWork could suspend the account. Nothing technical mitigates this; it is the deployer's decision and the disclaimer is prominent for that reason.
- **Cloudflare as a dependency.** Secrets, the Durable Object, and KV are all visible to a compromised Cloudflare account. Protect it accordingly.
- **Agent host compromise.** A malicious or prompt-injected agent with a `write` token can book a desk you did not want, up to the caps. Mitigations: `read`-only tokens by default, low caps, the audit log, and `dry_run` when the user asks what would happen.
- **`ADMIN_PASSWORD` is a single factor.** It gates the OAuth approval screen and `/admin/*`. Choose a long random value; there is no rate limiting beyond Cloudflare's own, and no second factor.
- **Upstream data in the UI.** Building names and addresses come from WeWork and are rendered on the admin pages; they are escaped, but a novel injection path there is a plausible bug class.
