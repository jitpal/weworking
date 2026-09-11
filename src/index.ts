/**
 * weworking, Worker entry point.
 *
 * Unofficial WeWork hot-desk search and booking for AI agents. Not affiliated with
 * or endorsed by WeWork; it drives the same private member API the WeWork web app
 * uses, with your own credentials, from your own deployment.
 *
 * Request flow:
 *
 *   1. `OAuthProvider` (workers-oauth-provider) wraps the app. It serves the OAuth
 *      token/registration/metadata endpoints itself, validates bearer tokens on
 *      `/mcp` and `/api/*` (OAuth grants and, via `resolveExternalToken`, the API
 *      keys minted at `/admin/keys`), and puts the grant's props on `ctx.props`.
 *   2. Everything else lands in the Hono app: landing page, `/healthz`, the OAuth
 *      approval form, `/admin/*`, `/api/openapi.json`.
 *   3. `/mcp` and `/api/*` resolve an `Actor` from `ctx.props` or the raw header,
 *      build a per-request booking service, and dispatch.
 */

import { Hono } from "hono";
import { adminRoutes } from "./auth/admin-session";
import { actorMiddleware, baseUrlFrom, resolveActor, unauthorizedResponse } from "./auth/guard";
import { createOAuthProvider, landingRoutes, oauthRoutes } from "./auth/oauth";
import { createBookingService } from "./core/booking-service";
import type { Actor } from "./core/types";
import { baseUrl, type Env, parseConfig } from "./env";
import { statusFor, toErrorBody } from "./errors";
import { adminPages } from "./http/admin";
import { apiRoutes } from "./http/api";
import { healthRoutes } from "./http/health";
import { openapiRoutes } from "./http/openapi";
import { mountMcp } from "./mcp/server";
import { runScheduled } from "./session/cron";
import { getSessionStub } from "./session/do";
import { DurableTokenStore } from "./session/token-store";
import { WeWorkClient } from "./wework/client";

type AppEnv = { Bindings: Env; Variables: { actor?: Actor } };

/** One booking service per request: config is re-read so secret changes apply immediately. */
function buildService(env: Env, actor: Actor, req: Request) {
  const config = parseConfig(env);
  const session = getSessionStub(env, actor.accountId);
  const api = new WeWorkClient({
    fetch: globalThis.fetch.bind(globalThis),
    tokens: new DurableTokenStore(session),
    locationStore: {
      get: (id) => session.getLocation(id),
      put: (locations) => session.rememberLocations(locations),
    },
  });
  return createBookingService({
    api,
    session,
    config,
    quoteKey: config.quoteSigningKey,
    baseUrl: baseUrl(config, req),
    accountId: actor.accountId,
  });
}

const app = new Hono<AppEnv>();

/* Public */
app.route("/", healthRoutes({ getSessionInfo: (env) => getSessionStub(env).getSessionInfo() }));
app.route("/api", openapiRoutes());
app.route("/", landingRoutes());

/* OAuth approval form and admin pages (the admin cookie, from ADMIN_PASSWORD) */
app.route("/", oauthRoutes());
app.route("/", adminRoutes());
app.route("/", adminPages());

/* Protected agent surfaces */
mountMcp(app, {
  resolveActor,
  buildService,
  unauthorized: (req, env) => unauthorizedResponse(baseUrlFrom(req, env)),
});
app.use("/api/*", actorMiddleware());
app.route("/api", apiRoutes({ buildService }));

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

const handler = { fetch: app.fetch } satisfies ExportedHandler<Env>;
const provider = createOAuthProvider({ apiHandler: handler, defaultHandler: handler });

/** Routes the provider protects but that must stay public. */
const PUBLIC_UNDER_API = new Set(["/api/openapi.json", "/api/docs"]);

/** Daily maintenance (cron `17 5 * * *`). Never throws: a throwing cron is retried. */
async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  try {
    await runScheduled(env);
  } catch (err) {
    console.error("scheduled: maintenance failed", toErrorBody(err));
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (PUBLIC_UNDER_API.has(new URL(request.url).pathname)) {
      return app.fetch(request, env, ctx);
    }
    return provider.fetch(request, env as unknown as Cloudflare.Env, ctx);
  },
  scheduled,
} satisfies ExportedHandler<Env>;

/** The Durable Object class must be exported from the entry point for the binding to resolve. */
export { WeWorkSession } from "./session/do";
