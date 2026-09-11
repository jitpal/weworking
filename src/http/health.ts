/**
 * `GET /healthz` — the public liveness and configuration probe (build spec §8).
 *
 * Two rules shape this file:
 *
 * 1. **It contains no secrets.** Only *presence* booleans (`quoteKey: true`), a count of
 *    static tokens, and the session's state — never a token, a password, an expiry-less
 *    credential, or a configuration value. It is unauthenticated, so treat everything it
 *    returns as published.
 * 2. **It answers even when the deployment is broken.** A missing `QUOTE_SIGNING_KEY`
 *    makes `parseConfig` throw, and that is precisely when an operator needs this route
 *    most — so a configuration failure is reported as `ok: false` with the message,
 *    never as a 500.
 *
 * The Durable Object is reached through the injected `getSessionInfo` rather than
 * imported, so this module has no dependency on `src/session/do.ts` and the route can be
 * tested with a stub.
 */

import { Hono } from "hono";
import type { SessionInfo } from "../core/types";
import { type Env, parseConfig, VERSION } from "../env";
import { isAppError } from "../errors";

/** The body `GET /healthz` returns. */
export interface HealthBody {
  /** False when configuration is invalid or the session store is unreachable. */
  ok: boolean;
  version: string;
  /** Presence only — never a value. */
  secrets: {
    weworkCredentials: boolean;
    adminPassword: boolean;
    quoteKey: boolean;
    cookieKey: boolean;
    /** How many static bearer tokens are configured. */
    authTokens: number;
  };
  /** The stored WeWork session's health. Contains no token. */
  session: SessionInfo;
  /** Whether mutating operations are permitted at all. */
  writeEnabled: boolean;
  /** Present only when configuration failed to parse; names the variable, never its value. */
  configError?: string;
}

/** Options for {@link healthRoutes}. */
export interface HealthRoutesOptions {
  /**
   * Reads the session state, normally `(env) => getSessionStub(env).getSessionInfo()`.
   *
   * Injected so this module never imports the Durable Object class. A rejection is
   * reported as `session.state: "none"` with `ok: false` rather than failing the route.
   */
  getSessionInfo?: (env: Env) => Promise<SessionInfo>;
}

/** The state reported when nothing is known about the session. */
const NO_SESSION: SessionInfo = { state: "none", source: "none", hasRefreshToken: false };

/**
 * The `/healthz` route.
 *
 * @example
 * app.route("/", healthRoutes({ getSessionInfo: (env) => getSessionStub(env).getSessionInfo() }));
 */
export function healthRoutes(opts: HealthRoutesOptions = {}): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/healthz", async (c) => {
    const body = await health(c.env, opts);
    // Always 200: this is a configuration *report*, and a monitor that only looks at the
    // status code should see that the worker itself is up. Branch on `ok`.
    return c.json(body);
  });

  return routes;
}

/** Builds the health body. Exported for tests and for reuse by `/admin/status`. */
export async function health(env: Env, opts: HealthRoutesOptions = {}): Promise<HealthBody> {
  let secrets: HealthBody["secrets"];
  let writeEnabled = false;
  let configError: string | undefined;

  try {
    const config = parseConfig(env);
    secrets = config.secretsPresent;
    writeEnabled = config.writeEnabled;
  } catch (err) {
    // Fall back to reading presence directly off `Env`: the whole point of this route is
    // to tell the operator *which* secret is missing.
    secrets = presenceFromEnv(env);
    configError = isAppError(err) ? err.message : "Configuration could not be parsed.";
  }

  let session = NO_SESSION;
  let sessionOk = true;
  if (opts.getSessionInfo) {
    try {
      session = await opts.getSessionInfo(env);
    } catch {
      sessionOk = false;
    }
  }

  const body: HealthBody = {
    ok: configError === undefined && sessionOk,
    version: VERSION,
    secrets,
    session,
    writeEnabled,
  };
  if (configError !== undefined) body.configError = configError;
  return body;
}

/** Presence booleans derived straight from `Env`, for when `parseConfig` refused. */
function presenceFromEnv(env: Env): HealthBody["secrets"] {
  return {
    weworkCredentials: nonEmpty(env.WEWORK_USERNAME) && nonEmpty(env.WEWORK_PASSWORD),
    adminPassword: nonEmpty(env.ADMIN_PASSWORD),
    quoteKey: nonEmpty(env.QUOTE_SIGNING_KEY),
    cookieKey: nonEmpty(env.COOKIE_SIGNING_KEY),
    authTokens: countTokens(env.AUTH_TOKENS),
  };
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Counts `AUTH_TOKENS` entries without validating them — `0` when unparseable. */
function countTokens(raw: string | undefined): number {
  if (!nonEmpty(raw)) return 0;
  try {
    const parsed: unknown = JSON.parse(raw as string);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
