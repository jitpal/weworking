/**
 * Indirection for the one function the admin pages need from the WeWork auth module
 * (§11.1 of the build spec): `parseManualSession`.
 *
 * It existed because `src/wework/auth/index.ts` was being written concurrently. That
 * barrel now exists, so this file is a plain re-export — the *real* implementation is
 * used in production and in tests. It stays as the single seam the admin tests mock
 * (`vi.mock("../../src/auth/_manual-shim")`), which is why it is not deleted; point
 * `src/http/admin.ts` straight at `"../wework/auth"` and delete it if you would
 * rather have one less file.
 */

export { decodeJwtPayload, parseManualSession } from "../wework/auth";
