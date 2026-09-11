/**
 * Scope enforcement for the MCP tool handlers.
 *
 * This is a deliberate five-line duplicate of `requireScope` from
 * `src/auth/guard.ts` (owned by the auth engineer, build spec §11.3). The tools layer
 * must not import from `src/auth` — it is built and tested independently, and a tool
 * handler is the last line of defence: the OAuth provider validates the *token* but
 * never the scope, so whoever answers a write tool has to check it.
 *
 * Keep the two implementations behaviourally identical: same code, same status, same
 * hint. If the shared guard ever grows (per-tool scopes, say), this file follows it.
 */

import type { Actor, Scope } from "../core/types";
import { AppError } from "../errors";

/**
 * Asserts that `actor` carries `scope`.
 *
 * @throws {AppError} `FORBIDDEN_SCOPE` (403) naming the missing scope
 */
export function requireScope(actor: Actor, scope: Scope): void {
  if (!actor.scopes.includes(scope)) {
    throw new AppError("FORBIDDEN_SCOPE", `This credential lacks the '${scope}' scope.`, {
      hint: `Stop and tell the user their token is missing the '${scope}' scope; the deployment operator must issue one that has it. Do not retry.`,
    });
  }
}

/** Non-throwing form, for deciding whether to advertise a capability. */
export function hasScope(actor: Actor, scope: Scope): boolean {
  return actor.scopes.includes(scope);
}
