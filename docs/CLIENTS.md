# Connecting clients

Your deployment exposes one MCP endpoint and one REST API:

- MCP (Streamable HTTP): `https://<your-worker>.workers.dev/mcp`
- REST: `https://<your-worker>.workers.dev/api/*`

Both accept two kinds of credential:

- **OAuth 2.1**: the client discovers the authorisation server from a 401 on `/mcp`, registers itself, opens a browser, and you approve in the browser. Required for hosted clients (claude.ai, ChatGPT) that cannot be given a header.
- **API key**: `Authorization: Bearer ww_<your-key>`, a plain bearer header and nothing else. Simpler for local clients and for scripts. Mint one at `https://<your-worker>.workers.dev/admin/keys`: name it, tick its scopes, and copy it off the page it is shown on. Only its SHA-256 is stored, so it is shown that once.

Both are signed off by the same person in the same browser: `/admin/keys` and the OAuth approval screen share one sign-in with `ADMIN_PASSWORD`.

Use a `read`-only key for anything that should never spend credits. `admin` grants nothing beyond `write` today: the operator pages need the admin password, not a key.

## Claude Code

OAuth (a browser window opens on first use):

```sh
claude mcp add --transport http weworking https://<your-worker>.workers.dev/mcp
```

API key:

```sh
claude mcp add --transport http weworking https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer ww_<your-key>"
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

API key:

```json
{
  "mcpServers": {
    "weworking": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<your-worker>.workers.dev/mcp",
        "--header", "Authorization: Bearer ww_<your-key>"
      ]
    }
  }
}
```

Restart Claude Desktop after editing. If OAuth gets stuck, delete `~/.mcp-auth` and restart.

## claude.ai (custom connector), OAuth only

Settings > Connectors > Add custom connector. Paste `https://<your-worker>.workers.dev/mcp` and save. Claude registers itself dynamically, sends you to the approval screen, and you sign in with `ADMIN_PASSWORD` and approve the requested scopes.

There is no way to attach a custom header, so an API key will not work here. The same applies to the Claude mobile and desktop apps when they use connectors rather than a local config.

## ChatGPT (developer mode), OAuth only

Settings > Connectors > Advanced > developer mode, then add an MCP server with URL `https://<your-worker>.workers.dev/mcp` and authentication set to OAuth. Approve with `ADMIN_PASSWORD` when the browser opens.

ChatGPT will not send a custom header either. OAuth only.

## Cursor

`~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` inside one project.

API key:

```json
{
  "mcpServers": {
    "weworking": {
      "url": "https://<your-worker>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ww_<your-key>" }
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

Anything that supports remote MCP over Streamable HTTP works. Give it the `/mcp` URL and either let it do OAuth or set an `Authorization: Bearer ww_<your-key>` header. In VS Code that is an `mcp.json` entry of `"type": "http"` with a `headers` object, the same shape as Cursor.

## OpenAI Agents SDK (Python)

API key:

```python
import asyncio
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

async def main() -> None:
    async with MCPServerStreamableHttp(
        name="weworking",
        params={
            "url": "https://<your-worker>.workers.dev/mcp",
            "headers": {"Authorization": "Bearer ww_<your-key>"},
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
TOKEN=ww_<your-key>

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
| 401 with `WWW-Authenticate: Bearer resource_metadata=...` | no credential, or a bad one. An MCP client should follow that header into the OAuth flow; if yours does not, use an API key |
| 401 with a correct-looking key | the key was revoked, or it was never copied whole. Check the list at `/admin/keys` and mint a new one |
| `FORBIDDEN_SCOPE` | the credential lacks `write`. Mint a new key with the right scopes |
| `WRITE_DISABLED` | `WRITE_ENABLED` is `"false"` on the deployment |
| Tools list but every call returns `SESSION_MISSING` | WeWork is not connected. Open `/admin/connect` |
| claude.ai or ChatGPT cannot connect | they are OAuth-only; make sure `OAUTH_KV` has a real namespace id and `ADMIN_PASSWORD` is set |
