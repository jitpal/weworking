/**
 * `TokenStore` — the worker-side view of the WeWork credential.
 *
 * The interface itself is declared in `src/core/types.ts` (the shared contract) and
 * re-exported here so consumers can import it from the module that owns the
 * implementations.
 *
 * {@link DurableTokenStore} is the production implementation: a thin adapter that
 * forwards each method to the corresponding `WeWorkSession` Durable Object RPC.
 * {@link MemoryTokenStore} below exists so unit tests for the WeWork client and the
 * booking service never need a Durable Object.
 */

import type { SessionInfo, SessionRecord, TokenStore } from "../core/types";
import { AppError } from "../errors";
import type { WeWorkSession } from "./do";

export type { SessionInfo, SessionRecord, TokenStore };

/** Refresh proactively once the token has less than this long to live. */
export const REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * An in-memory {@link TokenStore} for tests.
 *
 * It implements the state machine (`none` -> `valid` -> `expiring` -> `expired`)
 * and the same error contract as the real store, but never performs a refresh:
 * an expired token raises `SESSION_EXPIRED` rather than calling upstream. Tests
 * that need a refresh should seed a new record with {@link MemoryTokenStore.setSession}.
 *
 * @example
 * const store = new MemoryTokenStore({ accessToken: "t", userUuid: "u", expiresAt: Date.now() + 3.6e6, source: "manual" });
 * const { accessToken } = await store.getAccessToken();
 */
export class MemoryTokenStore implements TokenStore {
  #record: SessionRecord | undefined;
  #now: () => number;
  /** Counts `getAccessToken({ forceRefresh: true })` calls, for assertions about 401-retry behaviour. */
  forceRefreshCount = 0;

  constructor(
    record?: Omit<SessionRecord, "obtainedAt"> & { obtainedAt?: number },
    now: () => number = Date.now,
  ) {
    this.#now = now;
    if (record) {
      this.#record = { ...record, obtainedAt: record.obtainedAt ?? now() };
    }
  }

  async getAccessToken(opts?: { forceRefresh?: boolean }): Promise<{
    accessToken: string;
    userUuid: string;
  }> {
    if (opts?.forceRefresh) this.forceRefreshCount += 1;
    const record = this.#record;
    if (!record) {
      throw new AppError("SESSION_MISSING", "No WeWork session is stored.");
    }
    if (record.expiresAt <= this.#now()) {
      throw new AppError("SESSION_EXPIRED", "The stored WeWork session has expired.");
    }
    return { accessToken: record.accessToken, userUuid: record.userUuid };
  }

  async getSessionInfo(): Promise<SessionInfo> {
    const record = this.#record;
    if (!record) {
      return { state: "none", source: "none", hasRefreshToken: false };
    }
    const msLeft = record.expiresAt - this.#now();
    const state: SessionInfo["state"] =
      msLeft <= 0 ? "expired" : msLeft < REFRESH_WINDOW_MS ? "expiring" : "valid";
    return {
      state,
      source: record.source,
      obtainedAt: new Date(record.obtainedAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
      hasRefreshToken: record.refreshToken !== undefined,
    };
  }

  async setSession(rec: Omit<SessionRecord, "obtainedAt">): Promise<void> {
    this.#record = { ...rec, obtainedAt: this.#now() };
  }

  async clear(): Promise<void> {
    this.#record = undefined;
  }

  /** Test-only accessor. Not part of {@link TokenStore}. */
  peek(): SessionRecord | undefined {
    return this.#record ? { ...this.#record } : undefined;
  }
}

/**
 * The production {@link TokenStore}: a thin adapter over the `WeWorkSession` Durable
 * Object's RPC surface.
 *
 * It holds no state of its own — every call crosses to the Durable Object, which is
 * where the refresh mutex, the stored record and the audit trail live. One is built
 * per request by `src/index.ts` and handed to the `WeWorkClient`.
 *
 * @example
 * const tokens = new DurableTokenStore(getSessionStub(env));
 * const client = new WeWorkClient({ fetch, tokens });
 */
export class DurableTokenStore implements TokenStore {
  readonly #stub: DurableObjectStub<WeWorkSession>;

  constructor(stub: DurableObjectStub<WeWorkSession>) {
    this.#stub = stub;
  }

  /**
   * @param opts.forceRefresh set by the client after an upstream 401 — maps to the
   * Durable Object's `force` flag, which bypasses the stored token entirely.
   */
  async getAccessToken(opts?: { forceRefresh?: boolean }): Promise<{
    accessToken: string;
    userUuid: string;
  }> {
    const { accessToken, userUuid } = await this.#stub.getAccessToken({
      force: opts?.forceRefresh === true,
    });
    return { accessToken, userUuid };
  }

  async getSessionInfo(): Promise<SessionInfo> {
    return await this.#stub.getSessionInfo();
  }

  async setSession(rec: Omit<SessionRecord, "obtainedAt">): Promise<void> {
    await this.#stub.setSession(rec);
  }

  async clear(): Promise<void> {
    await this.#stub.clearSession();
  }
}
