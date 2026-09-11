# Test fixtures

Scrubbed upstream responses, used by the unit tests so nothing ever touches the real
WeWork API.

- `wework/*.json` — real response bodies with every token, cookie, email, name, user
  UUID and precise coordinate replaced. Record them with
  `node scripts/record-fixture.mjs` (which redacts on the way out), then read the file
  before committing it.
- Never commit a fixture you have not eyeballed. A WeWork response can carry
  `access_token`, `Set-Cookie`, the member's email and their home address.
