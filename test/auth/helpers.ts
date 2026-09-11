/**
 * Shared fixtures for the auth tests: a fake `Env`, and the cookie bookkeeping a
 * browser would do for us (CSRF cookie out, form field in, session cookie back).
 */

import { ADMIN_COOKIE, adminSessionCookie } from "../../src/auth/admin-session";
import type { Env } from "../../src/env";

/** Valid 32-byte hex keys, so `parseConfig()` is happy. */
export const HEX_KEY_A = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
export const HEX_KEY_B = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
export const ADMIN_PASSWORD = "correct-horse-battery-staple";

/** A complete, valid environment. Override any field per test. */
export function fakeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    ADMIN_PASSWORD,
    COOKIE_SIGNING_KEY: HEX_KEY_B,
    QUOTE_SIGNING_KEY: HEX_KEY_A,
    WRITE_ENABLED: "true",
    MAX_BOOKINGS_PER_DAY: "1",
    MAX_BOOKINGS_PER_WEEK: "5",
    MAX_CREDITS_PER_BOOKING: "0",
    QUOTE_TTL_SECONDS: "600",
    LOGIN_STRATEGY: "manual",
    PUBLIC_BASE_URL: "https://desk.example.com",
    ...overrides,
  } as unknown as Env;
}

/** Every `name=value` pair from a response's `Set-Cookie` headers. */
export function cookiesFrom(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0] ?? "";
    const index = pair.indexOf("=");
    if (index > 0) out[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1));
  }
  return out;
}

/** Serialises a cookie jar into a `Cookie` request header. */
export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

/** The `value` of `<input name="NAME" value="...">` in a rendered page. */
export function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return match?.[1] ?? "";
}

/** Headers a browser sends when navigating. */
export const HTML_HEADERS = { Accept: "text/html,application/xhtml+xml" };

/**
 * A cookie jar holding a valid `ww_admin` session for `env`.
 *
 * `/admin/*` accepts nothing else, so almost every admin test starts here. It signs
 * the same cookie `POST /admin/login` would, without driving the form.
 */
export async function adminJar(env: Env = fakeEnv()): Promise<Record<string, string>> {
  const header = await adminSessionCookie(env);
  const pair = (header ?? "").split(";")[0] ?? "";
  const index = pair.indexOf("=");
  return { [ADMIN_COOKIE]: decodeURIComponent(pair.slice(index + 1)) };
}

/** The `Cookie` header for a signed-in operator. */
export async function adminCookie(env: Env = fakeEnv()): Promise<string> {
  return cookieHeader(await adminJar(env));
}
