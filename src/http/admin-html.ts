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

/** The policy every page carries. `form-action 'self'` keeps a password post local. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";

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
:root { color-scheme: light dark; --fg: #15181d; --muted: #5d6570; --bg: #fbfbfc; --card: #ffffff; --line: #e2e5ea; --accent: #1d4ed8; --warn: #8a5300; --warn-bg: #fff6e5; --ok: #0f6b3f; --ok-bg: #e8f6ee; --err: #a1212d; --err-bg: #fdecee; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e8eaee; --muted: #9aa3b0; --bg: #14161a; --card: #1c1f25; --line: #2c313a; --accent: #8fb0ff; --warn: #f0c070; --warn-bg: #2d2414; --ok: #79d3a3; --ok-bg: #14291d; --err: #ff9aa4; --err-bg: #2c1619; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--fg); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 46rem; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 1.8rem 0 .5rem; }
h3 { font-size: .95rem; margin: 1.2rem 0 .4rem; }
p, li { margin: .5rem 0; }
a { color: var(--accent); }
code, pre, textarea, input[type=password], input[type=text] { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: .05rem .3rem; font-size: .85em; }
pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: .7rem .8rem; overflow-x: auto; font-size: .8rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem; margin: 1rem 0; }
.muted { color: var(--muted); }
.small { font-size: .85rem; }
label { display: block; font-weight: 600; margin: .9rem 0 .3rem; }
input[type=password], input[type=text], textarea { width: 100%; padding: .55rem .6rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font-size: .9rem; }
textarea { min-height: 9rem; }
button { margin-top: 1rem; padding: .55rem 1.1rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font-size: .95rem; font-weight: 600; cursor: pointer; }
.scopes { display: flex; flex-wrap: wrap; gap: .9rem; margin: .4rem 0; }
.scopes label { display: flex; gap: .35rem; align-items: center; font-weight: 400; margin: 0; }
table { border-collapse: collapse; width: 100%; font-size: .84rem; }
th, td { border-bottom: 1px solid var(--line); padding: .35rem .5rem; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
.banner { border-radius: 8px; padding: .6rem .8rem; margin: 1rem 0; font-size: .9rem; }
.banner.ok { background: var(--ok-bg); color: var(--ok); }
.banner.warn { background: var(--warn-bg); color: var(--warn); }
.banner.err { background: var(--err-bg); color: var(--err); }
.kv { display: grid; grid-template-columns: minmax(8rem, max-content) 1fr; gap: .3rem .9rem; font-size: .9rem; }
.kv div:nth-child(odd) { color: var(--muted); }
nav { font-size: .85rem; margin-bottom: 1.5rem; }
nav a { margin-right: .9rem; }
footer { margin-top: 2.5rem; font-size: .78rem; color: var(--muted); border-top: 1px solid var(--line); padding-top: .8rem; }
.bookmarklet { display: inline-block; padding: .4rem .8rem; border: 1px dashed var(--accent); border-radius: 8px; font-weight: 600; text-decoration: none; }
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
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CONTENT_SECURITY_POLICY)}">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(options.title)} — weworking</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${nav}
<h1>${escapeHtml(options.heading ?? options.title)}</h1>
${subtitle}
${options.body}
<footer>weworking — unofficial, not affiliated with or endorsed by WeWork. It spends your credits with your own session.</footer>
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
      ...headers,
    },
  });
}
