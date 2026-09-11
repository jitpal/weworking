/**
 * Auth0 tenant discovery.
 *
 * The members.wework.com SPA bootstraps itself from a small public config endpoint
 * rather than hard-coding its Auth0 tenant. We read the same endpoint so a tenant
 * migration (new `clientId`, new `domain`) does not need a redeploy — but we keep a
 * full set of fallback constants, because the endpoint has moved before (the v1
 * `/auth0/config` path now 404s) and a login that fails on *discovery* is a much
 * worse outcome than one that uses slightly stale constants.
 *
 * Nothing here is a secret: `clientId`, `audience`, `scope` and `redirectUri` are
 * all visible in the SPA's JavaScript bundle. The *password* and the resulting
 * tokens are the secrets, and they never pass through this module.
 */

import { redact } from "../../redact";

/** The handful of Auth0 parameters the login and refresh flows need. */
export interface Auth0Config {
  /** Tenant host with no scheme and no trailing slash, e.g. `"idp.wework.com"`. */
  domain: string;
  clientId: string;
  /** Space-separated OAuth scopes. Must include `offline_access` for a refresh token. */
  scope: string;
  /** API audience; the access token is only a WeWork bearer when this is right. */
  audience: string;
  /** Must match byte-for-byte between `/authorize` and `/oauth/token`. */
  redirectUri: string;
}

/** Where the SPA reads its own Auth0 configuration from. */
export const AUTH0_CONFIG_URL =
  "https://members.wework.com/workplaceone/api/auth0/v2/config?domain=members.wework.com%2Fworkplaceone";

/**
 * Known-good values as of 2026-09-11, cross-checked against four independent
 * open-source clients (see docs/WEWORK_API.md). Used when discovery fails.
 */
export const FALLBACK_AUTH0_CONFIG: Auth0Config = {
  domain: "idp.wework.com",
  clientId: "zE51Ep7FttlmtQV6ZEGyJKsY2jD1EtAu",
  scope: "openid profile email offline_access",
  audience: "wework",
  redirectUri:
    "https://members.wework.com/workplaceone/api/auth0/v2/callback?domain=members.wework.com/workplaceone",
};

/**
 * Hosts the login flows are allowed to talk to.
 *
 * Discovery is a public, unauthenticated endpoint on `members.wework.com`, and what
 * it returns decides where `WEWORK_USERNAME` and `WEWORK_PASSWORD` are POSTed. If
 * that endpoint (or anything that can answer for it) ever names another host, the
 * credentials would go there. So the tenant is pinned to WeWork's own domain and to
 * Auth0's: a tenant migration within either still works without a redeploy, and
 * anything else falls back to {@link FALLBACK_AUTH0_CONFIG}.
 *
 * @param hostname a bare host, as `URL.hostname` gives it (no scheme, no port).
 */
export function isAllowedAuthHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host === "wework.com" || host.endsWith(".wework.com") || host.endsWith(".auth0.com");
}

/** The Auth0 connection (database) the member's credentials live in. */
export const AUTH0_REALM = "id-wework";

/** Auth0's password-realm grant, used by `/co/authenticate`. */
export const PASSWORD_REALM_GRANT = "http://auth0.com/oauth/grant-type/password-realm";

/**
 * `base64(JSON.stringify({name:"auth0-spa-js",version:"2.1.2"}))` — the telemetry
 * header auth0-spa-js sends. Auth0's universal login branches on it, so the flow is
 * measurably more likely to complete when we look like the SPA the tenant expects.
 */
export const AUTH0_CLIENT_HEADER = "eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjIuMS4yIn0=";

/** The https origin for a tenant domain, with no trailing slash. */
export function authOrigin(config: Auth0Config): string {
  return `https://${config.domain}`;
}

/** A URL on the tenant, e.g. `authUrl(config, "/oauth/token")`. */
export function authUrl(config: Auth0Config, path: string): string {
  return `${authOrigin(config)}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Fetches the SPA's Auth0 configuration, falling back to {@link FALLBACK_AUTH0_CONFIG}.
 *
 * Never throws: a discovery failure is logged (redacted) at `warn` and the fallback
 * is returned, because every caller can still complete a login with the constants.
 *
 * @param fetchImpl injected `fetch`; tests pass a stub so nothing hits the network.
 */
export async function fetchAuth0Config(fetchImpl: typeof fetch): Promise<Auth0Config> {
  try {
    const response = await fetchImpl(AUTH0_CONFIG_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Origin: "https://members.wework.com",
        Referer: "https://members.wework.com/",
      },
    });
    if (!response.ok) {
      return fallback(`auth0 config endpoint returned HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    const parsed = normaliseConfig(body);
    if (!parsed) return fallback("auth0 config endpoint returned an unrecognised shape");
    return parsed;
  } catch (error) {
    return fallback("auth0 config endpoint was unreachable", error);
  }
}

/**
 * Coerces the discovery body into an {@link Auth0Config}, filling any field the
 * endpoint omits from the fallback constants. Returns `undefined` when the body is
 * not an object at all (in which case the caller logs and uses the fallback).
 */
export function normaliseConfig(body: unknown): Auth0Config | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  // Some deployments nest the payload under `data` or `result`.
  const inner = pickObject(record.data) ?? pickObject(record.result) ?? record;
  const params =
    pickObject(inner.authorizationParams) ?? pickObject(inner.authorizationParam) ?? {};

  const domain = pinnedDomain(normaliseDomain(str(inner.domain) ?? str(inner.auth0Domain)));
  const clientId = str(inner.clientId) ?? str(inner.client_id);
  const scope = str(params.scope) ?? str(inner.scope);
  const audience = str(params.audience) ?? str(inner.audience);
  const redirectUri = pinnedRedirect(
    str(params.redirect_uri) ?? str(params.redirectUri) ?? str(inner.redirect_uri),
  );

  if (!domain && !clientId && !scope && !audience && !redirectUri) return undefined;

  return {
    domain: domain ?? FALLBACK_AUTH0_CONFIG.domain,
    clientId: clientId ?? FALLBACK_AUTH0_CONFIG.clientId,
    scope: scope ?? FALLBACK_AUTH0_CONFIG.scope,
    audience: audience ?? FALLBACK_AUTH0_CONFIG.audience,
    redirectUri: redirectUri ?? FALLBACK_AUTH0_CONFIG.redirectUri,
  };
}

/** The discovered tenant host, or `undefined` when it is not one we will trust. */
function pinnedDomain(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  if (isAllowedAuthHost(domain)) return domain;
  offTenant("domain", domain);
  return undefined;
}

/** The discovered `redirect_uri`, or `undefined` when its host is not one we trust. */
function pinnedRedirect(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    offTenant("redirect_uri", "unparseable");
    return undefined;
  }
  if (isAllowedAuthHost(hostname)) return value;
  offTenant("redirect_uri", hostname);
  return undefined;
}

function offTenant(field: string, host: string): void {
  console.warn(
    "[wework] auth0 discovery named a host outside wework.com/auth0.com, using the pinned fallback",
    redact({ field, host, configUrl: AUTH0_CONFIG_URL }),
  );
}

/** Strips a scheme, path and trailing slash from a tenant domain. */
function normaliseDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutScheme = value.replace(/^https?:\/\//i, "");
  const host = withoutScheme.split("/")[0] ?? withoutScheme;
  const trimmed = host.trim().toLowerCase();
  return trimmed || undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pickObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fallback(reason: string, error?: unknown): Auth0Config {
  console.warn(
    "[wework] auth0 discovery failed, using pinned fallback constants",
    redact({
      reason,
      configUrl: AUTH0_CONFIG_URL,
      fallbackDomain: FALLBACK_AUTH0_CONFIG.domain,
      error,
    }),
  );
  return FALLBACK_AUTH0_CONFIG;
}
