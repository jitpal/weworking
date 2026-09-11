/**
 * The header block every members.wework.com API call needs.
 *
 * WeWork's gateway is fussy in ways that are not obvious from a single capture:
 *
 * - the Auth0 access token goes in **two** headers, `Authorization` *and*
 *   `WeWorkAuth`, both with the `Bearer ` prefix. Omitting `WeWorkAuth` returns a
 *   200 with an empty payload rather than a 401, which is much harder to debug;
 * - `WeWorkUUID` must carry the `https://wework.com/user_uuid` claim from the
 *   access token, not the Auth0 `sub`;
 * - `Request-Source` and `fe-pg` identify the calling front end. The booking and
 *   cancel endpoints behave differently per source: cancel is only accepted from
 *   the `MemberWeb` source with the `your-bookings` page tag, which is why there is
 *   a {@link HeaderVariant} rather than one constant block.
 *
 * Nothing in here is logged. `redact()` masks `authorization`, `weworkauth` and
 * `cookie` by name, but prefer not to log headers at all.
 */

/** The ondemand iOS app source string, used by every read and by booking. */
export const REQUEST_SOURCE_ONDEMAND = "com.wework.ondemand/WorkplaceOne/Prod/iOS/2.71.0(26.1)";

/** The member web source string. Required by `POST /common-booking/cancel`. */
export const REQUEST_SOURCE_MEMBER_WEB = "MemberWeb/WorkplaceOne/Prod";

/** Default front-end page tag. */
export const FE_PG_DASHBOARD = "/workplaceone/content2/dashboard";

/** Front-end page tag the cancel endpoint expects. */
export const FE_PG_YOUR_BOOKINGS = "/workplaceone/content2/your-bookings";

/** Origin and Referer for every members API call. */
export const MEMBERS_ORIGIN = "https://members.wework.com";

/** Base URL for the members API. */
export const MEMBERS_API_BASE = "https://members.wework.com/workplaceone/api";

/** Value of the `WeWorkMemberType` header. `2` is an ordinary member. */
export const WEWORK_MEMBER_TYPE = "2";

/**
 * A current desktop Safari user agent.
 *
 * Auth0's bot protection scores requests partly on the user agent, and a Workers
 * default (`undici`-ish or absent) is an immediate tell. Safari on macOS is chosen
 * over Chrome because Chrome's UA implies client hints (`Sec-CH-UA-*`) that we do
 * not send, which is itself inconsistent.
 */
export const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

/**
 * Which front end we are claiming to be.
 *
 * - `"default"` — the ondemand app source, for reads, quote and booking.
 * - `"cancel"` — the member web source plus the `your-bookings` page tag.
 */
export type HeaderVariant = "default" | "cancel";

/** Arguments for {@link weworkHeaders}. */
export interface WeWorkHeaderArgs {
  /** Raw Auth0 access token, with no `Bearer ` prefix. */
  accessToken: string;
  /** The `https://wework.com/user_uuid` claim. */
  userUuid: string;
  variant?: HeaderVariant;
  /** Overrides {@link DESKTOP_USER_AGENT}. */
  userAgent?: string;
  /** Set to `false` for GET requests, which carry no body. */
  json?: boolean;
  /** Merged last, so a caller can add or override a single header. */
  extra?: Record<string, string>;
}

/**
 * Builds the full header block for a members API call.
 *
 * @example
 * weworkHeaders({ accessToken, userUuid, variant: "cancel" })["Request-Source"];
 * // "MemberWeb/WorkplaceOne/Prod"
 */
export function weworkHeaders(args: WeWorkHeaderArgs): Record<string, string> {
  const bearer = `Bearer ${args.accessToken}`;
  const variant = args.variant ?? "default";

  const headers: Record<string, string> = {
    Authorization: bearer,
    WeWorkAuth: bearer,
    WeWorkUUID: args.userUuid,
    WeWorkMemberType: WEWORK_MEMBER_TYPE,
    "Request-Source": variant === "cancel" ? REQUEST_SOURCE_MEMBER_WEB : REQUEST_SOURCE_ONDEMAND,
    "fe-pg": variant === "cancel" ? FE_PG_YOUR_BOOKINGS : FE_PG_DASHBOARD,
    Origin: MEMBERS_ORIGIN,
    Referer: `${MEMBERS_ORIGIN}/`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": args.userAgent ?? DESKTOP_USER_AGENT,
  };

  if (args.json !== false) headers["Content-Type"] = "application/json";
  return args.extra ? { ...headers, ...args.extra } : headers;
}
