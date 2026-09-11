---
name: Bug report
about: Something in weworking does not work as documented
title: "bug: "
labels: bug
---

<!--
Do not paste tokens, passwords, cookies, or an unredacted HAR file.
An access token from members.wework.com is live for ~12 hours and is enough to book on your account.
-->

## What happened

## What you expected

## Steps to reproduce

1.
2.
3.

## Error code

<!-- The `error.code` from the response, e.g. QUOTE_EXPIRED. See docs/API.md. -->

## Error envelope (redacted)

```json
{ "error": { "code": "", "message": "", "hint": "" } }
```

## /healthz output

<!-- curl -s https://<your-worker>.workers.dev/healthz
     This contains no secret values. Paste it as-is. -->

```json

```

## Environment

- weworking version / commit:
- Deployed to Cloudflare, or `npm run dev` locally:
- Client (Claude Code / Claude Desktop / claude.ai / ChatGPT / Cursor / curl / other):
- Auth (OAuth or static bearer token), and the token's scopes:
- Session source (`login` or `manual`, from /healthz):
- Node version (`node -v`) if this is a local or tooling issue:
- Relevant vars if not default (`WRITE_ENABLED`, caps, `LOGIN_STRATEGY`):

## Logs (redacted)

<!-- npx wrangler tail, with anything token-shaped removed. -->

```

```
