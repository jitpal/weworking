/**
 * Auth0 tenant discovery.
 *
 * The important property is that `fetchAuth0Config` **never throws**: a login that
 * fails because discovery was down would be a self-inflicted outage, when four
 * independent clients agree on what the constants are.
 */

import { describe, expect, it, vi } from "vitest";
import {
  AUTH0_CONFIG_URL,
  authOrigin,
  authUrl,
  FALLBACK_AUTH0_CONFIG,
  fetchAuth0Config,
  normaliseConfig,
} from "../../src/wework/auth/config";
import { createFakeFetch } from "../helpers/fake-fetch";
import auth0Config from "../fixtures/wework/auth0-config.json";

/** Silences (and captures) the fallback warning. */
function withWarnSpy<T>(fn: (warn: ReturnType<typeof vi.spyOn>) => Promise<T>): Promise<T> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return fn(warn).finally(() => warn.mockRestore());
}

describe("fetchAuth0Config", () => {
  it("reads the SPA's own configuration", async () => {
    const fetchStub = createFakeFetch([
      { method: "GET", url: AUTH0_CONFIG_URL, times: 1, response: () => Response.json(auth0Config) },
    ]);
    await expect(fetchAuth0Config(fetchStub)).resolves.toEqual(FALLBACK_AUTH0_CONFIG);
    // The config URL must keep its url-encoded `domain` parameter verbatim.
    expect(fetchStub.calls[0]?.url).toContain("domain=members.wework.com%2Fworkplaceone");
    fetchStub.assertAllConsumed();
  });

  it("picks up a tenant migration", async () => {
    const fetchStub = createFakeFetch([
      {
        method: "GET",
        url: AUTH0_CONFIG_URL,
        response: () =>
          Response.json({
            domain: "https://login.wework.example/",
            clientId: "NEW-CLIENT-ID",
            authorizationParams: {
              scope: "openid offline_access",
              audience: "wework",
              redirect_uri: "https://members.wework.com/cb",
            },
          }),
      },
    ]);
    await expect(fetchAuth0Config(fetchStub)).resolves.toEqual({
      // Scheme and trailing slash stripped.
      domain: "login.wework.example",
      clientId: "NEW-CLIENT-ID",
      scope: "openid offline_access",
      audience: "wework",
      redirectUri: "https://members.wework.com/cb",
    });
  });

  it("falls back on a non-2xx, and says so in a redacted warning", async () => {
    await withWarnSpy(async (warn) => {
      const fetchStub = createFakeFetch([
        { method: "GET", url: AUTH0_CONFIG_URL, response: () => new Response("nope", { status: 503 }) },
      ]);
      await expect(fetchAuth0Config(fetchStub)).resolves.toEqual(FALLBACK_AUTH0_CONFIG);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain("fallback");
    });
  });

  it("falls back when the network throws", async () => {
    await withWarnSpy(async (warn) => {
      const boom = (() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch;
      await expect(fetchAuth0Config(boom)).resolves.toEqual(FALLBACK_AUTH0_CONFIG);
      expect(warn).toHaveBeenCalled();
    });
  });

  it("falls back when the body is not JSON", async () => {
    await withWarnSpy(async () => {
      const fetchStub = createFakeFetch([
        { method: "GET", url: AUTH0_CONFIG_URL, response: () => new Response("<html/>") },
      ]);
      await expect(fetchAuth0Config(fetchStub)).resolves.toEqual(FALLBACK_AUTH0_CONFIG);
    });
  });

  it("falls back when the body is JSON but unrecognisable", async () => {
    await withWarnSpy(async () => {
      const fetchStub = createFakeFetch([
        { method: "GET", url: AUTH0_CONFIG_URL, response: () => Response.json({ unexpected: true }) },
      ]);
      await expect(fetchAuth0Config(fetchStub)).resolves.toEqual(FALLBACK_AUTH0_CONFIG);
    });
  });
});

describe("normaliseConfig", () => {
  it("fills each missing field from the pinned constants", () => {
    expect(normaliseConfig({ clientId: "ONLY-THIS" })).toEqual({
      ...FALLBACK_AUTH0_CONFIG,
      clientId: "ONLY-THIS",
    });
  });

  it("unwraps a data/result envelope", () => {
    expect(normaliseConfig({ data: { clientId: "NESTED" } })?.clientId).toBe("NESTED");
    expect(normaliseConfig({ result: { clientId: "NESTED" } })?.clientId).toBe("NESTED");
  });

  it("accepts snake_case and camelCase spellings", () => {
    expect(
      normaliseConfig({
        client_id: "SNAKE",
        authorizationParams: { redirectUri: "https://x.invalid/cb" },
      }),
    ).toMatchObject({ clientId: "SNAKE", redirectUri: "https://x.invalid/cb" });
  });

  it("returns undefined for something that is not a config at all", () => {
    expect(normaliseConfig(null)).toBeUndefined();
    expect(normaliseConfig("nope")).toBeUndefined();
    expect(normaliseConfig({ totally: "unrelated" })).toBeUndefined();
  });
});

describe("url helpers", () => {
  it("build tenant urls with no double slashes", () => {
    expect(authOrigin(FALLBACK_AUTH0_CONFIG)).toBe("https://idp.wework.com");
    expect(authUrl(FALLBACK_AUTH0_CONFIG, "/oauth/token")).toBe("https://idp.wework.com/oauth/token");
    expect(authUrl(FALLBACK_AUTH0_CONFIG, "oauth/token")).toBe("https://idp.wework.com/oauth/token");
  });
});

describe("the pinned constants", () => {
  it("match the documented tenant", () => {
    expect(FALLBACK_AUTH0_CONFIG).toEqual({
      domain: "idp.wework.com",
      clientId: "zE51Ep7FttlmtQV6ZEGyJKsY2jD1EtAu",
      scope: "openid profile email offline_access",
      audience: "wework",
      redirectUri:
        "https://members.wework.com/workplaceone/api/auth0/v2/callback?domain=members.wework.com/workplaceone",
    });
  });

  it("request offline_access, without which there is no refresh token", () => {
    expect(FALLBACK_AUTH0_CONFIG.scope.split(" ")).toContain("offline_access");
  });
});
