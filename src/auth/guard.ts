/**
 * Resolving the caller — the one place that turns an HTTP request into an
 * {@link Actor}.
 *
 * Two credentials reach `/mcp` and `/api/*`:
 *
 *  - an **OAuth access token**, validated by `@cloudflare/workers-oauth-provider`
 *    before our handler runs. The provider hands us the grant's decrypted props on
 *    `ctx.props`; we only check their shape.
 *  - a **static bearer token**, matched against `AUTH_TOKENS` by SHA-256 here.
 *
 * The provider validates tokens but does **not** enforce scopes, so every route
 * must call {@link requireScope} itself.
 *
 * When nothing valid is presented, answer with {@link unauthorizedResponse}: the
 * `WWW-Authenticate: Bearer resource_metadata=...` challenge is how an MCP client
 * discovers that this server speaks OAuth at all.
 */

import type { Actor, Scope } from "../core/types";
import type { Env } from "../env";
import { AppError, type ErrorBody } from "../errors";
import { DEFAULT_ACCOUNT_ID, matchStaticToken } from "./tokens";

/** Hono context key under which `src/index.ts` stores the resolved actor. */
export const ACTOR_CONTEXT_KEY = "actor";

/** The RFC 9728 metadata path the 401 challenge points at. */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * The props we ask `completeAuthorization()` to store on a grant. They come back
 * decrypted on `ctx.props` for every authenticated API request.
 */
export interface OAuthActorProps {
  name: string;
  scopes: Scope[];
  accountId?: string;
  /**
   * How the credential was presented. The provider's `resolveExternalToken` seam
   * (see `src/auth/oauth.ts`) validates a *static* `AUTH_TOKENS` token and hands us
   * props too, so this field keeps the audit log honest about which kind it was.
   * Absent means a real OAuth grant.
   */
  kind?: "oauth" | "bearer";
}

/** Extracts the bearer credential from the `Authorization` header, if any. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/** True when `value` is shaped like {@link OAuthActorProps} (and not, say, `{}`). */
export function isOAuthActorProps(value: unknown): value is OAuthActorProps {
  if (typeof value !== "object" || value === null) return false;
  const props = value as Record<string, unknown>;
  if (typeof props.name !== "string" || props.name.length === 0) return false;
  if (!Array.isArray(props.scopes) || props.scopes.length === 0) return false;
  if (!props.scopes.every((scope) => scope === "read" || scope === "write" || scope === "admin")) {
    return false;
  }
  if (props.accountId !== undefined && typeof props.accountId !== "string") return false;
  if (props.kind !== undefined && props.kind !== "oauth" && props.kind !== "bearer") return false;
  return true;
}

/**
 * Resolves the caller of a protected request.
 *
 * @param request the incoming request (only the `Authorization` header is read).
 * @param env the worker environment, for `AUTH_TOKENS`.
 * @param oauthProps `ctx.props` from the OAuth provider, when the request arrived
 * through it. Anything that is not shaped like {@link OAuthActorProps} is ignored
 * and the `Authorization` header is tried instead, so this function behaves the
 * same whether it is called from inside the provider's `apiHandler` or from
 * middleware on the raw request.
 * @returns the `Actor`, or `null` when no valid credential was presented.
 */
export async function resolveActor(
  request: Request,
  env: Env,
  oauthProps?: unknown,
): Promise<Actor | null> {
  if (isOAuthActorProps(oauthProps)) {
    return {
      kind: oauthProps.kind === "bearer" ? "bearer" : "oauth",
      name: oauthProps.name,
      scopes: [...oauthProps.scopes],
      accountId: oauthProps.accountId ?? DEFAULT_ACCOUNT_ID,
    };
  }

  const token = bearerToken(request);
  if (!token) return null;
  return matchStaticToken(env, token);
}

/** True when `actor` holds `scope`. `admin` is a superset of everything. */
export function hasScope(actor: Actor, scope: Scope): boolean {
  return actor.scopes.includes(scope) || actor.scopes.includes("admin");
}

/**
 * Asserts that `actor` holds `scope`.
 *
 * Scopes are explicit — holding `write` does **not** imply `read` — with one
 * exception: `admin` implies all three, because it is the operator's own
 * credential.
 *
 * @throws {AppError} `FORBIDDEN_SCOPE` (403) naming the missing scope.
 */
export function requireScope(actor: Actor, scope: Scope): void {
  if (hasScope(actor, scope)) return;
  throw new AppError(
    "FORBIDDEN_SCOPE",
    `This credential has scopes [${actor.scopes.join(", ")}] and needs '${scope}'.`,
    {
      hint: `Ask the operator for a credential with the '${scope}' scope (admin implies all scopes).`,
    },
  );
}

/**
 * The 401 every unauthenticated request to a protected route gets.
 *
 * The `resource_metadata` parameter is the whole point: an MCP client reads it,
 * fetches the RFC 9728 document the OAuth provider serves at that path, and starts
 * the authorization flow on its own.
 */
export function unauthorizedResponse(baseUrl: string): Response {
  const resourceMetadata = `${baseUrl.replace(/\/+$/, "")}${PROTECTED_RESOURCE_METADATA_PATH}`;
  const body: ErrorBody = {
    error: {
      code: "UNAUTHORIZED",
      message: "No valid credential was presented.",
      hint: "Send 'Authorization: Bearer <token>' with a token from AUTH_TOKENS, or complete the OAuth flow advertised by the WWW-Authenticate header.",
    },
  };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${resourceMetadata}"`,
    },
  });
}

/**
 * The absolute origin to use in links, OAuth metadata and hints:
 * `PUBLIC_BASE_URL` when it is set and parseable, otherwise the request's origin.
 *
 * This deliberately does not go through `parseConfig()`: it has to keep working
 * when a required secret is missing, which is exactly when the admin pages and the
 * 401 challenge matter most.
 */
export function baseUrlFrom(request: Request, env: Env): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the request's own origin.
    }
  }
  return new URL(request.url).origin;
}
