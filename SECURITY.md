# Security policy

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting: open the repository's **Security** tab > **Report a vulnerability**. That creates a private advisory visible only to you and the maintainers.

Do not open a public issue, and do not include real tokens, passwords, or unredacted HAR files in the report. A description of the request and the observed response is enough.

Please include: what you did, what happened, what you expected, and the affected version or commit. If you have a proof of concept, describe it rather than attaching credentials.

Expect an acknowledgement within a few days. This is a volunteer project, so there is no paid bounty and no formal SLA. Fixes land on `main` and are noted in the advisory when it is published.

## Threat model

Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) first. It states what this software is trying to protect (WeWork credentials, Auth0 tokens, Worker tokens, your credit balance), where the trust boundaries are, and which risks are accepted rather than mitigated. A report that an accepted risk exists is not a vulnerability; a report that a boundary can be crossed is.

## In scope

- Authentication and authorisation bypass: reaching `/mcp`, `/api/*`, or `/admin/*` without a valid OAuth token, static bearer token, or admin cookie.
- Scope escalation: a `read` credential performing a write, or a non-`admin` credential reading the audit log or replacing the session.
- Quote forgery: getting `create_booking` to accept a quote that was not signed by `QUOTE_SIGNING_KEY`, or replaying an expired one.
- Cap or kill-switch bypass: booking past `MAX_BOOKINGS_PER_DAY` / `MAX_BOOKINGS_PER_WEEK` / `MAX_CREDITS_PER_BOOKING`, or writing while `WRITE_ENABLED="false"`.
- Token leakage: any path where a WeWork access token, refresh token, or the admin password appears in a response body, tool output, error message, log line, or the audit log.
- Idempotency flaws that cause a duplicate charge.
- Admin session cookie forgery, fixation, or CSRF on `/admin/*`.
- Injection through upstream or agent-supplied data into the admin HTML pages.

## Out of scope

- Vulnerabilities in WeWork's own services. Report those to WeWork.
- Anything requiring you to already hold `ADMIN_PASSWORD`, a valid `admin`-scoped token, or access to the deployer's Cloudflare account.
- Auth0 bot detection blocking automatic login. That is a documented limitation.
- WeWork changing or removing an endpoint. Open a normal `api_change` issue.
- Denial of service by spending your own credits or exhausting your own Worker quota.
- Missing hardening with no stated attack path (header nitpicks, version disclosure in `/healthz`).
- Results from a scanner with no demonstrated impact.

## Secrets handling

If you run this, the security of your WeWork account depends on these:

- Secrets live in Cloudflare (`wrangler secret put`) or in local `.dev.vars`, never in the repo. `.dev.vars` is gitignored; `.dev.vars.example` holds placeholders only.
- `AUTH_TOKENS` stores only SHA-256 hashes, compared in constant time. The plaintext token exists once, in your client's config.
- `QUOTE_SIGNING_KEY` and `COOKIE_SIGNING_KEY` should be 32 random bytes (`openssl rand -hex 32`) and should differ from each other.
- WeWork access and refresh tokens are stored only in the `WeWorkSession` Durable Object's SQLite storage, inside your Cloudflare account. They are never returned to a client and never logged; all logging passes through `src/redact.ts`.
- `/healthz` deliberately reports presence booleans and session age only, never values.
- Rotation: re-run `wrangler secret put` for Worker secrets (see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#rotating-tokens)); revoke a WeWork session by signing out on `members.wework.com` and then `POST /admin/session` a fresh one, or clear it from the admin page.
- Revoking an OAuth client deletes its grant from `OAUTH_KV`; revoking a static token means removing its entry from `AUTH_TOKENS` and redeploying the secret.
