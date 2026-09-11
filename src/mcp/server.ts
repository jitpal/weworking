/**
 * The MCP front door: a stateless Streamable HTTP endpoint at `/mcp`.
 *
 * Wiring decisions, all of them forced by how `agents@0.23`'s `createMcpHandler`
 * works (see docs/DEPENDENCY_NOTES.md for the signatures this follows):
 *
 * - **A fresh `McpServer` per request.** The handler is stateless; caching a server in
 *   module scope would leak one request's actor into the next.
 * - **The actor is resolved before the handler runs.** Hono resolves it with
 *   `opts.resolveActor` and a `null` answer short-circuits to `opts.unauthorized`,
 *   which is what sends the `WWW-Authenticate: Bearer resource_metadata=…` challenge
 *   MCP clients need in order to discover OAuth. The handler itself never parses
 *   credentials.
 * - **The actor reaches the tools twice over.** The factory closes over it (how the
 *   tools actually read it), *and* it goes into `authContext.props` so
 *   `getMcpAuthContext()` works for anything else running inside the request.
 * - **`allowedHostnames` is computed per request.** The library only defaults to a
 *   host check for `localhost` and `*.workers.dev`; on a custom domain it performs no
 *   check at all, and passing a list *replaces* the defaults rather than adding to
 *   them. So the list below always contains the request's own hostname (keeping every
 *   deployment working), plus localhost and the `PUBLIC_BASE_URL` hostname, plus
 *   anything the caller adds.
 */

import type { McpServerFactory } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Hono } from "hono";
import type { BookingServiceImpl } from "../core/booking-service";
import type { Actor } from "../core/types";
import { type Env, parseConfig, VERSION } from "../env";
import { statusFor, toErrorBody } from "../errors";
import { registerTools, type ToolContext } from "./tools";

/** The route this server is mounted on. MCP clients are configured with `<base>/mcp`. */
export const MCP_ROUTE = "/mcp";

/** Hostnames the library treats as local; mirrored so our explicit list is a superset. */
const LOCALHOST_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The server `instructions`, sent once at `initialize`.
 *
 * This is where the unofficial-project disclaimer and the usage rules live: a client
 * shows it to the model before any tool is called, so it is the right place for the
 * "search, confirm, then book" discipline that the per-tool descriptions then repeat.
 */
export const MCP_INSTRUCTIONS = [
  "weworking — unofficial WeWork hot-desk search and booking.",
  "",
  "DISCLAIMER: this is an independent, open-source project. It is not affiliated with, endorsed by, or supported by WeWork. It drives the same private member API the WeWork web app uses, with the operator's own WeWork account, from the operator's own deployment. Bookings made here are real bookings on that account and spend that account's real WeWork credits.",
  "",
  "How to use these tools:",
  "1. Call whoami if you do not already know the deployment is connected and what your token may do. If session.state is not 'valid' or 'expiring', stop and tell the user to reconnect at the deployment's /admin/connect page; do not retry in a loop.",
  "2. Resolve the place with list_locations, then call search_availability for the date the user asked about. Never guess a location_id.",
  "3. Read the options back to the user with their credit cost and their LOCAL times, and get explicit confirmation of one specific option before booking. Quotes are short-lived; if the conversation drifts, search again.",
  "4. Call create_booking with that option's quote verbatim and a fresh idempotency_key. It spends real credits. Never book speculatively, never book more than the user agreed to, and never retry a failed booking without telling the user what happened.",
  "5. Report the booking id, the local times, the credits charged and the remaining allowance. Use list_bookings to check, cancel_booking (destructive, usually refundable only before the deadline) to undo.",
  "",
  "Conventions: every date is YYYY-MM-DD and every time is HH:MM, local wall clock at the building, snapped to 30-minute boundaries. Responses also carry true UTC instants, but speak to the user in local time and name the city. 'credits' are WeWork credits, not money. Errors carry a stable 'code' to branch on and a 'hint' that says what to do next — follow the hint instead of improvising, and surface CAP_EXCEEDED, WRITE_DISABLED and FORBIDDEN_SCOPE to the user as deployment limits rather than obstacles to work around.",
].join("\n");

/** The per-request context a factory needs to build a server. */
export type McpServerContext = Parameters<McpServerFactory>[0];

/**
 * Builds an `McpServerFactory`: one `McpServer`, with all six tools, per request.
 *
 * @param getDeps resolves the service and actor for the request the factory is serving
 */
export function createMcpServerFactory(
  getDeps: (ctx: McpServerContext) => ToolContext | Promise<ToolContext>,
): McpServerFactory {
  return async (ctx: McpServerContext): Promise<McpServer> => {
    const deps = await getDeps(ctx);
    const server = new McpServer(
      { name: "weworking", version: VERSION, title: "weworking (unofficial WeWork desks)" },
      { instructions: MCP_INSTRUCTIONS },
    );
    registerTools(server, deps);
    return server;
  };
}

/** Options for {@link mountMcp}. */
export interface MountMcpOptions {
  /**
   * Resolves the caller. `props` is the OAuth grant's decrypted props, which
   * `@cloudflare/workers-oauth-provider` puts on the execution context. Returning
   * `null` means "no valid credential" and produces {@link MountMcpOptions.unauthorized}.
   */
  resolveActor: (req: Request, env: Env, props?: unknown) => Promise<Actor | null>;
  /** Builds the booking service for this request and actor. */
  buildService: (env: Env, actor: Actor, req: Request) => BookingServiceImpl;
  /**
   * The 401 to send when `resolveActor` returns `null`. Must carry
   * `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`
   * so MCP clients can discover the OAuth server (build spec §8).
   */
  unauthorized: (req: Request, env: Env) => Response | Promise<Response>;
  /** Defaults to {@link MCP_ROUTE}. */
  route?: string;
  /** Extra hostnames to accept in the `Host` header, on top of the computed defaults. */
  allowedHostnames?: string[];
  /** Reported to the operator's logs; never to the client. */
  onError?: (error: Error) => void;
}

/**
 * Mounts the MCP endpoint on a Hono app.
 *
 * The route answers every method: `POST` carries JSON-RPC, and `GET`/`DELETE` are
 * answered by the handler itself (405 for the stateless protocol).
 *
 * @example
 * mountMcp(app, {
 *   resolveActor,
 *   buildService,
 *   unauthorized: (req, env) => unauthorizedResponse(baseUrl(parseConfig(env), req)),
 * });
 */
export function mountMcp(app: Hono<{ Bindings: Env }>, opts: MountMcpOptions): void {
  const route = opts.route ?? MCP_ROUTE;

  app.all(route, async (c) => {
    const request = c.req.raw;
    const props = oauthProps(c);

    let actor: Actor | null;
    try {
      actor = await opts.resolveActor(request, c.env, props);
    } catch (err) {
      return c.json(toErrorBody(err), statusFor(err) as 400);
    }
    if (!actor) return await opts.unauthorized(request, c.env);

    let service: BookingServiceImpl;
    try {
      service = opts.buildService(c.env, actor, request);
    } catch (err) {
      // A configuration failure (a missing QUOTE_SIGNING_KEY, say) must not look like
      // a protocol error: answer with the normal error envelope.
      return c.json(toErrorBody(err), statusFor(err) as 400);
    }

    const resolvedActor = actor;
    const handlerOptions: Parameters<typeof createMcpHandler>[1] = {
      route,
      authContext: { props: { ...resolvedActor } },
      allowedHostnames: resolveAllowedHostnames(request, c.env, opts.allowedHostnames),
    };
    if (opts.onError) handlerOptions.onerror = opts.onError;

    const handler = createMcpHandler(
      createMcpServerFactory(() => ({ service, actor: resolvedActor })),
      handlerOptions,
    );
    return await handler.fetch(request);
  });
}

/**
 * The OAuth grant's decrypted props, which `@cloudflare/workers-oauth-provider` puts on
 * the execution context.
 *
 * Hono's `c.executionCtx` *throws* when there is no execution context — which is the
 * normal case for `app.request()` in a test, and for any non-OAuth credential — so the
 * access is guarded rather than optional-chained.
 */
function oauthProps(c: { executionCtx: ExecutionContext }): unknown {
  try {
    return (c.executionCtx as ExecutionContext & { props?: unknown }).props;
  } catch {
    return undefined;
  }
}

/**
 * The `Host` values this endpoint accepts.
 *
 * Always a superset of what the library would allow on its own, so enabling the check
 * can never break a working deployment:
 * - the request's own hostname — the `*.workers.dev` default, and the only sane answer
 *   for a custom domain, which otherwise gets no check at all;
 * - `localhost` / `127.0.0.1` / `[::1]` for `wrangler dev` and for tests;
 * - the `PUBLIC_BASE_URL` hostname, so an operator behind a proxy or a custom domain
 *   can pin the name clients are told to use;
 * - anything the caller passes explicitly.
 */
function resolveAllowedHostnames(request: Request, env: Env, extra?: string[]): string[] {
  const hostnames = new Set<string>(LOCALHOST_HOSTNAMES);
  try {
    hostnames.add(new URL(request.url).hostname);
  } catch {
    // A Request always has a parseable URL; the guard is only for exotic test doubles.
  }
  const configured = publicHostname(env);
  if (configured) hostnames.add(configured);
  for (const hostname of extra ?? []) {
    if (hostname) hostnames.add(hostname);
  }
  return [...hostnames];
}

/** The `PUBLIC_BASE_URL` hostname, or `undefined` when it is unset or unparseable. */
function publicHostname(env: Env): string | undefined {
  try {
    const { publicBaseUrl } = parseConfig(env);
    return publicBaseUrl ? new URL(publicBaseUrl).hostname : undefined;
  } catch {
    // `/healthz` is the place that reports broken configuration; here it must not
    // prevent the host check from being set up.
    return undefined;
  }
}
