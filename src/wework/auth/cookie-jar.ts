/**
 * A minimal, domain- and path-aware cookie jar.
 *
 * Workers' `fetch` has no cookie store: with `redirect: "manual"` we see every hop
 * of the Auth0 login chain, and we are responsible for carrying `Set-Cookie` from
 * one hop into the `Cookie` header of the next. Auth0's universal login will not
 * complete without it (`did`, `auth0`, `_csrf`, the transaction cookies).
 *
 * This is deliberately *not* a full RFC 6265 implementation. It implements the
 * subset the login chain exercises:
 *
 * - `Domain` (with the leading-dot form) and host-only cookies;
 * - `Path`, including RFC 6265 section 5.1.4 default-path derivation;
 * - expiry via `Max-Age` (which wins) or `Expires`;
 * - `Secure` (never sent over plain http);
 * - overwrite by the `(domain, path, name)` triple, as the RFC requires;
 * - longest-path-first ordering in the `Cookie` header.
 *
 * Not implemented, because nothing in the flow needs it: `SameSite` enforcement,
 * `HttpOnly` (we are not a browser, so there is no script to hide from), public
 * suffix rejection, `__Host-`/`__Secure-` prefixes, and the 4 KiB size limit.
 *
 * Cookie values are credentials. Never log a jar; `redact()` masks any key matching
 * /cookie/, and {@link CookieJar.describe} exists for debugging without values.
 */

/** One stored cookie. */
export interface StoredCookie {
  name: string;
  value: string;
  /** Lower-cased host, with no leading dot. */
  domain: string;
  /** Always starts with `/`. */
  path: string;
  /** Unix epoch milliseconds, or `undefined` for a session cookie. */
  expiresAt?: number;
  /** When true the cookie is only sent over https. */
  secure: boolean;
  /** True when no `Domain` attribute was present: matches this exact host only. */
  hostOnly: boolean;
  /** Insertion order, used as the tie-break when two cookies share a path length. */
  createdAt: number;
}

/** Options for {@link CookieJar}. */
export interface CookieJarOptions {
  /** Injected clock (epoch ms) so expiry is testable. */
  now?: () => number;
}

/** Arguments for {@link CookieJar.seed}. */
export interface SeedCookie {
  name: string;
  value: string;
  /** Host the cookie belongs to, e.g. `"idp.wework.com"`. */
  domain: string;
  /** Defaults to `"/"`. */
  path?: string;
  /** Defaults to `true` — everything in this flow is https. */
  secure?: boolean;
  /** Defaults to `true` (host-only, like a browser cookie set without `Domain`). */
  hostOnly?: boolean;
  expiresAt?: number;
}

export class CookieJar {
  /** Keyed by `domain path name`, which is exactly the RFC's identity triple. */
  readonly #cookies = new Map<string, StoredCookie>();
  readonly #now: () => number;
  #sequence = 0;

  constructor(options: CookieJarOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /**
   * Stores every `Set-Cookie` on `response`, interpreting relative `Domain`/`Path`
   * attributes against `url`.
   *
   * Uses `Headers.getSetCookie()`, which is the only correct way to read multiple
   * `Set-Cookie` headers — `headers.get("set-cookie")` comma-joins them and
   * corrupts any `Expires` attribute, which itself contains a comma.
   */
  addFromResponse(url: string | URL, response: Response): void {
    const requestUrl = new URL(url);
    for (const header of readSetCookieHeaders(response)) {
      this.addSetCookie(requestUrl, header);
    }
  }

  /** Stores one raw `Set-Cookie` header value. Invalid headers are ignored. */
  addSetCookie(url: string | URL, header: string): void {
    const requestUrl = new URL(url);
    const parsed = parseSetCookie(header, requestUrl, this.#now());
    if (!parsed) return;

    // A cookie whose expiry is in the past is a deletion instruction.
    if (parsed.expiresAt !== undefined && parsed.expiresAt <= this.#now()) {
      this.#cookies.delete(keyOf(parsed));
      return;
    }
    parsed.createdAt = this.#nextSequence();
    this.#store(parsed);
  }

  /**
   * Inserts a cookie directly, for the two Auth0 transaction cookies the SPA
   * would normally have written from JavaScript before `/authorize`.
   */
  seed(cookie: SeedCookie): void {
    const stored: StoredCookie = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain.toLowerCase().replace(/^\./, ""),
      path: cookie.path ?? "/",
      secure: cookie.secure ?? true,
      hostOnly: cookie.hostOnly ?? true,
      createdAt: this.#nextSequence(),
    };
    if (cookie.expiresAt !== undefined) stored.expiresAt = cookie.expiresAt;
    this.#store(stored);
  }

  /**
   * The `Cookie` header value for `url`, or `""` when nothing matches (in which
   * case the caller should omit the header entirely rather than send it empty).
   *
   * Ordering follows RFC 6265 section 5.4: longer paths first, then insertion order.
   */
  headerFor(url: string | URL): string {
    const target = new URL(url);
    const host = target.hostname.toLowerCase();
    const isSecure = target.protocol === "https:";
    const now = this.#now();

    const matches: StoredCookie[] = [];
    for (const cookie of this.#cookies.values()) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.#cookies.delete(keyOf(cookie));
        continue;
      }
      if (cookie.secure && !isSecure) continue;
      if (!domainMatches(host, cookie.domain, cookie.hostOnly)) continue;
      if (!pathMatches(target.pathname, cookie.path)) continue;
      matches.push(cookie);
    }

    matches.sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
    return matches.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  /** Number of live cookies. Expired entries are pruned first. */
  get size(): number {
    const now = this.#now();
    for (const cookie of this.#cookies.values()) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.#cookies.delete(keyOf(cookie));
      }
    }
    return this.#cookies.size;
  }

  /** Every stored cookie, copied. Test-only; callers must not log the values. */
  snapshot(): StoredCookie[] {
    return [...this.#cookies.values()].map((cookie) => ({ ...cookie }));
  }

  /** `domain path name` triples with no values — safe to log. */
  describe(): string[] {
    return [...this.#cookies.values()].map(
      (cookie) => `${cookie.domain}${cookie.path} ${cookie.name}`,
    );
  }

  clear(): void {
    this.#cookies.clear();
  }

  #store(cookie: StoredCookie): void {
    const key = keyOf(cookie);
    const existing = this.#cookies.get(key);
    // Overwriting keeps the original creation order, as browsers do.
    this.#cookies.set(key, {
      ...cookie,
      createdAt: existing ? existing.createdAt : cookie.createdAt,
    });
  }

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }
}

/* -------------------------------------------------------------------------- */
/* Parsing and matching                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Reads the individual `Set-Cookie` headers from a response.
 *
 * `getSetCookie()` is standard and present in workerd and undici, but a hand-rolled
 * `Response` in a test may predate it, so fall back to the comma-joined form.
 */
function readSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const joined = headers.get("set-cookie");
  return joined ? splitJoinedSetCookie(joined) : [];
}

/**
 * Splits a comma-joined `Set-Cookie` string, skipping the commas that belong to an
 * `Expires=Wed, 09 Jun 2027 ...` attribute. Only used on the fallback path.
 */
function splitJoinedSetCookie(joined: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] !== ",") continue;
    // A comma starts a new cookie only when what follows looks like `name=`.
    const rest = joined.slice(i + 1);
    if (/^\s*[^=;,\s]+=/.test(rest) && !/^\s*\d{1,2}[ -]/.test(rest)) {
      parts.push(joined.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(joined.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Parses one `Set-Cookie` value. Returns `undefined` for headers we cannot use. */
function parseSetCookie(header: string, url: URL, now: number): StoredCookie | undefined {
  const segments = header.split(";");
  const pair = segments[0]?.trim();
  if (!pair) return undefined;
  const eq = pair.indexOf("=");
  if (eq <= 0) return undefined;

  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return undefined;

  const host = url.hostname.toLowerCase();
  let domain = host;
  let hostOnly = true;
  let path: string | undefined;
  let secure = false;
  let expiresAt: number | undefined;
  let maxAgeMs: number | undefined;

  for (const segment of segments.slice(1)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf("=");
    const attr = (sep === -1 ? trimmed : trimmed.slice(0, sep)).trim().toLowerCase();
    const attrValue = sep === -1 ? "" : trimmed.slice(sep + 1).trim();

    switch (attr) {
      case "domain": {
        const candidate = attrValue.toLowerCase().replace(/^\./, "");
        // Reject a Domain the request host is not inside (RFC 6265 section 5.3 step 6).
        if (candidate && domainMatches(host, candidate, false)) {
          domain = candidate;
          hostOnly = false;
        }
        break;
      }
      case "path":
        if (attrValue.startsWith("/")) path = attrValue;
        break;
      case "secure":
        secure = true;
        break;
      case "expires": {
        const parsed = Date.parse(attrValue);
        if (!Number.isNaN(parsed)) expiresAt = parsed;
        break;
      }
      case "max-age": {
        const seconds = Number.parseInt(attrValue, 10);
        if (!Number.isNaN(seconds)) maxAgeMs = seconds * 1000;
        break;
      }
      default:
        break;
    }
  }

  const cookie: StoredCookie = {
    name,
    value,
    domain,
    path: path ?? defaultPath(url.pathname),
    secure,
    hostOnly,
    createdAt: 0,
  };
  // Max-Age wins over Expires (RFC 6265 section 5.3 step 3).
  const resolvedExpiry = maxAgeMs !== undefined ? now + maxAgeMs : expiresAt;
  if (resolvedExpiry !== undefined) cookie.expiresAt = resolvedExpiry;
  return cookie;
}

/** RFC 6265 section 5.1.4: the directory part of the request path, or `"/"`. */
export function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith("/")) return "/";
  const lastSlash = requestPath.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return requestPath.slice(0, lastSlash);
}

/** RFC 6265 section 5.1.3 domain-match, plus the host-only shortcut. */
export function domainMatches(host: string, cookieDomain: string, hostOnly: boolean): boolean {
  if (host === cookieDomain) return true;
  if (hostOnly) return false;
  return host.endsWith(`.${cookieDomain}`);
}

/** RFC 6265 section 5.1.4 path-match. */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith("/")) return true;
  return requestPath[cookiePath.length] === "/";
}

function keyOf(cookie: Pick<StoredCookie, "domain" | "path" | "name">): string {
  return `${cookie.domain} ${cookie.path} ${cookie.name}`;
}
