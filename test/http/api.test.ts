/**
 * The REST front door, the OpenAPI document and `/healthz`.
 *
 * Like the MCP test, this builds its own Hono app rather than going through
 * `src/index.ts`: a one-line middleware injects the `Actor` that the real guard would
 * set, so these tests cover routing, query-string coercion, validation, status codes and
 * the error envelope without dragging OAuth in.
 *
 * The contract being pinned down here is the one docs/API.md promises: a REST body and
 * the matching MCP `structuredContent` are the same JSON.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Actor, Config } from "../../src/core/types";
import type { Env } from "../../src/env";
import { apiRoutes } from "../../src/http/api";
import { healthRoutes } from "../../src/http/health";
import { openapiDocument, openapiRoutes } from "../../src/http/openapi";
import {
  createHarness,
  type FakeApiScript,
  type FakeSessionScript,
  firstQuote,
  type Harness,
  makeBooking,
  READ_ONLY_ACTOR,
  READ_WRITE_ACTOR,
} from "../core/fakes";

const ORIGIN = "http://localhost";

/** Test bindings: enough for `parseConfig` to succeed inside the openapi/health routes. */
const TEST_ENV = {
  QUOTE_SIGNING_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  COOKIE_SIGNING_KEY: "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
  ADMIN_PASSWORD: "s3cret-admin-password",
  WRITE_ENABLED: "true",
  LOGIN_STRATEGY: "manual",
  PUBLIC_BASE_URL: "https://weworking.test",
} as unknown as Env;

interface TestApp {
  request(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  harness: Harness;
}

/**
 * Builds an app with `/api` mounted behind a middleware that injects `actor`, plus the
 * public health and OpenAPI routes.
 */
function buildApp(
  options: {
    actor?: Actor | null;
    apiScript?: FakeApiScript;
    sessionScript?: FakeSessionScript;
    config?: Partial<Config>;
    env?: Partial<Env>;
  } = {},
): TestApp {
  const harness = createHarness(options);
  const actor = options.actor === undefined ? READ_WRITE_ACTOR : options.actor;
  const app = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

  app.use("/api/*", async (c, next) => {
    if (actor) c.set("actor", actor);
    await next();
  });
  app.route("/api", openapiRoutes());
  app.route("/api", apiRoutes({ buildService: () => harness.service }));
  app.route("/", healthRoutes({ getSessionInfo: () => harness.session.session.getSessionInfo() }));

  const env = { ...TEST_ENV, ...options.env } as Env;

  return {
    harness,
    async request(path, init) {
      return await app.request(`${ORIGIN}${path}`, init, env);
    },
    async json(path, init) {
      const response = await app.request(`${ORIGIN}${path}`, init, env);
      return { status: response.status, body: (await response.json()) as never };
    },
  };
}

interface ErrorBody {
  error: { code: string; message: string; hint?: string; details?: unknown };
}

describe("GET /api/whoami", () => {
  it("returns the same object the MCP tool puts in structuredContent", async () => {
    const app = buildApp();
    const { status, body } = await app.json<Record<string, unknown>>("/api/whoami");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      session: { state: "valid" },
      actor: { name: "test-token", scopes: ["read", "write"] },
      caps: { maxBookingsPerDay: 1 },
      capsRemaining: { day: 1, week: 5 },
      writeEnabled: true,
    });
  });

  it("is UNAUTHORIZED when no actor was injected by the guard", async () => {
    const app = buildApp({ actor: null });
    const { status, body } = await app.json<ErrorBody>("/api/whoami");
    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /api/locations", () => {
  it("searches by city", async () => {
    const app = buildApp();
    const { status, body } = await app.json<{ locations: Array<{ locationId: string }> }>(
      "/api/locations?city=London",
    );
    expect(status).toBe(200);
    expect(body.locations.map((l) => l.locationId)).toEqual(["loc-poultry"]);
  });

  it("coerces numeric query parameters out of their string form", async () => {
    const app = buildApp();
    const { status } = await app.json("/api/locations?lat=51.5&lng=-0.09&radius_km=2&limit=5");
    expect(status).toBe(200);
    expect(app.harness.api.calls[0]).toEqual({
      method: "listLocationsByGeo",
      args: { lat: 51.5, lng: -0.09, radiusKm: 2 },
    });
  });

  it("rejects a non-numeric limit with VALIDATION naming the field", async () => {
    const app = buildApp();
    const { status, body } = await app.json<ErrorBody>("/api/locations?city=London&limit=banana");
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain("limit");
  });

  it("requires at least one search parameter", async () => {
    const app = buildApp();
    const { status, body } = await app.json<ErrorBody>("/api/locations");
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.hint).toBeTypeOf("string");
  });
});

describe("GET /api/availability", () => {
  it("returns quotes and the shared expiry", async () => {
    const app = buildApp();
    const { status, body } = await app.json<{
      results: Array<{ quote: string; startLocal: string; summary: string }>;
      quoteExpiresAt: string;
    }>("/api/availability?location_id=loc-poultry&date=2026-09-21&start_time=09:00&end_time=17:00");

    expect(status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.startLocal).toBe("2026-09-21T09:00:00");
    expect(body.results[0]?.summary).toContain("(Europe/London)");
    expect(body.quoteExpiresAt).toBe("2026-09-11T09:10:00Z");
  });

  it("rejects a malformed date before reaching upstream", async () => {
    const app = buildApp();
    const { status, body } = await app.json<ErrorBody>(
      "/api/availability?location_id=loc-poultry&date=21-09-2026",
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    expect(app.harness.api.calls).toEqual([]);
  });

  it("maps UNSUPPORTED_SPACE_TYPE to 400 with the hot-desks-only hint", async () => {
    const app = buildApp();
    const { status, body } = await app.json<ErrorBody>(
      "/api/availability?location_id=loc-poultry&date=2026-09-21&space_type=meeting_room",
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("UNSUPPORTED_SPACE_TYPE");
    expect(body.error.hint).toContain("hot desks");
  });
});

describe("POST /api/bookings", () => {
  it("books with a fresh quote and answers 201", async () => {
    const app = buildApp();
    const quote = await firstQuote(app.harness);
    const { status, body } = await app.json<{ booking: { bookingId: string }; dryRun: boolean }>(
      "/api/bookings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote, idempotency_key: "rest-1" }),
      },
    );
    expect(status).toBe(201);
    expect(body.booking.bookingId).toBe("RES-NEW");
    expect(body.dryRun).toBe(false);
  });

  it("answers 200 for a dry run, because nothing was created", async () => {
    const app = buildApp();
    const quote = await firstQuote(app.harness);
    const { status, body } = await app.json<{ dryRun: boolean; booking: { bookingId: string } }>(
      "/api/bookings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote, dry_run: true }),
      },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ dryRun: true, booking: { bookingId: "dry-run" } });
  });

  it("maps a forged quote to 400 QUOTE_INVALID", async () => {
    const app = buildApp();
    const { status, body } = await app.json<ErrorBody>("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote: "bm90LWEtcXVvdGU.AAAA" }),
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe("QUOTE_INVALID");
  });

  it("maps a read-only token to 403 FORBIDDEN_SCOPE", async () => {
    const app = buildApp({ actor: READ_ONLY_ACTOR });
    const quote = await firstQuote(app.harness);
    const { status, body } = await app.json<ErrorBody>("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote }),
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN_SCOPE");
    expect(app.harness.api.calls.filter((call) => call.method === "book")).toEqual([]);
  });

  it("maps an exhausted cap to 429 CAP_EXCEEDED with the remaining allowance", async () => {
    const app = buildApp({ sessionScript: { usedToday: 1, maxPerDay: 1 } });
    const quote = await firstQuote(app.harness);
    const { status, body } = await app.json<ErrorBody>("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote }),
    });
    expect(status).toBe(429);
    expect(body.error.code).toBe("CAP_EXCEEDED");
    expect(body.error.details).toEqual({ capsRemaining: { day: 0, week: 5 } });
  });

  it("rejects a missing body and a missing quote", async () => {
    const app = buildApp();
    const noBody = await app.json<ErrorBody>("/api/bookings", { method: "POST" });
    expect(noBody.status).toBe(400);
    expect(noBody.body.error.code).toBe("VALIDATION");

    const noQuote = await app.json<ErrorBody>("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(noQuote.status).toBe(400);
    expect(noQuote.body.error.message).toContain("quote");
  });
});

describe("GET /api/bookings and DELETE /api/bookings/:id", () => {
  it("lists bookings and coerces include_past", async () => {
    const app = buildApp({ apiScript: { bookings: [makeBooking()] } });
    const { status, body } = await app.json<{ bookings: Array<{ bookingId: string }> }>(
      "/api/bookings?from=2026-09-11&to=2026-10-11&include_past=true",
    );
    expect(status).toBe(200);
    expect(body.bookings.map((b) => b.bookingId)).toEqual(["BK-1"]);
    expect(app.harness.api.calls[0]).toEqual({
      method: "listBookings",
      args: { from: "2026-09-11", to: "2026-10-11", includePast: true },
    });
  });

  it("never leaks the raw upstream payload", async () => {
    const app = buildApp({ apiScript: { bookings: [makeBooking()] } });
    const { body } = await app.json<{ bookings: Array<Record<string, unknown>> }>("/api/bookings");
    expect(body.bookings[0]).not.toHaveProperty("raw");
  });

  it("cancels by path parameter", async () => {
    const app = buildApp({ apiScript: { bookings: [makeBooking()] } });
    const { status, body } = await app.json<{ bookingId: string; status: string }>(
      "/api/bookings/BK-1",
      { method: "DELETE" },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ bookingId: "BK-1", status: "cancelled" });
    expect(app.harness.session.cancelled).toEqual(["BK-1"]);
  });

  it("supports dry_run on cancel through the query string", async () => {
    const app = buildApp({ apiScript: { bookings: [makeBooking()] } });
    const { status, body } = await app.json<{ summary: string }>(
      "/api/bookings/BK-1?dry_run=true",
      { method: "DELETE" },
    );
    expect(status).toBe(200);
    expect(body.summary).toContain("Dry run");
    expect(app.harness.api.calls.filter((call) => call.method === "cancelBooking")).toEqual([]);
  });

  it("maps an unknown booking to 404", async () => {
    const app = buildApp({ apiScript: { bookings: [] } });
    const { status, body } = await app.json<ErrorBody>("/api/bookings/BK-nope", {
      method: "DELETE",
    });
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("refuses writes when WRITE_ENABLED is false", async () => {
    const app = buildApp({ config: { writeEnabled: false } });
    const { status, body } = await app.json<ErrorBody>("/api/bookings/BK-1", { method: "DELETE" });
    expect(status).toBe(403);
    expect(body.error.code).toBe("WRITE_DISABLED");
  });
});

describe("GET /api/openapi.json", () => {
  it("is public and describes every route", async () => {
    const app = buildApp({ actor: null });
    const { status, body } = await app.json<{ openapi: string; paths: Record<string, unknown> }>(
      "/api/openapi.json",
    );
    expect(status).toBe(200);
    expect(body.openapi).toBe("3.1.0");
    expect(Object.keys(body.paths)).toEqual(
      expect.arrayContaining([
        "/api/whoami",
        "/api/locations",
        "/api/availability",
        "/api/bookings",
        "/api/bookings/{id}",
        "/healthz",
      ]),
    );
  });

  it("advertises both bearer and OAuth 2.1 authorization-code security", async () => {
    const document = openapiDocument("https://weworking.test") as never as {
      servers: Array<{ url: string }>;
      components: {
        securitySchemes: {
          bearerAuth: { type: string; scheme: string };
          oauth2: {
            type: string;
            flows: {
              authorizationCode: {
                authorizationUrl: string;
                tokenUrl: string;
                scopes: Record<string, string>;
              };
            };
          };
        };
      };
    };
    expect(document.servers).toEqual([
      { url: "https://weworking.test", description: "This deployment" },
    ]);
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    const flow = document.components.securitySchemes.oauth2.flows.authorizationCode;
    expect(flow.authorizationUrl).toBe("https://weworking.test/oauth/authorize");
    expect(flow.tokenUrl).toBe("https://weworking.test/oauth/token");
    expect(Object.keys(flow.scopes)).toEqual(["read", "write", "admin"]);
  });

  it("derives parameter schemas from the same zod schemas the routes validate with", async () => {
    const document = openapiDocument("https://weworking.test") as never as {
      paths: Record<
        string,
        Record<string, { parameters?: Array<{ name: string; required: boolean; schema: unknown }> }>
      >;
    };
    const parameters = document.paths["/api/availability"]?.get?.parameters ?? [];
    const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
    expect([...byName.keys()]).toEqual(
      expect.arrayContaining([
        "location_id",
        "city",
        "date",
        "start_time",
        "end_time",
        "space_type",
      ]),
    );
    expect(byName.get("date")?.required).toBe(true);
    expect(byName.get("city")?.required).toBe(false);
    expect(byName.get("limit")?.schema).toMatchObject({ type: "integer", maximum: 100 });
    // JSON Schema dialects are declared once at document level in OpenAPI 3.1.
    expect(JSON.stringify(document)).not.toContain("$schema");
  });

  it("serves a dependency-free docs page", async () => {
    const app = buildApp({ actor: null });
    const response = await app.request("/api/docs");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("/api/openapi.json");
    expect(html).not.toContain("<script");
  });
});

describe("GET /healthz", () => {
  it("reports presence booleans, the session state and the kill switch — and no secrets", async () => {
    const app = buildApp();
    const { status, body } = await app.json<{
      ok: boolean;
      version: string;
      secrets: Record<string, unknown>;
      session: { state: string };
      writeEnabled: boolean;
    }>("/healthz");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      version: "0.1.1",
      secrets: {
        weworkCredentials: false,
        adminPassword: true,
        quoteKey: true,
        cookieKey: true,
      },
      session: { state: "valid" },
      writeEnabled: true,
    });

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(TEST_ENV.QUOTE_SIGNING_KEY as unknown as string);
    expect(serialised).not.toContain("s3cret-admin-password");
    expect(serialised).not.toContain("accessToken");
  });

  it("still answers when configuration is broken, naming the variable", async () => {
    const app = buildApp({ env: { QUOTE_SIGNING_KEY: undefined } });
    const { status, body } = await app.json<{
      ok: boolean;
      configError?: string;
      secrets: { quoteKey: boolean };
    }>("/healthz");

    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.configError).toContain("QUOTE_SIGNING_KEY");
    expect(body.secrets.quoteKey).toBe(false);
  });

  it("reports ok:false when the session store is unreachable", async () => {
    const failing = new Hono<{ Bindings: Env }>();
    failing.route(
      "/",
      healthRoutes({
        getSessionInfo: () => Promise.reject(new Error("durable object unavailable")),
      }),
    );
    const response = await failing.request(`${ORIGIN}/healthz`, undefined, TEST_ENV);
    const body = (await response.json()) as { ok: boolean; session: { state: string } };
    expect(body.ok).toBe(false);
    expect(body.session.state).toBe("none");
  });
});
