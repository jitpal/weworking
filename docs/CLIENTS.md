# Connecting clients

Your deployment exposes one MCP endpoint and one REST API:

- MCP (Streamable HTTP): `https://<your-worker>.workers.dev/mcp`
- REST: `https://<your-worker>.workers.dev/api/*`

Both accept two kinds of credential:

- **OAuth 2.1**: the client discovers the authorisation server from a 401 on `/mcp`, registers itself, opens a browser, and you approve with `ADMIN_PASSWORD`. Required for hosted clients (claude.ai, ChatGPT) that cannot be given a header.
- **Static bearer token**: `Authorization: Bearer <token>`, matched by SHA-256 against `AUTH_TOKENS`. Simpler for local clients and for scripts. Create one with `node scripts/hash-token.mjs --name <client> --scopes read,write`.

Use a `read`-only token for anything that should never spend credits.

## Claude Code

OAuth (a browser window opens on first use):

```sh
claude mcp add --transport http weworking https://<your-worker>.workers.dev/mcp
```

Static token:

```sh
claude mcp add --transport http weworking https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

Then:

```sh
claude mcp list
```

In a session, `/mcp` shows the connection state and lets you re-run the OAuth flow.

## Claude Desktop

Claude Desktop speaks stdio, so bridge it with `mcp-remote`. Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`).

OAuth: `mcp-remote` opens a browser and caches the tokens under `~/.mcp-auth`:

```json
{
  "mcpServers": {
    "weworking": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-worker>.workers.dev/mcp"]
    }
  }
}
```

Static token:

```json
{
  "mcpServers": {
    "weworking": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<your-worker>.workers.dev/mcp",
        "--header", "Authorization: Bearer <token>"
      ]
    }
  }
}
```

Restart Claude Desktop after editing. If OAuth gets stuck, delete `~/.mcp-auth` and restart.

## claude.ai (custom connector), OAuth only

Settings > Connectors > Add custom connector. Paste `https://<your-worker>.workers.dev/mcp` and save. Claude registers itself dynamically, sends you to the approval screen, and you sign in with `ADMIN_PASSWORD` and approve the requested scopes.

There is no way to attach a custom header, so a static token will not work here. The same applies to the Claude mobile and desktop apps when they use connectors rather than a local config.

## ChatGPT (developer mode), OAuth only

Settings > Connectors > Advanced > developer mode, then add an MCP server with URL `https://<your-worker>.workers.dev/mcp` and authentication set to OAuth. Approve with `ADMIN_PASSWORD` when the browser opens.

ChatGPT will not send a custom header either. OAuth only.

## Cursor

`~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` inside one project.

Static token:

```json
{
  "mcpServers": {
    "weworking": {
      "url": "https://<your-worker>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

OAuth: omit `headers` and Cursor runs the flow itself:

```json
{
  "mcpServers": {
    "weworking": { "url": "https://<your-worker>.workers.dev/mcp" }
  }
}
```

## VS Code / other MCP clients

Anything that supports remote MCP over Streamable HTTP works. Give it the `/mcp` URL and either let it do OAuth or set an `Authorization: Bearer <token>` header. In VS Code that is an `mcp.json` entry of `"type": "http"` with a `headers` object, the same shape as Cursor.

## OpenAI Agents SDK (Python)

Static token:

```python
import asyncio
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

async def main() -> None:
    async with MCPServerStreamableHttp(
        name="weworking",
        params={
            "url": "https://<your-worker>.workers.dev/mcp",
            "headers": {"Authorization": "Bearer <token>"},
        },
        cache_tools_list=True,
    ) as server:
        agent = Agent(
            name="Desk booker",
            instructions=(
                "You book WeWork hot desks. Always search first, show the user the "
                "credit cost and local times, and get an explicit yes before booking."
            ),
            mcp_servers=[server],
        )
        result = await Runner.run(agent, "Find me a desk in London next Tuesday morning.")
        print(result.final_output)

asyncio.run(main())
```

Use a `read`-scoped token while you are developing, so a confused agent cannot spend credits. There is no OAuth helper here; supply a header.

## Agent plugin

The repo ships an Agent Plugin in [`plugin/`](../plugin) with a `book-a-desk` skill that encodes the confirm-before-booking workflow. Edit `plugin/mcp.json` and replace `https://REPLACE_ME.workers.dev/mcp` with your Worker URL before installing it.

## Plain curl

Reads:

```sh
BASE=https://<your-worker>.workers.dev
TOKEN=<token>

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/whoami" | jq
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/locations?city=London" | jq
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/availability?city=London&date=2026-09-21&start_time=09:00&end_time=17:00" | jq
```

A write, dry run first (`quote` comes from an availability result):

```sh
curl -s -X POST "$BASE/api/bookings" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"quote":"<quote>","dry_run":true}' | jq
```

Then for real, with an idempotency key so a retry cannot double-book:

```sh
curl -s -X POST "$BASE/api/bookings" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"quote":"<quote>","idempotency_key":"'"$(uuidgen)"'"}' | jq
```

Cancel:

```sh
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/bookings/<bookingId>" | jq
```

The OpenAPI document is public at `$BASE/api/openapi.json`, so you can point any OpenAPI-aware tool at it.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| 401 with `WWW-Authenticate: Bearer resource_metadata=...` | no credential, or a bad one. An MCP client should follow that header into the OAuth flow; if yours does not, use a static token |
| 401 with a correct-looking token | the token is not in `AUTH_TOKENS`, or the secret is malformed JSON. Check `secrets.authTokens` in `/healthz` |
| `FORBIDDEN_SCOPE` | the credential lacks `write` (or `admin`). Issue a new token with the right scopes |
| `WRITE_DISABLED` | `WRITE_ENABLED` is `"false"` on the deployment |
| Tools list but every call returns `SESSION_MISSING` | WeWork is not connected. Open `/admin/connect` |
| claude.ai or ChatGPT cannot connect | they are OAuth-only; make sure `OAUTH_KV` has a real namespace id and `ADMIN_PASSWORD` is set |
