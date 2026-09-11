/**
 * Redaction for logs and error details.
 *
 * The rule for this codebase: nothing reaches `console.*`, an `AppError.details`
 * or a tool result without passing through here first. Upstream WeWork/Auth0
 * bodies routinely carry `access_token`, `refresh_token`, `id_token` and
 * `Set-Cookie`, and Workers logs are readable in the dashboard and `wrangler tail`.
 */

/**
 * Keys whose values are replaced wholesale. Matched case-insensitively against the
 * key name, as a substring — so `accessToken`, `x-refresh-token` and
 * `Authorization` all match.
 */
const SENSITIVE_KEY = /token|password|secret|authorization|cookie|refresh/i;

/** What a redacted value is replaced with. Deliberately not the empty string, so it is visible in logs. */
export const REDACTED = "[redacted]";

/** Depth beyond which we stop walking and emit a marker, guarding against cycles and huge upstream bodies. */
const MAX_DEPTH = 12;

/**
 * Deep-copies `value`, replacing any property whose key looks sensitive with
 * {@link REDACTED}. Arrays, plain objects, `Map`, `Set`, `Headers` and `Error`
 * are handled; everything else is returned as-is.
 *
 * Cycles are broken with `"[circular]"`. The input is never mutated.
 *
 * @example
 * redact({ user: "ada", access_token: "ey..." });
 * // => { user: "ada", access_token: "[redacted]" }
 */
export function redact<T>(value: T): unknown {
  return walk(value, 0, new WeakSet());
}

/** True when a property name should have its value replaced. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Returns a plain object of header name -> value with sensitive headers replaced.
 * Header names are lower-cased, as the Fetch API does.
 */
export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v] as [string, string]);
  for (const [name, raw] of entries) {
    out[name] = isSensitiveKey(name) ? REDACTED : raw;
  }
  return out;
}

/**
 * A `URL` or URL string with any sensitive query parameter replaced. Useful when
 * logging Auth0 redirect chains, which carry `code`, `state` and `login_ticket`.
 */
export function redactUrl(url: string | URL): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return REDACTED;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveKey(key) || key === "code" || key === "login_ticket" || key === "state") {
      parsed.searchParams.set(key, REDACTED);
    }
  }
  return parsed.toString();
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Headers) return redactHeaders(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of value.entries()) {
      const name = String(key);
      out[name] = isSensitiveKey(name) ? REDACTED : walk(v, depth + 1, seen);
    }
    return out;
  }
  if (value instanceof Set) {
    return [...value].map((item) => walk(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : walk(v, depth + 1, seen);
  }
  return out;
}
