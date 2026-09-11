/**
 * The OpenAPI 3.1 description of `/api/*`, generated from the same zod schemas the
 * routes validate with.
 *
 * Generated, not hand-written, on purpose: a hand-kept document drifts, and this one is
 * what agent frameworks and `curl`-wielding humans read. `z.toJSONSchema` (zod 4) emits
 * draft-2020-12, which is exactly the dialect OpenAPI 3.1 embeds — so the schemas drop
 * straight in with no translation layer.
 *
 * Two security schemes are advertised because the worker accepts both credentials
 * (build spec §8): a static `Bearer` token, and OAuth 2.1 authorization code + PKCE via
 * `@cloudflare/workers-oauth-provider`. Reads need the `read` scope, writes need `write`.
 */

import { Hono } from "hono";
import type { ZodType } from "zod";
import { z } from "zod";
import { type Env, parseConfig, VERSION } from "../env";
import {
  cancelBookingInput,
  cancelBookingOutput,
  createBookingInput,
  createBookingOutput,
  errorOutput,
  listBookingsInput,
  listBookingsOutput,
  listLocationsInput,
  listLocationsOutput,
  searchAvailabilityInput,
  searchAvailabilityOutput,
  whoamiOutput,
} from "../mcp/schemas";

/** JSON Schema for an OpenAPI 3.1 document: draft-2020-12, with the `$schema` key dropped. */
function jsonSchema(schema: ZodType, io: "input" | "output"): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12", io }) as Record<
    string,
    unknown
  >;
  // OpenAPI 3.1 declares the dialect once, at document level.
  delete generated.$schema;
  return generated;
}

/**
 * Turns an object schema into OpenAPI `parameters` for a query string.
 *
 * Query values arrive as strings and `src/http/api.ts` coerces them before validation,
 * so the *documented* type is the JSON type (`integer`, `boolean`), which is what a
 * client generator needs in order to serialise them correctly.
 */
function queryParameters(schema: ZodType): Array<Record<string, unknown>> {
  const document = jsonSchema(schema, "input");
  const properties = (document.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((document.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => {
    const { description, ...rest } = property;
    const parameter: Record<string, unknown> = {
      name,
      in: "query",
      required: required.has(name),
      schema: rest,
    };
    if (typeof description === "string") parameter.description = description;
    return parameter;
  });
}

function jsonContent(schema: ZodType, io: "input" | "output"): Record<string, unknown> {
  return { "application/json": { schema: jsonSchema(schema, io) } };
}

/** The error envelope, reused by every failure response. */
const errorResponse = (description: string): Record<string, unknown> => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

/** The failure responses every route can produce. */
const commonErrors = {
  "400": errorResponse(
    "Validation failed, or the quote was invalid (code VALIDATION / QUOTE_INVALID).",
  ),
  "401": errorResponse("No credential, or it did not validate (code UNAUTHORIZED)."),
  "403": errorResponse(
    "Missing scope, or writes are disabled (code FORBIDDEN_SCOPE / WRITE_DISABLED).",
  ),
  "429": errorResponse(
    "A booking cap was hit, or WeWork rate-limited us (code CAP_EXCEEDED / UPSTREAM_RATE_LIMITED).",
  ),
  "502": errorResponse("WeWork rejected or failed the request (code UPSTREAM_*)."),
  "503": errorResponse(
    "No usable WeWork session is connected (code SESSION_MISSING / SESSION_EXPIRED).",
  ),
} as const;

/**
 * Builds the OpenAPI 3.1 document.
 *
 * @param baseUrl absolute origin of this deployment — becomes the single `servers` entry
 *   and the base for the OAuth endpoints
 */
export function openapiDocument(baseUrl: string): Record<string, unknown> {
  const origin = baseUrl.replace(/\/+$/, "");
  return {
    openapi: "3.1.0",
    info: {
      title: "weworking",
      version: VERSION,
      summary: "Unofficial WeWork hot-desk search and booking for AI agents.",
      description: [
        "Unofficial, self-hosted API over WeWork's private member API. Not affiliated with or endorsed by WeWork; it acts as the operator's own WeWork member and spends that account's real credits.",
        "",
        "Dates are `YYYY-MM-DD` and times are `HH:MM`, **local wall clock at the building**, snapped to 30-minute boundaries. Responses carry both local (`startLocal`) and true-UTC (`startUtc`) instants.",
        "",
        "`POST /api/bookings` accepts only a signed `quote` from `GET /api/availability`: it is a capability token that pins the space, the window and the price, and it expires (default 10 minutes).",
        "",
        "Request parameters are `snake_case`; response fields are `camelCase`.",
      ].join("\n"),
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: origin, description: "This deployment" }],
    security: [{ bearerAuth: ["read"] }, { oauth2: ["read"] }],
    tags: [
      { name: "discovery", description: "Who am I, and what can this deployment do." },
      { name: "locations", description: "Finding WeWork buildings." },
      { name: "availability", description: "Searching desks and issuing quotes." },
      { name: "bookings", description: "Creating, listing and cancelling bookings." },
    ],
    paths: {
      "/api/whoami": {
        get: {
          operationId: "whoami",
          tags: ["discovery"],
          summary: "Profile, credits, session state, scopes and caps.",
          description:
            "Call this first to find out whether a WeWork session is connected and what this credential may do. Never returns a WeWork token.",
          security: [{ bearerAuth: ["read"] }, { oauth2: ["read"] }],
          responses: {
            "200": {
              description: "Deployment and member status.",
              content: jsonContent(whoamiOutput, "output"),
            },
            ...commonErrors,
          },
        },
      },
      "/api/locations": {
        get: {
          operationId: "listLocations",
          tags: ["locations"],
          summary: "Find WeWork buildings by city, free text or coordinates.",
          description: "At least one of `query`, `city`, or `lat` + `lng` is required.",
          security: [{ bearerAuth: ["read"] }, { oauth2: ["read"] }],
          parameters: queryParameters(listLocationsInput),
          responses: {
            "200": {
              description: "Matching buildings.",
              content: jsonContent(listLocationsOutput, "output"),
            },
            "404": errorResponse("No city or building matched (code NOT_FOUND)."),
            ...commonErrors,
          },
        },
      },
      "/api/availability": {
        get: {
          operationId: "searchAvailability",
          tags: ["availability"],
          summary: "Search hot desks for one local date and issue a quote per option.",
          description:
            "Exactly one of `location_id` or `city` is required. Each result carries an opaque `quote` to pass to `POST /api/bookings` verbatim; they all expire at `quoteExpiresAt`. Only `space_type=desk` is implemented.",
          security: [{ bearerAuth: ["read"] }, { oauth2: ["read"] }],
          parameters: queryParameters(searchAvailabilityInput),
          responses: {
            "200": {
              description: "Bookable desks, cheapest first, each with a signed quote.",
              content: jsonContent(searchAvailabilityOutput, "output"),
            },
            "404": errorResponse("No building matched (code NOT_FOUND)."),
            ...commonErrors,
          },
        },
      },
      "/api/bookings": {
        get: {
          operationId: "listBookings",
          tags: ["bookings"],
          summary: "List bookings in a local date range.",
          security: [{ bearerAuth: ["read"] }, { oauth2: ["read"] }],
          parameters: queryParameters(listBookingsInput),
          responses: {
            "200": {
              description: "Bookings in range.",
              content: jsonContent(listBookingsOutput, "output"),
            },
            ...commonErrors,
          },
        },
        post: {
          operationId: "createBooking",
          tags: ["bookings"],
          summary: "Book the desk described by a quote. Spends real WeWork credits.",
          description:
            "Confirm the slot and its credit cost with the user first. Send `idempotency_key` so a retry cannot double-book, or `dry_run: true` to validate, re-price and check the caps without booking. The price is re-checked against WeWork immediately before booking; any change raises `BOOKING_REFUSED`.",
          security: [{ bearerAuth: ["write"] }, { oauth2: ["write"] }],
          requestBody: { required: true, content: jsonContent(createBookingInput, "input") },
          responses: {
            "201": { description: "Booked.", content: jsonContent(createBookingOutput, "output") },
            "200": {
              description: "Dry run: nothing was booked and no allowance was used.",
              content: jsonContent(createBookingOutput, "output"),
            },
            "409": errorResponse(
              "The quote expired, the slot went away, or WeWork refused the booking (code QUOTE_EXPIRED / NOT_AVAILABLE / BOOKING_REFUSED).",
            ),
            ...commonErrors,
          },
        },
      },
      "/api/bookings/{id}": {
        delete: {
          operationId: "cancelBooking",
          tags: ["bookings"],
          summary: "Cancel a booking. Destructive.",
          description:
            "Credits are refunded only before the booking's `cancelDeadlineLocal`. `dry_run=true` reports what would be cancelled without touching it.",
          security: [{ bearerAuth: ["write"] }, { oauth2: ["write"] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "`bookingId` from GET /api/bookings.",
              schema: { type: "string" },
            },
            ...queryParameters(cancelBookingInput).filter(
              (parameter) => parameter.name !== "booking_id",
            ),
          ],
          responses: {
            "200": {
              description: "Cancelled.",
              content: jsonContent(cancelBookingOutput, "output"),
            },
            "404": errorResponse("No booking with that id (code NOT_FOUND)."),
            ...commonErrors,
          },
        },
      },
      "/api/openapi.json": {
        get: {
          operationId: "getOpenapi",
          tags: ["discovery"],
          summary: "This document.",
          security: [],
          responses: { "200": { description: "The OpenAPI 3.1 document." } },
        },
      },
      "/healthz": {
        get: {
          operationId: "healthz",
          tags: ["discovery"],
          summary: "Public liveness and configuration probe. Contains no secrets.",
          security: [],
          responses: { "200": { description: "Worker status." } },
        },
      },
    },
    components: {
      schemas: {
        Error: jsonSchema(errorOutput, "output"),
      },
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "A static token from the operator's `AUTH_TOKENS` secret. Scopes are fixed per token.",
        },
        oauth2: {
          type: "oauth2",
          description:
            "OAuth 2.1 with PKCE, served by this worker. Dynamic client registration is available at /oauth/register; protected-resource metadata at /.well-known/oauth-protected-resource.",
          flows: {
            authorizationCode: {
              authorizationUrl: `${origin}/oauth/authorize`,
              tokenUrl: `${origin}/oauth/token`,
              refreshUrl: `${origin}/oauth/token`,
              scopes: {
                read: "Search locations, availability and bookings.",
                write: "Create and cancel bookings.",
                admin: "Manage the stored WeWork session and read the audit log.",
              },
            },
          },
        },
      },
    },
  };
}

/**
 * The public routes that publish the document: `GET /openapi.json` and a tiny
 * `GET /docs` viewer.
 *
 * Mount at `/api` **before** the authentication middleware — the document is public by
 * design (build spec §9), so a client can discover how to authenticate.
 *
 * @example app.route("/api", openapiRoutes());
 */
export function openapiRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/openapi.json", (c) => c.json(openapiDocument(documentBaseUrl(c.req.raw, c.env))));

  // Deliberately dependency-free: one <script> from a CDN would break any deployment
  // with a strict CSP, and this page only exists as a convenience.
  routes.get("/docs", (c) => {
    const base = documentBaseUrl(c.req.raw, c.env);
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>weworking API</title>` +
        `<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem}` +
        `code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}</style></head><body>` +
        `<h1>weworking</h1>` +
        `<p>Unofficial WeWork hot-desk search and booking. Not affiliated with WeWork.</p>` +
        `<ul>` +
        `<li>OpenAPI 3.1: <a href="${base}/api/openapi.json"><code>${base}/api/openapi.json</code></a></li>` +
        `<li>MCP endpoint: <code>${base}/mcp</code></li>` +
        `<li>Health: <a href="${base}/healthz"><code>${base}/healthz</code></a></li>` +
        `<li>Connect a WeWork session: <code>${base}/admin/connect</code></li>` +
        `</ul>` +
        `<p>Reads need the <code>read</code> scope; booking and cancelling need <code>write</code>.</p>` +
        `</body></html>`,
    );
  });

  return routes;
}

/** `PUBLIC_BASE_URL` when configured, otherwise this request's own origin. */
function documentBaseUrl(request: Request, env: Env): string {
  try {
    const { publicBaseUrl } = parseConfig(env);
    if (publicBaseUrl) return publicBaseUrl;
  } catch {
    // Broken configuration must not stop the document being served; `/healthz` reports it.
  }
  return new URL(request.url).origin;
}
