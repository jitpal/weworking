# Contributing

Thanks for helping. This is a small, unofficial project that talks to undocumented endpoints, so the most valuable contributions are usually (a) fixes when WeWork changes something and (b) redacted captures of requests we do not support yet.

## Dev setup

Node 22 and npm.

```sh
git clone https://github.com/<you>/weworking.git
cd weworking
npm install
cp .dev.vars.example .dev.vars   # fill in what you need
npm run dev                      # wrangler dev on http://localhost:8787
```

You do not need a WeWork account to work on most of the codebase. The test suite runs entirely off fixtures.

## Before you open a PR

```sh
npm run check
```

That is `biome check .` + `tsc --noEmit` + `vitest run`. Also run the deploy smoke check if you touched bindings or `wrangler.jsonc`:

```sh
npx wrangler deploy --dry-run --outdir dist
```

GitHub Actions runs exactly those two commands (`.github/workflows/ci.yml`), on pull requests and on pushes to `main`, using the Node version in `.nvmrc`. It needs no secrets and it never deploys. Nothing else runs in CI, so a green check means your branch passes the same checks you just ran locally.

## Tests never hit the network

Every upstream response used in tests lives in `test/fixtures/wework/*.json` and is served through the fetch stub in `test/helpers/fake-fetch.ts`. If a test needs the network, it is the wrong test. Durable Object behaviour is tested through `env.SESSION` with `@cloudflare/vitest-pool-workers`; end-to-end `/mcp` behaviour through `SELF.fetch`.

## Adding a fixture

`scripts/record-fixture.mjs` records a real response from `members.wework.com`. It is **manual and live**: it is never run in CI, it needs a real session token in `WEWORK_TOKEN`, and it costs you nothing only as long as you stick to read endpoints.

```sh
export WEWORK_TOKEN="<access token from members.wework.com>"
node scripts/record-fixture.mjs --name get-spaces-london \
  --path "/spaces/get-spaces?locationUUIDs=<uuid>&date=2026-09-21&duration=30&locationOffset=%2B01:00&type=0&capacity=0&offset=0&limit=50&isWeb=true"
```

The script redacts as it writes, but **you are responsible for checking the result before committing it**:

- no `Authorization`, `WeWorkAuth`, or cookie values
- no email addresses, real names, phone numbers, or employer names
- account, user and membership UUIDs replaced (`--redact-uuids` rewrites them consistently so references still line up)
- building names and addresses are fine to keep; they are public

Open the file and read it. Fixtures are committed forever and git history is not a safe place to discover a leak.

Do not record write endpoints (`/common-booking/` POST, `/common-booking/cancel`) against your real account unless you intend to pay for it; if you do capture one, hand-trim it hard.

## Never commit real tokens

No exceptions. `.dev.vars`, `.wrangler/`, and `dist/` are gitignored. Keep it that way. Secrets go in `wrangler secret put`, placeholders go in `.dev.vars.example`. If you do leak one: rotate it at the source first (re-login on `members.wework.com` to invalidate, or `wrangler secret put` a new value), then worry about the history.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Scope is the area, usually a directory:

```
feat(mcp): add space_type filter to search_availability
fix(wework): handle renamed inventory-details params
docs(clients): add OpenAI Agents SDK snippet
test(session): cover weekly cap rollover
chore(deps): bump wrangler to 4.131.2
```

`feat!:` or a `BREAKING CHANGE:` footer for anything that changes a tool schema, an error code, or a binding.

## PR expectations

- One logical change per PR. Endpoint fixes and refactors should not arrive together.
- `npm run check` passes, and new behaviour comes with a test.
- If you changed a tool schema, a REST shape, or an error code, update `docs/API.md` in the same PR.
- If you changed deployment requirements (a new secret, binding, or var), update `README.md` and `docs/SELF_HOSTING.md`.
- Say how you verified it. "Tested against my real account on 2026-09-20, booked and cancelled one desk in London" is exactly the right level of detail.
- Keep the unofficial framing intact. No claims of WeWork endorsement, no baked-in credentials, no shared hosted instance.
