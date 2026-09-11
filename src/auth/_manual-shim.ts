/**
 * TEMP: replace at integration.
 *
 * `src/http/admin.ts` needs `parseManualSession` from the WeWork auth module
 * (§11.1 of the build spec), whose barrel `src/wework/auth/index.ts` does not exist
 * yet — only the implementation file `src/wework/auth/manual.ts` does. This module
 * is the single place that knows that, so the admin pages can import a stable path.
 *
 * ## Integration (one edit)
 *
 * Once `src/wework/auth/index.ts` re-exports it, change the line below to
 *
 * ```ts
 * export { parseManualSession } from "../wework/auth";
 * ```
 *
 * …or point `src/http/admin.ts` at `"../wework/auth"` and delete this file. The
 * admin tests mock *this* module path, so they keep passing either way.
 */

// TEMP: replace at integration with "../wework/auth".
export { decodeJwtPayload, parseManualSession } from "../wework/auth/manual";
