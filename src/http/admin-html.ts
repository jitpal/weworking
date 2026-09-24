/**
 * The entire front end: hand-written HTML strings.
 *
 * Rules this module enforces for every page in the worker (admin, OAuth approval,
 * landing):
 *
 *  - **No external assets.** No CDN, no fonts, no images, no JavaScript. A page that
 *    manages a credential should not be able to load anything.
 *  - **A restrictive CSP meta tag** (`default-src 'none'`) on every page, so even a
 *    future mistake cannot exfiltrate a pasted token.
 *  - **Everything interpolated goes through {@link escapeHtml}.** Client names,
 *    redirect URIs and error messages all come from outside.
 *
 * The one intentional exception to "no JavaScript" is the bookmarklet: it is a
 * `javascript:` URL the user drags to their bookmarks bar, so it runs on
 * `members.wework.com`, never here. CSP blocks it from running on this page, which
 * is why the page says "drag it" rather than "click it".
 */

/**
 * The policy a page carries.
 *
 * `form-action 'self'` keeps a password post local, and `frame-ancestors 'none'`
 * means no other site can put the approval screen or the connect page in a frame.
 * `SameSite=Lax` already makes framed clickjacking impractical (a Lax cookie is not
 * sent into a third-party frame), so this is defence in depth, sent as a header
 * alongside `X-Frame-Options: DENY` for browsers that honour only the older one.
 *
 * `formActionSources` exists for one page. Chrome applies `form-action` to the
 * redirect that follows a form post as well as to the post itself, and pressing
 * Approve on the OAuth screen redirects to the client's own callback. That page
 * adds the callback's origin (see `src/auth/oauth.ts`); every other page is
 * `'self'` only.
 */
export function contentSecurityPolicy(formActionSources: string[] = []): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action ${["'self'", ...formActionSources].join(" ")}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The policy every page but the OAuth approval screen carries. */
export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

/**
 * The `<meta>` copy of a policy. Browsers ignore `frame-ancestors` there (and log
 * a warning), so it is left to the header.
 */
export function metaContentSecurityPolicy(policy: string = CONTENT_SECURITY_POLICY): string {
  return policy
    .split("; ")
    .filter((directive) => !directive.startsWith("frame-ancestors"))
    .join("; ");
}

/** Escapes text for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root { color-scheme: light dark; --fg: #000; --bg: #fff; --muted: #555; --line: #000; --soft: #ddd; }
@media (prefers-color-scheme: dark) { :root { --fg: #fff; --bg: #000; --muted: #999; --line: #fff; --soft: #333; } }
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--fg); }
body { margin: 0; padding: clamp(1.5rem, 6vw, 5rem); font: 16px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
main { max-width: 40rem; }
.wordmark { display: inline-block; font-size: 1rem; letter-spacing: -0.02em; text-decoration: none; color: inherit; margin-bottom: 2.5rem; }
.wordmark:hover { text-decoration: underline; }
h1 { font-size: clamp(1.6rem, 4vw, 2.2rem); font-weight: 500; letter-spacing: -0.03em; line-height: 1.1; margin: 0 0 0.75rem; }
h2 { font-size: 1rem; font-weight: 500; margin: 2.5rem 0 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--soft); }
h3 { font-size: 1rem; font-weight: 500; margin: 1.5rem 0 0.5rem; }
p, li { margin: 0 0 1rem; }
ul, ol { padding-left: 1.25rem; }
a { color: inherit; text-decoration: underline; text-underline-offset: 0.2em; text-decoration-thickness: 1px; }
a:hover, a:focus-visible { text-decoration-thickness: 2px; outline: none; }
code { font: inherit; }
pre { margin: 0 0 1rem; padding: 0.75rem 0; border-top: 1px solid var(--soft); border-bottom: 1px solid var(--soft); overflow-x: auto; font-size: 0.9rem; line-height: 1.5; }
.card { margin: 0 0 1.5rem; }
.muted { color: var(--muted); }
.small { font-size: 0.85rem; }
label { display: block; margin: 1.25rem 0 0.4rem; }
input[type=text], input[type=password], textarea { display: block; width: 100%; padding: 0.6rem 0.7rem; border: 1px solid var(--line); border-radius: 0; background: transparent; color: inherit; font: inherit; }
input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--line); outline-offset: 2px; }
textarea { min-height: 9rem; }
button, .button { display: inline-block; margin-top: 1.25rem; padding: 0.6rem 1.1rem; border: 1px solid var(--line); border-radius: 0; background: var(--fg); color: var(--bg); font: inherit; cursor: pointer; text-decoration: none; }
button:hover { background: transparent; color: var(--fg); }
button.quiet { background: transparent; color: var(--fg); margin-top: 0; padding: 0.3rem 0.7rem; font-size: 0.85rem; }
.scopes { display: flex; flex-wrap: wrap; gap: 1.25rem; margin: 0.4rem 0; }
.scopes label { display: flex; gap: 0.5rem; align-items: center; margin: 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; margin: 0 0 1rem; }
th, td { border-bottom: 1px solid var(--soft); padding: 0.5rem 0.75rem 0.5rem 0; text-align: left; vertical-align: top; }
th { font-weight: 500; color: var(--muted); white-space: nowrap; }
.banner { margin: 0 0 1.5rem; padding: 0.6rem 0 0.6rem 0.9rem; border-left: 3px solid var(--line); }
.banner.ok::before { content: "ok: "; color: var(--muted); }
.banner.warn::before { content: "note: "; color: var(--muted); }
.banner.err::before { content: "error: "; color: var(--muted); }
.kv { display: grid; grid-template-columns: minmax(9rem, max-content) 1fr; gap: 0.35rem 1.25rem; margin: 0 0 1.5rem; }
.kv div:nth-child(odd) { color: var(--muted); }
nav { font-size: 0.9rem; margin: 0 0 2rem; }
nav a { margin-right: 1.25rem; }
footer { max-width: 40rem; margin-top: 4rem; font-size: 0.85rem; color: var(--muted); }
.bookmarklet { display: inline-block; padding: 0.4rem 0.8rem; border: 1px dashed var(--line); text-decoration: none; }
`.trim();

/** Everything a page needs besides its body. */
export interface PageOptions {
  /** Text for `<title>`; also the `<h1>` unless {@link PageOptions.heading} differs. */
  title: string;
  /** Optional `<h1>`; defaults to {@link PageOptions.title}. */
  heading?: string;
  /** One line under the heading. */
  subtitle?: string;
  /** Links for the nav row, as `[href, label]`. */
  nav?: Array<[string, string]>;
  /** Already-escaped HTML. */
  body: string;
  /**
   * Extra `form-action` sources for this page's `<meta>` policy. Send the same
   * {@link contentSecurityPolicy} as the header, or the header blocks the post anyway.
   */
  formActionSources?: string[];
}

/** Wraps body HTML in the shared document shell (CSP, inline CSS, footer disclaimer). */
export function page(options: PageOptions): string {
  const nav = options.nav?.length
    ? `<nav>${options.nav
        .map(([href, label]) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
        .join("")}</nav>`
    : "";
  const subtitle = options.subtitle ? `<p class="muted">${escapeHtml(options.subtitle)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(metaContentSecurityPolicy(contentSecurityPolicy(options.formActionSources)))}">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(options.title)} - weworking</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<a class="wordmark" href="/">weworking</a>
${nav}
<h1>${escapeHtml(options.heading ?? options.title)}</h1>
${subtitle}
${options.body}
<footer>Unofficial. Not affiliated with WeWork. Bookings made through this deployment spend the operator's own credits.</footer>
</main>
</body>
</html>`;
}

/** A coloured message box. `text` is escaped here. */
export function banner(kind: "ok" | "warn" | "err", text: string): string {
  return `<div class="banner ${kind}">${escapeHtml(text)}</div>`;
}

/** A definition-list-ish grid of label/value pairs. Values are escaped. */
export function keyValues(rows: Array<[string, unknown]>): string {
  return `<div class="kv">${rows
    .map(([key, value]) => `<div>${escapeHtml(key)}</div><div>${escapeHtml(value)}</div>`)
    .join("")}</div>`;
}

/** An HTML response with the CSP as a real header as well as the meta tag. */
export function htmlResponse(html: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...headers,
    },
  });
}
