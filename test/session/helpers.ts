/**
 * Shared plumbing for the `WeWorkSession` Durable Object tests.
 *
 * ## How these tests control the world
 *
 * The Durable Object has three `protected` seams — `now()`, `loadConfig()` and
 * `fetcher()`. `runInDurableObject()` (from `cloudflare:test`) runs a callback
 * *inside* the object with a reference to the live instance, so a test can shadow a
 * seam with an own property. That keeps the production RPC surface clean: there is
 * no `__debugSetClock`, no test-only RPC and no `globalThis` flag.
 *
 * `vi.useFakeTimers()` is deliberately **not** used: the pool's `main` worker shares
 * the test isolate, but faking the clock there also fakes it for workerd's own
 * internals (storage, RPC) and makes the Durable Object hang. Overriding `now()` on
 * the instance is both narrower and honest about what is being faked.
 *
 * Module mocking does reach the Durable Object (the `main` worker runs in the same
 * isolate as the tests), which is why each test file mocks
 * `src/wework/auth` — these tests pin the Durable Object's strategy order, never
 * another module's Auth0 behaviour.
 */

import { env, runInDurableObject } from "cloudflare:test";
import type { SessionRecord } from "../../src/core/types";
import { type Config, type Env, parseConfig } from "../../src/env";
import type { WeWorkSession } from "../../src/session/do";

/** The seams {@link WeWorkSession} exposes for tests (see the class docs). */
interface SessionSeams {
  now(): number;
  loadConfig(): Config;
  fetcher(): typeof fetch;
}

let counter = 0;

/** The worker bindings, typed as the worker sees them. */
export const testEnv = env as unknown as Env;

/**
 * A stub pointing at a Durable Object nobody else in the suite uses.
 *
 * Storage is isolated per test by the pool, but a unique name also isolates the
 * *instance* (and therefore the coalescing promise and any seam overrides).
 */
export function freshSession(label: string): DurableObjectStub<WeWorkSession> {
  counter += 1;
  return env.SESSION.getByName(`test-${label}-${counter}`);
}

/** Pins the object's clock to `at` (epoch ms). Returns `at` for convenience. */
export async function setClock(
  stub: DurableObjectStub<WeWorkSession>,
  at: number,
): Promise<number> {
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as SessionSeams).now = () => at;
  });
  return at;
}

/** Restores the real clock. */
export async function resetClock(stub: DurableObjectStub<WeWorkSession>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    delete (instance as unknown as Partial<SessionSeams>).now;
  });
}

/**
 * Overrides the parsed configuration for this instance.
 *
 * The pool's bindings pin `LOGIN_STRATEGY=manual` with no WeWork credentials, so
 * tests that exercise the headless-login branch patch `loadConfig()` rather than
 * reaching into `env` (which the Durable Object reads through `parseConfig`).
 */
export async function patchConfig(
  stub: DurableObjectStub<WeWorkSession>,
  patch: Partial<Config>,
): Promise<void> {
  const base = parseConfig(testEnv);
  const config: Config = { ...base, ...patch };
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as SessionSeams).loadConfig = () => config;
  });
}

/** Config patch that enables the headless-login branch. */
export function withHeadlessCredentials(): Partial<Config> {
  return {
    loginStrategy: "auto",
    weworkUsername: "member@example.test",
    weworkPassword: "hunter2",
    hasWeworkCredentials: true,
  };
}

/** Reads a single scalar straight out of the object's SQLite storage. */
export async function queryCount(
  stub: DurableObjectStub<WeWorkSession>,
  sql: string,
  ...bindings: (string | number)[]
): Promise<number> {
  return await runInDurableObject(
    stub,
    (_instance, state) => state.storage.sql.exec<{ n: number }>(sql, ...bindings).one().n,
  );
}

/** A complete {@link SessionRecord}, with `expiresAt` `hours` from `now`. */
export function sessionRecord(
  overrides: Partial<SessionRecord> & { hoursLeft?: number } = {},
): Omit<SessionRecord, "obtainedAt"> {
  const { hoursLeft = 24, ...rest } = overrides;
  return {
    accessToken: "stored-access-token",
    refreshToken: "stored-refresh-token",
    expiresAt: Date.now() + hoursLeft * 3_600_000,
    source: "manual",
    userUuid: "user-uuid-1",
    ...rest,
  };
}

/** The shape `refreshSession()` / `LoginStrategy.login()` resolve to. */
export function loginResult(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    accessToken: "fresh-access-token",
    refreshToken: "fresh-refresh-token",
    expiresAt: Date.now() + 10 * 3_600_000,
    obtainedAt: Date.now(),
    source: "login",
    userUuid: "user-uuid-1",
    ...overrides,
  };
}

/** Narrows a rejected value to the `{ code, hint }` shape that survives DO RPC. */
export async function rejection(
  promise: Promise<unknown>,
): Promise<{ name: string; code: string; message: string; hint?: string }> {
  try {
    await promise;
    throw new Error("expected the call to reject, but it resolved");
  } catch (err) {
    const e = err as Error & { code?: string; hint?: string };
    if (e.code === undefined) throw err;
    return { name: e.name, code: e.code, message: e.message, hint: e.hint };
  }
}
