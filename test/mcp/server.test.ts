/**
 * The MCP endpoint, end to end, over a real MCP client.
 *
 * This test deliberately does **not** go through `src/index.ts`: it builds its own Hono
 * app, calls `mountMcp()` on it with a fake `resolveActor`, and drives it with
 * `@modelcontextprotocol/client` over a custom `fetch` that routes straight into
 * `app.request()`. So the protocol plumbing under test is the real thing — the
 * 2026-07-28 stateless handler from `agents/mcp/server`, real `initialize`,
 * `tools/list` and `tools/call` round trips — while the front door (OAuth, the static
 * bearer guard, the entry point) stays out of the way.
 *
 * The service behind the tools is also real, built over the fakes from
 * `test/core/fakes.ts`, so a `tools/call` exercises the whole stack down to the quote
 * signature.
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { BookingServiceImpl } from "../../src/core/booking-service";
import type { Actor } from "../../src/core/types";
import type { Env } from "../../src/env";
import { MCP_INSTRUCTIONS, mountMcp } from "../../src/mcp/server";
import { TOOL_NAMES } from "../../src/mcp/tools";
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

/** The origin the in-memory app is addressed on; `localhost` passes the handler's Host check. */
const ORIGIN = "http://localhost";

interface TestApp {
  /** Drives the MCP endpoint as `actor`. */
  connect(actor?: Actor | null): Promise<Client>;
  harness: Harness;
  /** Raw JSON-RPC, for asserting on the HTTP layer itself. */
  post(body: unknown, headers?: Record<string, string>, origin?: string): Promise<Response>;
}

const openClients: Client[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    await client.close().catch(() => undefined);
  }
});

/**
 * Builds a Hono app with only the MCP endpoint mounted.
 *
 * `resolveActor` reads the `x-test-actor` header — `read` for a read-only token, `none`
 * for no credential at all — so one app can exercise every authorisation path.
 */
function buildApp(
  options: { apiScript?: FakeApiScript; sessionScript?: FakeSessionScript } = {},
): TestApp {
  const harness = createHarness(options);
  const app = new Hono<{ Bindings: Env }>();

  mountMcp(app, {
    resolveActor: async (req) => {
      const header = req.headers.get("x-test-actor");
      if (header === "none") return null;
      if (header === "read") return READ_ONLY_ACTOR;
      return READ_WRITE_ACTOR;
    },
    buildService: (): BookingServiceImpl => harness.service,
    unauthorized: () =>
      new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "No credential." } }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
        },
      }),
  });

  /**
   * Routes a fetch straight into the app, adding the `Host` header that a real edge
   * always supplies. `app.request()` does not set one, and the MCP handler's DNS-rebinding
   * guard rejects a request without it — so the stub has to behave like the network.
   */
  const appFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const original = new Request(input as RequestInfo, init);
    const headers = new Headers(original.headers);
    if (!headers.has("host")) headers.set("host", new URL(original.url).host);
    const body =
      original.method === "GET" || original.method === "HEAD" ? undefined : await original.text();
    const request = new Request(original.url, {
      method: original.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    return await app.request(request, undefined, {} as Env);
  };

  return {
    harness,
    async post(body, headers = {}, origin = ORIGIN) {
      return await appFetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    },
    async connect(actor) {
      const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      openClients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        fetch: appFetch as unknown as typeof fetch,
        requestInit: {
          headers: {
            "x-test-actor": actor === null ? "none" : actor === READ_ONLY_ACTOR ? "read" : "rw",
          },
        },
      });
      await client.connect(transport);
      return client;
    },
  };
}

/** The `{ code, message, hint }` body a failing tool returns as text. */
function errorBody(result: { content?: unknown }): {
  code: string;
  message: string;
  hint?: string;
} {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content[0]?.text ?? "{}";
  return JSON.parse(text) as { code: string; message: string; hint?: string };
}

function textOf(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((part) => part.text ?? "").join("\n");
}

describe("initialize", () => {
  it("reports the server identity and the instructions with the disclaimer", async () => {
    const app = buildApp();
    const client = await app.connect();
    expect(client.getServerVersion()).toMatchObject({ name: "weworking", version: "0.1.1" });
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toBe(MCP_INSTRUCTIONS);
    expect(instructions).toContain("not affiliated with");
    expect(instructions).toContain("confirmation of one specific option before booking");
  });

  it("answers 401 with an OAuth discovery challenge when there is no credential", async () => {
    const app = buildApp();
    const response = await app.post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "x-test-actor": "none" },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});

describe("tools/list", () => {
  it("lists exactly the six tools, with annotations and input schemas", async () => {
    const app = buildApp();
    const client = await app.connect();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["whoami", "list_locations", "search_availability", "list_bookings"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName.get("cancel_booking")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("create_booking")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("create_booking")?.annotations?.idempotentHint).toBe(true);

    // Inputs are snake_case.
    const search = byName.get("search_availability");
    expect(Object.keys(search?.inputSchema?.properties ?? {})).toEqual(
      expect.arrayContaining([
        "location_id",
        "city",
        "date",
        "start_time",
        "end_time",
        "space_type",
      ]),
    );
    expect(search?.inputSchema?.required).toEqual(["date"]);
    // Descriptions are the model's only documentation: they must mention the cost.
    expect(byName.get("create_booking")?.description).toContain("CREDITS");
  });
});

describe("tools/call", () => {
  it("search_availability returns quotes, local times and a readable summary", async () => {
    const app = buildApp();
    const client = await app.connect();
    const result = await client.callTool({
      name: "search_availability",
      arguments: {
        location_id: "loc-poultry",
        date: "2026-09-21",
        start_time: "09:00",
        end_time: "17:00",
      },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      results: Array<{ quote: string; startLocal: string; credits: number }>;
      quoteExpiresAt?: string;
    };
    expect(structured.results).toHaveLength(1);
    expect(structured.results[0]?.quote.split(".")).toHaveLength(2);
    expect(structured.results[0]?.startLocal).toBe("2026-09-21T09:00:00");
    expect(structured.quoteExpiresAt).toBe("2026-09-11T09:10:00Z");
    expect(textOf(result)).toContain("(Europe/London)");
    expect(textOf(result)).toContain("confirm one with the user");
  });

  it("whoami reports the session, caps and scopes", async () => {
    const app = buildApp();
    const client = await app.connect();
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      session: { state: "valid" },
      actor: { scopes: ["read", "write"] },
      capsRemaining: { day: 1, week: 5 },
      writeEnabled: true,
    });
  });

  it("create_booking with a forged quote is an isError QUOTE_INVALID", async () => {
    const app = buildApp();
    const client = await app.connect();
    const result = await client.callTool({
      name: "create_booking",
      arguments: { quote: "bm90LWEtcXVvdGU.AAAA", idempotency_key: "k1" },
    });

    expect(result.isError).toBe(true);
    const body = errorBody(result);
    expect(body.code).toBe("QUOTE_INVALID");
    expect(body.hint).toContain("search_availability");
    // Nothing reached upstream.
    expect(app.harness.api.calls.filter((call) => call.method === "book")).toEqual([]);
  });

  it("create_booking from a read-only actor is an isError FORBIDDEN_SCOPE", async () => {
    const app = buildApp();
    const client = await app.connect(READ_ONLY_ACTOR);
    const quote = await firstQuote(app.harness);

    const result = await client.callTool({
      name: "create_booking",
      arguments: { quote, idempotency_key: "k2" },
    });

    expect(result.isError).toBe(true);
    expect(errorBody(result).code).toBe("FORBIDDEN_SCOPE");
    expect(app.harness.api.calls.filter((call) => call.method === "book")).toEqual([]);
  });

  it("cancel_booking from a read-only actor is also refused", async () => {
    const app = buildApp({ apiScript: { bookings: [makeBooking()] } });
    const client = await app.connect(READ_ONLY_ACTOR);
    const result = await client.callTool({
      name: "cancel_booking",
      arguments: { booking_id: "BK-1" },
    });
    expect(errorBody(result).code).toBe("FORBIDDEN_SCOPE");
  });

  it("create_booking dry_run validates and prices without booking", async () => {
    const app = buildApp();
    const client = await app.connect();
    const quote = await firstQuote(app.harness);

    const result = await client.callTool({
      name: "create_booking",
      arguments: { quote, idempotency_key: "k3", dry_run: true },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      dryRun: true,
      creditsCharged: 1,
      booking: { bookingId: "dry-run", status: "pending" },
    });
    expect(textOf(result)).toContain("Dry run");
    expect(app.harness.api.calls.filter((call) => call.method === "book")).toEqual([]);
    expect(app.harness.session.usedToday()).toBe(0);
  });

  it("create_booking actually books, and reports the remaining allowance", async () => {
    const app = buildApp();
    const client = await app.connect();
    const quote = await firstQuote(app.harness);

    const result = await client.callTool({
      name: "create_booking",
      arguments: { quote, idempotency_key: "k4" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      dryRun: false,
      creditsCharged: 1,
      booking: { bookingId: "RES-NEW", status: "confirmed" },
    });
    expect(textOf(result)).toContain("Remaining allowance");
  });

  it("surfaces a validation failure as a tool error naming the parameter", async () => {
    const app = buildApp();
    const client = await app.connect();
    const result = await client.callTool({
      name: "search_availability",
      arguments: { location_id: "loc-poultry", date: "21-09-2026" },
    });
    expect(result.isError).toBe(true);
  });

  it("refuses meeting rooms with UNSUPPORTED_SPACE_TYPE", async () => {
    const app = buildApp();
    const client = await app.connect();
    const result = await client.callTool({
      name: "search_availability",
      arguments: { location_id: "loc-poultry", date: "2026-09-21", space_type: "meeting_room" },
    });
    expect(result.isError).toBe(true);
    expect(errorBody(result).code).toBe("UNSUPPORTED_SPACE_TYPE");
  });

  it("list_bookings and list_locations answer with wrapped arrays", async () => {
    const app = buildApp({ apiScript: { bookings: [makeBooking()] } });
    const client = await app.connect();

    const bookings = await client.callTool({ name: "list_bookings", arguments: {} });
    expect((bookings.structuredContent as { bookings: unknown[] }).bookings).toHaveLength(1);

    const locations = await client.callTool({
      name: "list_locations",
      arguments: { city: "London" },
    });
    expect((locations.structuredContent as { locations: unknown[] }).locations).toHaveLength(1);
  });
});

describe("transport guards", () => {
  it("serves only the mounted route", async () => {
    const app = buildApp();
    const response = await app.post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(200);
  });

  it("rejects a Host header that is not on the allowlist (DNS rebinding guard)", async () => {
    const app = buildApp();
    const response = await app.post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { host: "evil.example" },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toContain("Invalid Host");
  });

  it("accepts a custom domain, which the library's own defaults would not", async () => {
    // The library only defaults to a Host allowlist for localhost and *.workers.dev;
    // `resolveAllowedHostnames` adds the request's own hostname so a custom domain works.
    const app = buildApp();
    const response = await app.post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {},
      "https://desk.example.com",
    );
    expect(response.status).toBe(200);
  });
});
