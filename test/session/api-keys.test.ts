/**
 * The API key half of the `WeWorkSession` Durable Object.
 *
 * This is the table the front door authenticates against, so the tests care about
 * three things: a revoked key stops matching immediately, a digest can only be
 * registered once, and matching a key does not turn every authenticated request
 * into a SQLite write.
 */

import { describe, expect, it } from "vitest";
import { API_KEY_LAST_USED_THROTTLE_MS } from "../../src/session/do";
import { freshSession, queryCount, rejection, setClock } from "./helpers";

const T0 = Date.parse("2026-09-11T09:00:00.000Z");

/** A 64-character hex digest that is easy to tell apart in a failure message. */
function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

const READ_KEY = digest("a");
const WRITE_KEY = digest("b");

describe("createApiKey and listApiKeys", () => {
  it("stores a key and reports it with ISO timestamps, newest first", async () => {
    const session = freshSession("keys-list");
    await setClock(session, T0);
    await session.createApiKey({
      id: "key-1",
      name: "claude-code",
      sha256: READ_KEY,
      scopes: ["read"],
    });
    await setClock(session, T0 + 60_000);
    await session.createApiKey({
      id: "key-2",
      name: "scripts",
      sha256: WRITE_KEY,
      scopes: ["write", "read"],
    });

    const keys = await session.listApiKeys();
    expect(keys.map((key) => key.id)).toEqual(["key-2", "key-1"]);
    expect(keys[1]).toEqual({
      id: "key-1",
      name: "claude-code",
      scopes: ["read"],
      createdAt: "2026-09-11T09:00:00.000Z",
    });
    // Scopes come back in canonical order, whatever order they went in.
    expect(keys[0]?.scopes).toEqual(["read", "write"]);
    expect(keys[0]?.lastUsedAt).toBeUndefined();
    expect(keys[0]?.revokedAt).toBeUndefined();
  });

  it("never returns the digest it stored", async () => {
    const session = freshSession("keys-no-digest");
    await session.createApiKey({ id: "k", name: "n", sha256: READ_KEY, scopes: ["read"] });
    expect(JSON.stringify(await session.listApiKeys())).not.toContain(READ_KEY);
  });

  it("rejects a duplicate digest", async () => {
    const session = freshSession("keys-dupe-hash");
    await session.createApiKey({ id: "k1", name: "one", sha256: READ_KEY, scopes: ["read"] });
    const failure = await rejection(
      session.createApiKey({ id: "k2", name: "two", sha256: READ_KEY, scopes: ["read"] }),
    );
    expect(failure.code).toBe("VALIDATION");
    expect((await session.listApiKeys()).length).toBe(1);
  });

  it("rejects a duplicate id", async () => {
    const session = freshSession("keys-dupe-id");
    await session.createApiKey({ id: "k1", name: "one", sha256: READ_KEY, scopes: ["read"] });
    const failure = await rejection(
      session.createApiKey({ id: "k1", name: "two", sha256: WRITE_KEY, scopes: ["read"] }),
    );
    expect(failure.code).toBe("VALIDATION");
  });

  it("validates the name, the scopes and the digest", async () => {
    const session = freshSession("keys-validation");
    const cases = [
      { id: "a", name: "", sha256: READ_KEY, scopes: ["read" as const] },
      { id: "b", name: "x".repeat(65), sha256: READ_KEY, scopes: ["read" as const] },
      { id: "c", name: "ok", sha256: "not-a-digest", scopes: ["read" as const] },
      { id: "d", name: "ok", sha256: READ_KEY, scopes: [] },
      { id: "e", name: "ok", sha256: READ_KEY, scopes: ["root"] as never },
      { id: "", name: "ok", sha256: READ_KEY, scopes: ["read" as const] },
    ];
    for (const input of cases) {
      const failure = await rejection(session.createApiKey(input));
      expect(failure.code).toBe("VALIDATION");
    }
    expect(await session.listApiKeys()).toEqual([]);
  });

  it("accepts a name of exactly the maximum length", async () => {
    const session = freshSession("keys-name-max");
    await session.createApiKey({
      id: "k",
      name: "x".repeat(64),
      sha256: READ_KEY,
      scopes: ["read"],
    });
    expect((await session.listApiKeys())[0]?.name).toHaveLength(64);
  });
});

describe("matchApiKey", () => {
  it("resolves an active key to its id, name and scopes", async () => {
    const session = freshSession("keys-match");
    await session.createApiKey({
      id: "key-1",
      name: "claude-code",
      sha256: READ_KEY,
      scopes: ["read", "write"],
    });
    await expect(session.matchApiKey(READ_KEY)).resolves.toEqual({
      id: "key-1",
      name: "claude-code",
      scopes: ["read", "write"],
    });
  });

  it("matches an upper-case digest, and nothing that is not one", async () => {
    const session = freshSession("keys-match-shape");
    await session.createApiKey({ id: "k", name: "n", sha256: READ_KEY, scopes: ["read"] });
    await expect(session.matchApiKey(READ_KEY.toUpperCase())).resolves.toMatchObject({ id: "k" });
    await expect(session.matchApiKey(WRITE_KEY)).resolves.toBeUndefined();
    await expect(session.matchApiKey("")).resolves.toBeUndefined();
    await expect(session.matchApiKey("nonsense")).resolves.toBeUndefined();
  });

  it("stops matching the moment the key is revoked", async () => {
    const session = freshSession("keys-revoked-match");
    await session.createApiKey({ id: "key-1", name: "n", sha256: READ_KEY, scopes: ["read"] });
    await expect(session.matchApiKey(READ_KEY)).resolves.toMatchObject({ id: "key-1" });
    await expect(session.revokeApiKey("key-1")).resolves.toBe(true);
    await expect(session.matchApiKey(READ_KEY)).resolves.toBeUndefined();
  });

  it("refreshes last_used_at at most once per throttle window", async () => {
    const session = freshSession("keys-throttle");
    await setClock(session, T0);
    await session.createApiKey({ id: "key-1", name: "n", sha256: READ_KEY, scopes: ["read"] });

    const lastUsed = async () =>
      queryCount(session, "SELECT COALESCE(last_used_at, 0) AS n FROM api_keys WHERE id = 'key-1'");

    expect(await lastUsed()).toBe(0);
    await session.matchApiKey(READ_KEY);
    expect(await lastUsed()).toBe(T0);

    // Well inside the window: the timestamp is left alone.
    await setClock(session, T0 + API_KEY_LAST_USED_THROTTLE_MS - 1);
    await session.matchApiKey(READ_KEY);
    expect(await lastUsed()).toBe(T0);

    // Past it: one write.
    const later = T0 + API_KEY_LAST_USED_THROTTLE_MS;
    await setClock(session, later);
    await session.matchApiKey(READ_KEY);
    expect(await lastUsed()).toBe(later);

    expect((await session.listApiKeys())[0]?.lastUsedAt).toBe(new Date(later).toISOString());
  });
});

describe("revokeApiKey", () => {
  it("keeps the row so the audit trail still resolves the name", async () => {
    const session = freshSession("keys-revoke-row");
    await setClock(session, T0);
    await session.createApiKey({
      id: "key-1",
      name: "retired",
      sha256: READ_KEY,
      scopes: ["read"],
    });
    await session.revokeApiKey("key-1");

    const keys = await session.listApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: "retired", revokedAt: "2026-09-11T09:00:00.000Z" });
  });

  it("is false for an unknown id and for a second revocation", async () => {
    const session = freshSession("keys-revoke-twice");
    await session.createApiKey({ id: "key-1", name: "n", sha256: READ_KEY, scopes: ["read"] });
    await expect(session.revokeApiKey("nope")).resolves.toBe(false);
    await expect(session.revokeApiKey("key-1")).resolves.toBe(true);
    await expect(session.revokeApiKey("key-1")).resolves.toBe(false);
  });

  it("rejects an empty id rather than revoking everything", async () => {
    const session = freshSession("keys-revoke-empty");
    await session.createApiKey({ id: "key-1", name: "n", sha256: READ_KEY, scopes: ["read"] });
    const failure = await rejection(session.revokeApiKey("  "));
    expect(failure.code).toBe("VALIDATION");
    await expect(session.matchApiKey(READ_KEY)).resolves.toMatchObject({ id: "key-1" });
  });
});
