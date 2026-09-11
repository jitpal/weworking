/**
 * weworking — Worker entry point.
 *
 * Unofficial WeWork hot-desk search and booking for AI agents. Not affiliated with
 * or endorsed by WeWork; it drives the same private member API the WeWork web app
 * uses, with your own credentials, from your own deployment.
 *
 * ## Composition order (the front door)
 *
 * Requests land here in this order, and each mount point below is owned by a
 * different module:
 *
 *   1. `GET /healthz` — public, no secrets. Implemented inline below so it keeps
 *      working even when configuration is broken.
 *   2. OAuth endpoints (`/oauth/authorize`, `/oauth/token`, `/oauth/register`,
 *      `/.well-known/*`) — served by `@cloudflare/workers-oauth-provider`, which
 *      wraps this Hono app. See `src/auth/oauth.ts`.
 *   3. `/mcp` — the stateless MCP endpoint (`createMcpHandler` from
 *      `agents/mcp/server`). Protected. See `src/mcp/server.ts`.
 *   4. `/api/*` — the REST mirror plus `/api/openapi.json`. Protected.
 *      See `src/http/api.ts`.
 *   5. `/admin/*` — the connect page, status and audit log, behind the admin
 *      cookie or an `admin`-scoped token. See `src/http/admin.ts`.
 *
 * STATUS: scaffold. Only `/healthz` and the 404 handler are implemented. The
 * numbered `TODO(owner)` comments mark exactly where each module mounts; add the
 * import and the mount line and change nothing else in this file.
 */

import { Hono } from "hono";
import { type Env, parseConfig, VERSION } from "./env";
import { statusFor, toErrorBody } from "./errors";
import { getSessionStub } from "./session/do";

const app = new Hono<{ Bindings: Env }>();

/**
 * Public liveness and configuration probe. Reports *presence* booleans only —
 * never a secret, never a token, never the session itself beyond its state.
 *
 * The full shape (secrets, session, writeEnabled) lands with `src/http/health.ts`;
 * this inline version is the minimum that proves the worker is up.
 */
app.get("/healthz", (c) => {
  return c.json({ ok: true, version: VERSION });
});

// TODO(oauth engineer): mount the OAuth authorize/approve + admin login handlers,
// then wrap this app with `new OAuthProvider({ apiRoute: ["/mcp", "/api/"], ... })`
// in the default export below. See docs/DESIGN.md §8.

// TODO(mcp engineer): app.all("/mcp", ...) -> createMcpHandler(factory) from
// "agents/mcp/server", with the Actor resolved by src/auth/guard.ts and passed
// through the handler's `authContext.props`. See docs/DEPENDENCY_NOTES.md.

// TODO(http engineer): app.route("/api", apiRoutes) and GET /api/openapi.json (public).

// TODO(http engineer): app.route("/admin", adminRoutes).

/** Uniform error envelope: `{ error: { code, message, hint } }` for every failure. */
app.onError((err, c) => {
  return c.json(toErrorBody(err), statusFor(err) as 400);
});

app.notFound((c) => {
  return c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}.`,
        hint: "The MCP endpoint is POST /mcp; the REST API lives under /api. See /api/openapi.json.",
      },
    },
    404,
  );
});

/**
 * Daily maintenance (cron `17 5 * * *`): refresh the WeWork token while it is still
 * valid, and prune expired idempotency rows and old audit entries.
 *
 * STATUS: scaffold. `src/session/cron.ts` will own the body; this wiring stays.
 */
async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // Fail loudly in logs but never throw: a throwing cron handler is retried and
  // would hammer Auth0.
  try {
    parseConfig(env);
    // TODO(session engineer): await getSessionStub(env).maintain();
    void getSessionStub;
  } catch (err) {
    console.error("scheduled: maintenance failed", toErrorBody(err));
  }
}

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;

/** The Durable Object class must be exported from the entry point for the binding to resolve. */
export { WeWorkSession } from "./session/do";
