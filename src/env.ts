/**
 * Worker environment: the bindings and secrets wrangler injects, and the parsed,
 * validated {@link Config} the rest of the codebase consumes.
 *
 * Rule: only this module reads `Env` fields for configuration. Everything below is
 * handed a `Config` (and a `TokenStore`), so it can be unit-tested without a Worker
 * environment.
 *
 * `Env` is hand-written rather than relying solely on the generated
 * `worker-configuration.d.ts`, because `wrangler types` cannot know which secrets
 * exist. Both are kept in sync; `wrangler types` output is committed as
 * `worker-configuration.d.ts` for the runtime (`DurableObject`, `KVNamespace`, ...).
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { AppError } from "./errors";
import type { WeWorkSession } from "./session/do";

/**
 * Teaches the *generated* binding types about the secrets, which `wrangler types`
 * cannot know about (they live in `.dev.vars` / `wrangler secret put`).
 *
 * This augmentation is what makes `env` from `cloudflare:test` — typed as
 * `Cloudflare.Env` by `@cloudflare/vitest-pool-workers` — include the secrets the
 * test bindings in vitest.config.ts provide.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      WEWORK_USERNAME?: string;
      WEWORK_PASSWORD?: string;
      ADMIN_PASSWORD?: string;
      QUOTE_SIGNING_KEY?: string;
      COOKIE_SIGNING_KEY?: string;
    }
  }
}

/** How the worker is allowed to obtain a WeWork session. */
export type LoginStrategyName = "auto" | "headless" | "manual";

/**
 * Everything bound to the Worker.
 *
 * Secrets are typed as `string` (not `string | undefined`) where wrangler always
 * provides them, and optional where the deployment may legitimately omit them —
 * `parseConfig` is the single place that decides which is which.
 */
export interface Env {
  /* ---- Bindings ---- */

  /** The single SQLite Durable Object holding the session, caps, idempotency and audit log. */
  SESSION: DurableObjectNamespace<WeWorkSession>;
  /** Required by `@cloudflare/workers-oauth-provider` for clients, grants and tokens. */
  OAUTH_KV: KVNamespace;
  /** Injected by `OAuthProvider` at request time; absent in tests that bypass the provider. */
  OAUTH_PROVIDER?: OAuthHelpers;

  /* ---- Secrets (wrangler secret put / .dev.vars) ---- */

  /** WeWork member email. Optional: only needed for headless login. */
  WEWORK_USERNAME?: string;
  /** WeWork member password. Optional: only needed for headless login. */
  WEWORK_PASSWORD?: string;
  /** Gates `/admin/*` and the OAuth approve screen. Required. */
  ADMIN_PASSWORD?: string;
  /** Hex, >= 32 bytes. HMAC key for booking quotes. Required. */
  QUOTE_SIGNING_KEY?: string;
  /** Hex, >= 32 bytes. HMAC key for the admin session cookie. Required. */
  COOKIE_SIGNING_KEY?: string;

  /* ---- Vars (wrangler.jsonc `vars`) ---- */

  WRITE_ENABLED?: string;
  MAX_BOOKINGS_PER_DAY?: string;
  MAX_BOOKINGS_PER_WEEK?: string;
  MAX_CREDITS_PER_BOOKING?: string;
  LOGIN_STRATEGY?: string;
  PUBLIC_BASE_URL?: string;
}

/**
 * Parsed configuration. Numbers are numbers, booleans are booleans, and the
 * presence of each secret has already been decided.
 *
 * Secret *values* live here because the worker needs them (they are never logged
 * or serialised — `/healthz` reports only the `secretsPresent` booleans).
 */
export interface Config {
  /* Safety */
  /** Master kill switch; when false every mutating operation raises `WRITE_DISABLED`. */
  writeEnabled: boolean;
  maxBookingsPerDay: number;
  maxBookingsPerWeek: number;
  /**
   * Most credits one booking may spend. `0` (the default) allows only bookings that
   * cost no credits, which is every desk on an All Access plan and every cash
   * booking. `-1` means no limit.
   */
  maxCreditsPerBooking: number;

  /** Raw hex HMAC key for quote signing. */
  quoteSigningKey: string;

  /* Auth */
  /** Raw hex HMAC key for the admin cookie. */
  cookieSigningKey: string;
  adminPassword: string;

  /* WeWork login */
  loginStrategy: LoginStrategyName;
  weworkUsername?: string;
  weworkPassword?: string;
  /** True when both username and password are present. */
  hasWeworkCredentials: boolean;

  /* Deployment */
  /** Absolute origin with no trailing slash, or `""` to derive it from the request. */
  publicBaseUrl: string;

  /** Presence booleans, safe to expose on `/healthz`. */
  secretsPresent: {
    weworkCredentials: boolean;
    adminPassword: boolean;
    quoteKey: boolean;
    cookieKey: boolean;
  };
}

/** Semantic version of the deployed worker, reported by `/healthz`. Keep in step with package.json. */
export const VERSION = "0.1.0";

/** Minimum key length in bytes for the HMAC secrets. */
const MIN_KEY_BYTES = 32;

const DEFAULTS = {
  WRITE_ENABLED: "true",
  MAX_BOOKINGS_PER_DAY: "1",
  MAX_BOOKINGS_PER_WEEK: "7",
  MAX_CREDITS_PER_BOOKING: "0",
  LOGIN_STRATEGY: "auto",
  PUBLIC_BASE_URL: "",
} as const;

/**
 * Validates and parses `Env` into a {@link Config}.
 *
 * Call this once per request (it is cheap and stateless) rather than caching it in
 * module scope, so a `wrangler secret put` takes effect on the next request.
 *
 * @throws {AppError} with code `VALIDATION` when a required secret is missing or a
 * var is not parseable. The message names the offending variable and never echoes
 * its value.
 */
export function parseConfig(env: Env): Config {
  const quoteSigningKey = requireHexKey(env.QUOTE_SIGNING_KEY, "QUOTE_SIGNING_KEY");
  const cookieSigningKey = requireHexKey(env.COOKIE_SIGNING_KEY, "COOKIE_SIGNING_KEY");
  const adminPassword = requireNonEmpty(env.ADMIN_PASSWORD, "ADMIN_PASSWORD");

  const weworkUsername = emptyToUndefined(env.WEWORK_USERNAME);
  const weworkPassword = emptyToUndefined(env.WEWORK_PASSWORD);
  const hasWeworkCredentials = weworkUsername !== undefined && weworkPassword !== undefined;

  const loginStrategy = parseLoginStrategy(env.LOGIN_STRATEGY ?? DEFAULTS.LOGIN_STRATEGY);
  if (loginStrategy === "headless" && !hasWeworkCredentials) {
    throw validation(
      "LOGIN_STRATEGY is 'headless' but WEWORK_USERNAME/WEWORK_PASSWORD are not both set.",
      "Either set both credentials or use LOGIN_STRATEGY='manual' and connect a token at /admin/connect.",
    );
  }

  const config: Config = {
    writeEnabled: parseBoolean(env.WRITE_ENABLED ?? DEFAULTS.WRITE_ENABLED, "WRITE_ENABLED"),
    maxBookingsPerDay: parseInteger(
      env.MAX_BOOKINGS_PER_DAY ?? DEFAULTS.MAX_BOOKINGS_PER_DAY,
      "MAX_BOOKINGS_PER_DAY",
      { min: 0, max: 50 },
    ),
    maxBookingsPerWeek: parseInteger(
      env.MAX_BOOKINGS_PER_WEEK ?? DEFAULTS.MAX_BOOKINGS_PER_WEEK,
      "MAX_BOOKINGS_PER_WEEK",
      { min: 0, max: 200 },
    ),
    maxCreditsPerBooking: parseCreditsCap(
      env.MAX_CREDITS_PER_BOOKING ?? DEFAULTS.MAX_CREDITS_PER_BOOKING,
    ),
    quoteSigningKey,
    cookieSigningKey,
    adminPassword,
    loginStrategy,
    hasWeworkCredentials,
    publicBaseUrl: parseBaseUrl(env.PUBLIC_BASE_URL ?? DEFAULTS.PUBLIC_BASE_URL),
    secretsPresent: {
      weworkCredentials: hasWeworkCredentials,
      adminPassword: true,
      quoteKey: true,
      cookieKey: true,
    },
  };
  if (weworkUsername !== undefined) config.weworkUsername = weworkUsername;
  if (weworkPassword !== undefined) config.weworkPassword = weworkPassword;
  return config;
}

/**
 * The absolute base URL to use in OAuth metadata, hints and the connect page:
 * `PUBLIC_BASE_URL` when set, otherwise the request's own origin.
 */
export function baseUrl(config: Config, request: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  return new URL(request.url).origin;
}

/* -------------------------------------------------------------------------- */
/* Parsers                                                                     */
/* -------------------------------------------------------------------------- */

function validation(message: string, hint?: string): AppError {
  return new AppError("VALIDATION", message, hint !== undefined ? { hint } : {});
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const trimmed = emptyToUndefined(value);
  if (trimmed === undefined) {
    throw validation(
      `${name} is not set.`,
      `Set it with \`npx wrangler secret put ${name}\` (or in .dev.vars for local development).`,
    );
  }
  return trimmed;
}

function requireHexKey(value: string | undefined, name: string): string {
  const raw = requireNonEmpty(value, name);
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) {
    throw validation(
      `${name} must be an even-length hexadecimal string.`,
      `Generate one with: node -e "console.log(crypto.getRandomValues(new Uint8Array(${MIN_KEY_BYTES})).reduce((s,b)=>s+b.toString(16).padStart(2,'0'),''))"`,
    );
  }
  if (raw.length / 2 < MIN_KEY_BYTES) {
    throw validation(
      `${name} must be at least ${MIN_KEY_BYTES} bytes (${MIN_KEY_BYTES * 2} hex characters).`,
    );
  }
  return raw.toLowerCase();
}

function parseBoolean(value: string, name: string): boolean {
  const normalised = value.trim().toLowerCase();
  if (normalised === "true" || normalised === "1" || normalised === "yes") return true;
  if (normalised === "false" || normalised === "0" || normalised === "no") return false;
  throw validation(`${name} must be "true" or "false".`);
}

function parseInteger(value: string, name: string, bounds: { min: number; max: number }): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw validation(`${name} must be an integer.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < bounds.min || parsed > bounds.max) {
    throw validation(`${name} must be between ${bounds.min} and ${bounds.max}.`);
  }
  return parsed;
}

/** `"unlimited"` (or `-1`) disables the cap; otherwise a non-negative integer. */
function parseCreditsCap(value: string): number {
  const normalised = value.trim().toLowerCase();
  if (normalised === "unlimited" || normalised === "none" || normalised === "-1") return -1;
  return parseInteger(value, "MAX_CREDITS_PER_BOOKING", { min: 0, max: 100_000 });
}

function parseLoginStrategy(value: string): LoginStrategyName {
  const normalised = value.trim().toLowerCase();
  if (normalised === "auto" || normalised === "headless" || normalised === "manual") {
    return normalised;
  }
  throw validation('LOGIN_STRATEGY must be one of "auto", "headless", "manual".');
}

function parseBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw validation("PUBLIC_BASE_URL must be an absolute URL, e.g. https://desk.example.com.");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw validation("PUBLIC_BASE_URL must use https (http is allowed only for localhost).");
  }
  return url.origin;
}
