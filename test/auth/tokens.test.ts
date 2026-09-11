/**
 * Static bearer tokens: parsing the `AUTH_TOKENS` secret and matching a presented
 * credential against it.
 *
 * The interesting behaviours are the defensive ones — a malformed secret must not
 * take the worker down, and it must not spam the log on every request.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import {
  constantTimeEqual,
  matchStaticToken,
  parseStaticTokens,
  resetStaticTokenCache,
  sha256Hex,
} from "../../src/auth/tokens";

/** `sha256Hex("dev-token")`, computed by the implementation in the first test. */
const DEV_TOKEN = "dev-token";

function envWith(authTokens: string | undefined): Env {
  return { AUTH_TOKENS: authTokens } as unknown as Env;
}

beforeEach(() => {
  resetStaticTokenCache();
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 of 'abc'", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns 64 lower-case hex characters", async () => {
    const digest = await sha256Hex(DEV_TOKEN);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("constantTimeEqual", () => {
  it("is true only for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("handles different lengths and empty strings without throwing", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual("a", "")).toBe(false);
  });

  it("compares every byte, not just the prefix", () => {
    const digest = "a".repeat(63);
    expect(constantTimeEqual(`${digest}b`, `${digest}c`)).toBe(false);
  });
});

describe("parseStaticTokens", () => {
  const valid = JSON.stringify([
    { name: "claude-code", sha256: "a".repeat(64), scopes: ["read", "write"] },
    { name: "ops", sha256: "B".repeat(64), scopes: ["admin"] },
  ]);

  it("returns [] for an absent, empty or empty-array secret", () => {
    expect(parseStaticTokens(undefined)).toEqual([]);
    expect(parseStaticTokens("   ")).toEqual([]);
    expect(parseStaticTokens("[]")).toEqual([]);
  });

  it("parses entries and lower-cases the digest", () => {
    const tokens = parseStaticTokens(valid);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toEqual({
      name: "claude-code",
      sha256: "a".repeat(64),
      scopes: ["read", "write"],
    });
    expect(tokens[1]?.sha256).toBe("b".repeat(64));
  });

  it("treats malformed JSON as 'no static tokens' and logs exactly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseStaticTokens("{not json")).toEqual([]);
    expect(parseStaticTokens("{not json")).toEqual([]);
    expect(parseStaticTokens("{not json")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("never logs the secret's content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseStaticTokens('[{"name":"x","sha256":"nope","scopes":["read"],"note":"s3cret-value"}]');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("s3cret-value");
    warn.mockRestore();
  });

  it.each([
    ["not an array", '{"name":"x"}'],
    ["a short digest", '[{"name":"x","sha256":"abc","scopes":["read"]}]'],
    ["a non-hex digest", `[{"name":"x","sha256":"${"z".repeat(64)}","scopes":["read"]}]`],
    ["an unknown scope", `[{"name":"x","sha256":"${"a".repeat(64)}","scopes":["root"]}]`],
    ["no scopes", `[{"name":"x","sha256":"${"a".repeat(64)}","scopes":[]}]`],
    ["a blank name", `[{"name":"  ","sha256":"${"a".repeat(64)}","scopes":["read"]}]`],
  ])("rejects %s", (_label, raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseStaticTokens(raw)).toEqual([]);
    warn.mockRestore();
  });
});

describe("matchStaticToken", () => {
  it("resolves a configured token to a bearer Actor", async () => {
    const digest = await sha256Hex(DEV_TOKEN);
    const env = envWith(
      JSON.stringify([{ name: "claude-code", sha256: digest.toUpperCase(), scopes: ["read", "write"] }]),
    );
    await expect(matchStaticToken(env, DEV_TOKEN)).resolves.toEqual({
      kind: "bearer",
      name: "claude-code",
      scopes: ["read", "write"],
      accountId: "default",
    });
  });

  it("returns null for an unknown token, an empty token and an unset secret", async () => {
    const digest = await sha256Hex(DEV_TOKEN);
    const env = envWith(JSON.stringify([{ name: "t", sha256: digest, scopes: ["read"] }]));
    await expect(matchStaticToken(env, "wrong-token")).resolves.toBeNull();
    await expect(matchStaticToken(env, "  ")).resolves.toBeNull();
    await expect(matchStaticToken(envWith(undefined), DEV_TOKEN)).resolves.toBeNull();
    await expect(matchStaticToken(envWith("[]"), DEV_TOKEN)).resolves.toBeNull();
  });

  it("matches the right entry when several are configured", async () => {
    const adminDigest = await sha256Hex("admin-token");
    const readDigest = await sha256Hex("read-token");
    const env = envWith(
      JSON.stringify([
        { name: "reader", sha256: readDigest, scopes: ["read"] },
        { name: "operator", sha256: adminDigest, scopes: ["admin"] },
      ]),
    );
    await expect(matchStaticToken(env, "admin-token")).resolves.toMatchObject({
      name: "operator",
      scopes: ["admin"],
    });
    await expect(matchStaticToken(env, "read-token")).resolves.toMatchObject({
      name: "reader",
      scopes: ["read"],
    });
  });
});
