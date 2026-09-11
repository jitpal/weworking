/**
 * One error type for the whole worker.
 *
 * Every failure an agent can cause or recover from is an {@link AppError} with a
 * stable machine-readable {@link ErrorCode}, an HTTP status, and — crucially — a
 * `hint` written *for the agent*: what to do next, in one sentence. MCP tools
 * surface `{ code, message, hint }` with `isError: true`; REST routes surface the
 * same object as the JSON body.
 *
 * Never put a token, password, cookie or raw upstream body in `message` or
 * `details`. Run anything from upstream through `redact()` first.
 */

/**
 * Stable error taxonomy. Treat these as part of the public API: agents and the
 * OpenAPI document branch on them, so rename nothing — only add.
 */
export type ErrorCode =
  /** No credential presented, or it did not validate. */
  | "UNAUTHORIZED"
  /** Credential is valid but lacks the scope this operation needs. */
  | "FORBIDDEN_SCOPE"
  /** `WRITE_ENABLED` is false — the deployment-wide kill switch for mutations. */
  | "WRITE_DISABLED"
  /** No WeWork session stored; a human must connect one. */
  | "SESSION_MISSING"
  /** The stored WeWork session expired and could not be refreshed. */
  | "SESSION_EXPIRED"
  /** WeWork/Auth0 rejected our credential (401/403 on the token itself). */
  | "UPSTREAM_AUTH"
  /** Auth0 bot protection: `requires_verification`, CAPTCHA, or a Cloudflare block. */
  | "UPSTREAM_BLOCKED"
  /** Upstream returned 429. */
  | "UPSTREAM_RATE_LIMITED"
  /** Any other non-success or unparseable upstream response. */
  | "UPSTREAM_ERROR"
  /** Quote signature, version or account did not verify. */
  | "QUOTE_INVALID"
  /** Quote signature verified but `exp` has passed — search again. */
  | "QUOTE_EXPIRED"
  /** A configured daily/weekly/credit cap would be exceeded. */
  | "CAP_EXCEEDED"
  /** The slot is no longer bookable (someone took it, or the building is closed). */
  | "NOT_AVAILABLE"
  /** WeWork accepted the request but declined the booking (HTTP 200 with a refusal). */
  | "BOOKING_REFUSED"
  /** The referenced booking, location or space does not exist. */
  | "NOT_FOUND"
  /** Phase 1 implements hot desks only. */
  | "UNSUPPORTED_SPACE_TYPE"
  /** Caller input (or deployment configuration) failed validation. */
  | "VALIDATION";

/** Default HTTP status for each {@link ErrorCode}. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN_SCOPE: 403,
  WRITE_DISABLED: 403,
  SESSION_MISSING: 503,
  SESSION_EXPIRED: 503,
  UPSTREAM_AUTH: 502,
  UPSTREAM_BLOCKED: 502,
  UPSTREAM_RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  QUOTE_INVALID: 400,
  QUOTE_EXPIRED: 409,
  CAP_EXCEEDED: 429,
  NOT_AVAILABLE: 409,
  BOOKING_REFUSED: 409,
  NOT_FOUND: 404,
  UNSUPPORTED_SPACE_TYPE: 400,
  VALIDATION: 400,
};

/** Default agent-facing hint for each {@link ErrorCode}. Override per call site when you can be more specific. */
const HINT_BY_CODE: Record<ErrorCode, string> = {
  UNAUTHORIZED: "Send a valid bearer token, or complete the OAuth flow advertised by the WWW-Authenticate header.",
  FORBIDDEN_SCOPE: "This credential is read-only. Ask the operator for a token with the 'write' scope.",
  WRITE_DISABLED: "Bookings are disabled on this deployment. Ask the operator to set WRITE_ENABLED=true.",
  SESSION_MISSING: "No WeWork session is connected. Ask the user to open <base>/admin/connect and paste their token.",
  SESSION_EXPIRED: "The WeWork session expired and could not be refreshed. Ask the user to reconnect at <base>/admin/connect.",
  UPSTREAM_AUTH: "WeWork rejected the stored session. Ask the user to reconnect at <base>/admin/connect.",
  UPSTREAM_BLOCKED: "WeWork's login protection blocked an automated sign-in. Ask the user to log in with their own browser and paste the token at <base>/admin/connect.",
  UPSTREAM_RATE_LIMITED: "WeWork is rate-limiting us. Wait a minute and retry once; do not retry in a loop.",
  UPSTREAM_ERROR: "WeWork returned an unexpected response. Retry once; if it persists, report it to the user rather than retrying.",
  QUOTE_INVALID: "Quotes cannot be constructed or edited. Call search_availability and pass a quote from its result verbatim.",
  QUOTE_EXPIRED: "This quote has expired. Call search_availability again and book from a fresh result.",
  CAP_EXCEEDED: "A configured booking cap would be exceeded. Tell the user the limit instead of retrying.",
  NOT_AVAILABLE: "That slot is no longer available. Search again and offer the user the remaining options.",
  BOOKING_REFUSED: "WeWork declined the booking. Report the reason to the user; do not retry the same quote.",
  NOT_FOUND: "Check the id. Use list_bookings or list_locations to get valid ids.",
  UNSUPPORTED_SPACE_TYPE: "Only hot desks (space_type 'desk') are supported right now. Tell the user meeting rooms are not available.",
  VALIDATION: "Fix the arguments and call again; the message names the offending field.",
};

/** Optional extras when constructing an {@link AppError}. */
export interface AppErrorOptions {
  /** Overrides the default status for the code. */
  status?: number;
  /** Overrides the default agent-facing hint. */
  hint?: string;
  /** Structured, already-redacted context. Safe to show an agent. */
  details?: unknown;
  /** The underlying error, kept for logs only — never serialised to a client. */
  cause?: unknown;
}

/**
 * The only error type this codebase throws deliberately.
 *
 * @example
 * throw new AppError("QUOTE_EXPIRED", "This quote expired 4 minutes ago.");
 */
export class AppError extends Error {
  /** Stable machine-readable code. */
  readonly code: ErrorCode;
  /** HTTP status to respond with. */
  readonly status: number;
  /** One sentence telling the calling agent what to do next. */
  readonly hint?: string;
  /** Already-redacted structured context. */
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.hint = options.hint ?? HINT_BY_CODE[code];
    if (options.details !== undefined) this.details = options.details;
  }
}

/** Narrowing type guard. Use instead of `instanceof` across module boundaries. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError || (value instanceof Error && value.name === "AppError" && "code" in value);
}

/** The wire shape for an error, identical for MCP tool results and REST bodies. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
    details?: unknown;
  };
}

/**
 * Converts any thrown value into the wire error shape. Unknown throwables become
 * `UPSTREAM_ERROR` with a generic message — we never leak an arbitrary `message`,
 * because it may contain an upstream body.
 */
export function toErrorBody(err: unknown): ErrorBody {
  if (isAppError(err)) {
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    if (err.hint !== undefined) body.error.hint = err.hint;
    if (err.details !== undefined) body.error.details = err.details;
    return body;
  }
  return {
    error: {
      code: "UPSTREAM_ERROR",
      message: "An unexpected internal error occurred.",
      hint: HINT_BY_CODE.UPSTREAM_ERROR,
    },
  };
}

/** The HTTP status to respond with for any thrown value. */
export function statusFor(err: unknown): number {
  return isAppError(err) ? err.status : 500;
}
