/**
 * `WeWorkSession` — the single stateful component of this worker.
 *
 * One SQLite-backed Durable Object instance (id `"session:default"`) owns:
 *   - the WeWork access/refresh token, and the mutex that coalesces concurrent
 *     refresh or login attempts into one upstream call;
 *   - the idempotency table, so a retried `create_booking` cannot double-book;
 *   - the booking ledger that enforces the daily/weekly caps;
 *   - the API keys the operator minted at `/admin/keys`, as SHA-256 digests;
 *   - the audit log.
 *
 * Keeping all of that in one object is what makes the caps and the mutex correct:
 * a Durable Object serialises its own requests, so no two bookings race.
 *
 * Invariant for every method: tokens never appear in a return value, an error
 * message or a log line. Only {@link WeWorkSession.getAccessToken} returns one, and
 * only to the `WeWorkClient`.
 *
 * ## Test seams
 *
 * Two `protected` methods exist so tests can control the parts of the world this
 * object cannot: {@link WeWorkSession.now} (the clock) and
 * {@link WeWorkSession.loadConfig} (the parsed env). Override them on a live
 * instance with `runInDurableObject()` from `cloudflare:test` — there is no
 * test-only RPC and no debug flag on the production surface. See
 * `test/session/helpers.ts`.
 */

import { DurableObject } from "cloudflare:workers";
import type { CapsRemaining, Location, Scope, SessionInfo, SessionRecord } from "../core/types";
import { type Config, type Env, parseConfig } from "../env";
import { AppError } from "../errors";
import { REDACTED, redact } from "../redact";
import { createHeadlessLoginStrategy, refreshSession } from "../wework/auth";
import { REFRESH_WINDOW_MS } from "./token-store";

/** The Durable Object id every request uses in phase 1 (single WeWork account). */
export const SESSION_DO_NAME = "session:default";

/** The single row id in the `session` table (one account per deployment). */
const SESSION_ROW_ID = "current";

/** Default freshness demanded by {@link WeWorkSession.getAccessToken}. */
const DEFAULT_MIN_TTL_SEC = 120;

/** A reservation that is not confirmed within this long is abandoned and never counted. */
export const STALE_RESERVATION_MS = 10 * 60 * 1000;

/** Default lifetime of an idempotency record. */
export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

/** Audit rows older than this are pruned by {@link WeWorkSession.maintain}. */
export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How often {@link WeWorkSession.matchApiKey} rewrites `last_used_at`.
 *
 * Every authenticated request matches a key, so an unconditional write would turn a
 * read into a write on the hot path. One write per key per minute is enough for the
 * "last used" column on the admin page to be useful.
 */
export const API_KEY_LAST_USED_THROTTLE_MS = 60 * 1000;

/** Longest an API key name may be. Names are labels for the audit log, not prose. */
export const API_KEY_NAME_MAX = 64;

/** Ledger statuses that consume a cap slot. */
const ACTIVE_STATUSES = "('reserved','confirmed')";

/**
 * A JSON value, unrolled to a fixed depth instead of being defined recursively.
 *
 * Two constraints meet here. Durable Object RPC maps an `unknown` return type to
 * `never` (the `Rpc.Serializable` conditional has no branch for it), which would make
 * `listAudit()` and `idempotencyGet()` unusable from the worker side; a *recursive*
 * JSON type instead trips TypeScript's "type instantiation is excessively deep" guard
 * inside the same mapper. Four levels covers every redacted tool argument and booking
 * result this project stores.
 */
type Json1 = string | number | boolean | null;
type Json2 = Json1 | Json1[] | { [key: string]: Json1 };
type Json3 = Json2 | Json2[] | { [key: string]: Json2 };
export type JsonValue = Json3 | Json3[] | { [key: string]: Json3 };

/** Outcome of {@link WeWorkSession.reserveBooking}. */
export type ReserveBookingResult =
  | { ok: true; capsRemaining: CapsRemaining }
  | { ok: false; code: "CAP_EXCEEDED"; message: string; capsRemaining: CapsRemaining };

/** One row of {@link WeWorkSession.listAudit}. */
export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  tool: string;
  args?: JsonValue;
  outcome: string;
  bookingId?: string;
  credits?: number;
  dryRun: boolean;
  error?: string;
}

/** Argument of {@link WeWorkSession.audit}. */
export interface AuditInput {
  actor: string;
  tool: string;
  args: unknown;
  outcome: "ok" | "error" | "denied";
  bookingId?: string;
  credits?: number;
  dryRun?: boolean;
  error?: string;
}

/**
 * One API key as {@link WeWorkSession.listApiKeys} reports it.
 *
 * There is no field for the key itself and there never will be: only its SHA-256 is
 * stored, and that is not returned either.
 */
export interface ApiKeySummary {
  id: string;
  name: string;
  scopes: Scope[];
  /** ISO-8601 UTC. */
  createdAt: string;
  /** ISO-8601 UTC; absent until the key authenticates a request. */
  lastUsedAt?: string;
  /** ISO-8601 UTC; present only on a revoked key. */
  revokedAt?: string;
}

/** What {@link WeWorkSession.matchApiKey} returns for a live key. */
export interface ApiKeyMatch {
  id: string;
  name: string;
  scopes: Scope[];
}

/** Summary returned by {@link WeWorkSession.maintain} (cron). */
export interface MaintenanceSummary {
  refreshed: boolean;
  pruned: number;
  session: SessionInfo;
  error?: string;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  obtained_at: number;
  source: string;
  user_uuid: string;
  last_error: string | null;
}

interface CountRow extends Record<string, SqlStorageValue> {
  n: number;
}

interface ApiKeyRow extends Record<string, SqlStorageValue> {
  id: string;
  name: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface AuditRow extends Record<string, SqlStorageValue> {
  id: number;
  ts: number;
  actor: string;
  tool: string;
  args_redacted: string | null;
  outcome: string;
  booking_id: string | null;
  credits: number | null;
  dry_run: number;
  error: string | null;
}

export class WeWorkSession extends DurableObject<Env> {
  /**
   * The in-flight refresh/login, shared by every concurrent
   * {@link WeWorkSession.getAccessToken} caller so only one upstream login happens.
   */
  private inflight: Promise<SessionRecord> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The schema must exist before any RPC runs; blockConcurrencyWhile guarantees it.
    ctx.blockConcurrencyWhile(async () => {
      this.#migrate();
    });
  }

  /**
   * Liveness probe used by `/healthz` and the smoke test: proves the binding,
   * the SQLite migration and RPC all work without touching any state.
   *
   * @returns the current Durable Object wall-clock time, in epoch milliseconds.
   */
  ping(): { ok: true; now: number } {
    return { ok: true, now: Date.now() };
  }

  // ---------------------------------------------------------------- session

  /**
   * Returns a usable WeWork access token, refreshing or logging in when needed.
   *
   * Strategy order: the stored token (when it still has `minTtlSec` left) ->
   * `refresh_token` grant -> headless login (only when credentials are configured
   * and `LOGIN_STRATEGY !== "manual"`) -> `SESSION_MISSING` / `SESSION_EXPIRED`.
   *
   * Concurrent callers are coalesced onto one attempt: the second caller awaits the
   * first one's promise instead of starting a second login.
   *
   * @throws AppError `SESSION_MISSING`, `SESSION_EXPIRED`, or whatever the auth
   * module raised (`UPSTREAM_AUTH`, `UPSTREAM_BLOCKED`, `UPSTREAM_RATE_LIMITED`,
   * `UPSTREAM_ERROR`) — propagated unchanged so the agent sees the real reason.
   */
  async getAccessToken(
    opts: { minTtlSec?: number; force?: boolean } = {},
  ): Promise<{ accessToken: string; userUuid: string }> {
    const minTtlSec = opts.minTtlSec ?? DEFAULT_MIN_TTL_SEC;
    const force = opts.force ?? false;
    const row = this.#readRow();

    if (!force && row && row.expires_at - this.now() > minTtlSec * 1000) {
      return { accessToken: row.access_token, userUuid: row.user_uuid };
    }

    if (this.inflight) {
      const shared = await this.inflight;
      return { accessToken: shared.accessToken, userUuid: shared.userUuid };
    }

    const attempt = this.#obtain(row).finally(() => {
      this.inflight = null;
    });
    this.inflight = attempt;
    const record = await attempt;
    return { accessToken: record.accessToken, userUuid: record.userUuid };
  }

  /** Token-free view of the stored session, safe for `/healthz`, `/admin` and `whoami`. */
  async getSessionInfo(): Promise<SessionInfo> {
    return this.#sessionInfo();
  }

  /**
   * Stores a session obtained elsewhere — the `/admin/connect` paste flow
   * (`source: "manual"`) or a login performed worker-side.
   *
   * Clears `last_error`: a fresh token means whatever failed before is moot.
   */
  async setSession(rec: Omit<SessionRecord, "obtainedAt">): Promise<void> {
    this.#persist({ ...rec, obtainedAt: this.now() });
  }

  /** Forgets the WeWork session entirely (`/admin/session/clear`). */
  async clearSession(): Promise<void> {
    this.inflight = null;
    this.#sql.exec("DELETE FROM session");
  }

  // ------------------------------------------------------------ caps/ledger

  /**
   * Reserves a cap slot for a booking that is about to be attempted upstream.
   *
   * Checks `MAX_CREDITS_PER_BOOKING` and `MAX_CASH_PER_BOOKING` (`-1` = unlimited for
   * both), then `MAX_BOOKINGS_PER_DAY` for `date` and `MAX_BOOKINGS_PER_WEEK` for its
   * ISO week (Monday-Sunday). This object is the authority on all four: the booking
   * service checks the same limits first, so an agent gets a useful error, but a
   * booking is only ever reserved here.
   *
   * Dry-run rows are written with `dry_run = 1` and never count towards a cap, but
   * the caps are still evaluated so a dry run reports what a real booking would do.
   *
   * Call {@link WeWorkSession.confirmBooking} on success or
   * {@link WeWorkSession.releaseBooking} when the upstream call fails; an
   * unconfirmed reservation older than {@link STALE_RESERVATION_MS} stops counting.
   */
  async reserveBooking(args: {
    bookingKey: string;
    date: string;
    credits: number;
    /** Cash price of the booking, in the building's currency. Absent means zero. */
    amount?: number;
    actor: string;
    dryRun: boolean;
  }): Promise<ReserveBookingResult> {
    const date = normaliseDate(args.date);
    const bookingKey = requireText(args.bookingKey, "bookingKey");
    const credits = Number.isFinite(args.credits) ? Math.max(0, Math.trunc(args.credits)) : 0;
    const amount = Number.isFinite(args.amount) ? Math.max(0, args.amount as number) : 0;
    const caps = this.loadConfig();
    const now = this.now();
    const counts = this.#counts(date, now, bookingKey);

    if (caps.maxCreditsPerBooking >= 0 && credits > caps.maxCreditsPerBooking) {
      return {
        ok: false,
        code: "CAP_EXCEEDED",
        message: `This booking costs ${credits} credits but MAX_CREDITS_PER_BOOKING is ${caps.maxCreditsPerBooking}.`,
        capsRemaining: remaining(caps, counts),
      };
    }
    if (caps.maxCashPerBooking >= 0 && amount > caps.maxCashPerBooking) {
      return {
        ok: false,
        code: "CAP_EXCEEDED",
        message: `This booking costs ${amount} in cash but MAX_CASH_PER_BOOKING is ${caps.maxCashPerBooking}.`,
        capsRemaining: remaining(caps, counts),
      };
    }
    if (counts.day >= caps.maxBookingsPerDay) {
      return {
        ok: false,
        code: "CAP_EXCEEDED",
        message: `The daily booking cap (MAX_BOOKINGS_PER_DAY=${caps.maxBookingsPerDay}) is already used for ${date}.`,
        capsRemaining: remaining(caps, counts),
      };
    }
    if (counts.week >= caps.maxBookingsPerWeek) {
      return {
        ok: false,
        code: "CAP_EXCEEDED",
        message: `The weekly booking cap (MAX_BOOKINGS_PER_WEEK=${caps.maxBookingsPerWeek}) is already used for week ${isoWeekKey(date)}.`,
        capsRemaining: remaining(caps, counts),
      };
    }

    this.#sql.exec(
      `INSERT OR REPLACE INTO bookings_ledger
         (booking_key, booking_id, date, iso_week, credits, status, created_at, confirmed_at, actor, dry_run)
       VALUES (?, NULL, ?, ?, ?, 'reserved', ?, NULL, ?, ?)`,
      bookingKey,
      date,
      isoWeekKey(date),
      credits,
      now,
      args.actor,
      args.dryRun ? 1 : 0,
    );

    // A real reservation consumes a slot; report what is left *after* it.
    const after = args.dryRun ? counts : { day: counts.day + 1, week: counts.week + 1 };
    return { ok: true, capsRemaining: remaining(caps, after) };
  }

  /** Promotes a reservation to `confirmed` and records the upstream booking id. */
  async confirmBooking(args: { bookingKey: string; bookingId: string }): Promise<void> {
    const bookingKey = requireText(args.bookingKey, "bookingKey");
    const bookingId = requireText(args.bookingId, "bookingId");
    const found = this.#count(
      "SELECT COUNT(*) AS n FROM bookings_ledger WHERE booking_key = ?",
      bookingKey,
    );
    this.#sql.exec(
      `UPDATE bookings_ledger SET booking_id = ?, status = 'confirmed', confirmed_at = ?
        WHERE booking_key = ?`,
      bookingId,
      this.now(),
      bookingKey,
    );
    if (found === 0) {
      // The reservation was pruned (or never made). Never fail a *successful* booking
      // over bookkeeping: record it so the caps and the audit trail stay honest.
      console.warn("session: confirmBooking had no reservation to promote", { bookingKey });
    }
  }

  /** Drops a reservation whose upstream booking failed, freeing the slot immediately. */
  async releaseBooking(args: { bookingKey: string }): Promise<void> {
    this.#sql.exec(
      "DELETE FROM bookings_ledger WHERE booking_key = ? AND status = 'reserved'",
      requireText(args.bookingKey, "bookingKey"),
    );
  }

  /** Marks a confirmed booking cancelled, which frees its day and week slot. */
  async cancelLedger(args: { bookingId: string }): Promise<void> {
    this.#sql.exec(
      "UPDATE bookings_ledger SET status = 'cancelled' WHERE booking_id = ?",
      requireText(args.bookingId, "bookingId"),
    );
  }

  /** How many bookings the caps still allow on `date` and in its ISO week. */
  async capsRemaining(date: string): Promise<CapsRemaining> {
    const day = normaliseDate(date);
    return remaining(this.loadConfig(), this.#counts(day, this.now()));
  }

  // ------------------------------------------------------------ idempotency

  /** Returns a stored result for `key`, or `undefined` when absent or expired. */
  async idempotencyGet(key: string): Promise<JsonValue | undefined> {
    const row = this.#sql
      .exec<{ result_json: string; expires_at: number }>(
        "SELECT result_json, expires_at FROM idempotency WHERE key = ?",
        requireText(key, "key"),
      )
      .toArray()[0];
    if (!row) return undefined;
    if (row.expires_at <= this.now()) {
      this.#sql.exec("DELETE FROM idempotency WHERE key = ?", key);
      return undefined;
    }
    return JSON.parse(row.result_json) as JsonValue;
  }

  /** Stores `value` (JSON) under `key` for `ttlSec` seconds (default 24h). */
  async idempotencyPut(key: string, value: unknown, ttlSec = IDEMPOTENCY_TTL_SEC): Promise<void> {
    const now = this.now();
    const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.trunc(ttlSec) : IDEMPOTENCY_TTL_SEC;
    this.#sql.exec(
      `INSERT OR REPLACE INTO idempotency (key, kind, result_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      requireText(key, "key"),
      kindOf(key),
      JSON.stringify(value ?? null),
      now,
      now + ttl * 1000,
    );
  }

  // -------------------------------------------------------------- locations

  /**
   * Remembers building metadata (timezone, offset, currency) so a later search by
   * bare `location_id` can send WeWork the right `locationOffset` without a
   * warm per-request cache. Live-verified: a wrong offset makes get-spaces answer
   * an empty list for buildings west of UTC.
   */
  async rememberLocations(locations: Location[]): Promise<void> {
    const now = this.now();
    for (const location of locations) {
      if (!location?.locationId) continue;
      this.#sql.exec(
        "INSERT OR REPLACE INTO locations (location_id, json, updated_at) VALUES (?, ?, ?)",
        location.locationId,
        JSON.stringify(location),
        now,
      );
    }
  }

  async getLocation(locationId: string): Promise<Location | undefined> {
    const row = this.#sql
      .exec<{ json: string }>("SELECT json FROM locations WHERE location_id = ?", locationId)
      .toArray()[0];
    if (!row) return undefined;
    try {
      return JSON.parse(row.json) as Location;
    } catch {
      return undefined;
    }
  }

  // --------------------------------------------------------------- api keys

  /**
   * Stores a key the admin pages just minted.
   *
   * The caller generates the key, hashes it and throws the plaintext away; this
   * object only ever sees `sha256`. Validation is repeated here rather than trusted
   * from the caller, because this table is what the front door authenticates
   * against.
   *
   * @throws AppError `VALIDATION` for a bad name, scope set or digest, and for a
   * duplicate id or digest.
   */
  async createApiKey(input: {
    id: string;
    name: string;
    sha256: string;
    scopes: Scope[];
  }): Promise<void> {
    const id = requireText(input.id, "id");
    const name = requireKeyName(input.name);
    const sha256 = requireDigest(input.sha256);
    const scopes = requireScopes(input.scopes);

    if (this.#count("SELECT COUNT(*) AS n FROM api_keys WHERE id = ?", id) > 0) {
      throw new AppError("VALIDATION", "An API key with that id already exists.");
    }
    if (this.#count("SELECT COUNT(*) AS n FROM api_keys WHERE sha256 = ?", sha256) > 0) {
      throw new AppError("VALIDATION", "That API key already exists.");
    }

    this.#sql.exec(
      `INSERT INTO api_keys (id, name, sha256, scopes, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      id,
      name,
      sha256,
      JSON.stringify(scopes),
      this.now(),
    );
  }

  /** Every key, newest first, revoked ones included. Never returns a digest. */
  async listApiKeys(): Promise<ApiKeySummary[]> {
    const rows = this.#sql
      .exec<ApiKeyRow>(
        `SELECT id, name, scopes, created_at, last_used_at, revoked_at
           FROM api_keys ORDER BY created_at DESC, rowid DESC`,
      )
      .toArray();
    return rows.map((row) => {
      const summary: ApiKeySummary = {
        id: row.id,
        name: row.name,
        scopes: decodeScopes(row.scopes),
        createdAt: new Date(row.created_at).toISOString(),
      };
      if (row.last_used_at !== null) summary.lastUsedAt = new Date(row.last_used_at).toISOString();
      if (row.revoked_at !== null) summary.revokedAt = new Date(row.revoked_at).toISOString();
      return summary;
    });
  }

  /**
   * Revokes a key. The row is kept so the audit trail still resolves its name.
   *
   * @returns `true` when this call revoked it; `false` when the id is unknown or it
   * was already revoked.
   */
  async revokeApiKey(id: string): Promise<boolean> {
    const key = requireText(id, "id");
    const live = this.#count(
      "SELECT COUNT(*) AS n FROM api_keys WHERE id = ? AND revoked_at IS NULL",
      key,
    );
    if (live === 0) return false;
    this.#sql.exec(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      this.now(),
      key,
    );
    return true;
  }

  /**
   * The front door's lookup: a presented key's digest to the actor behind it.
   *
   * Revoked keys never match, so revoking one takes effect on the next request.
   * `last_used_at` is refreshed at most once per {@link API_KEY_LAST_USED_THROTTLE_MS}
   * per key.
   *
   * @param sha256 lower-case hex digest of the presented key.
   * @returns the key's id, name and scopes, or `undefined` when nothing active matches.
   */
  async matchApiKey(sha256: string): Promise<ApiKeyMatch | undefined> {
    const digest = typeof sha256 === "string" ? sha256.trim().toLowerCase() : "";
    // A malformed digest cannot match anything; answer "no" rather than throwing, so
    // a junk credential is a 401 and never a 500.
    if (!/^[0-9a-f]{64}$/.test(digest)) return undefined;

    const row = this.#sql
      .exec<ApiKeyRow>(
        `SELECT id, name, scopes, created_at, last_used_at, revoked_at
           FROM api_keys WHERE sha256 = ? AND revoked_at IS NULL`,
        digest,
      )
      .toArray()[0];
    if (!row) return undefined;

    const now = this.now();
    if (row.last_used_at === null || now - row.last_used_at >= API_KEY_LAST_USED_THROTTLE_MS) {
      this.#sql.exec("UPDATE api_keys SET last_used_at = ? WHERE id = ?", now, row.id);
    }
    return { id: row.id, name: row.name, scopes: decodeScopes(row.scopes) };
  }

  // ------------------------------------------------------------------ audit

  /** Appends one audit row. `entry.args` is redacted here, never by the caller. */
  async audit(entry: AuditInput): Promise<void> {
    this.#sql.exec(
      `INSERT INTO audit (ts, actor, tool, args_redacted, outcome, booking_id, credits, dry_run, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.now(),
      entry.actor ?? "unknown",
      entry.tool ?? "unknown",
      entry.args === undefined ? null : JSON.stringify(scrubArgs(entry.args)),
      entry.outcome,
      entry.bookingId ?? null,
      entry.credits ?? null,
      entry.dryRun ? 1 : 0,
      entry.error ?? null,
    );
  }

  /** The most recent audit rows, newest first. */
  async listAudit(opts: { limit?: number } = {}): Promise<AuditEntry[]> {
    const limit = clamp(opts.limit ?? 100, 1, 1000);
    const rows = this.#sql
      .exec<AuditRow>(
        `SELECT id, ts, actor, tool, args_redacted, outcome, booking_id, credits, dry_run, error
           FROM audit ORDER BY id DESC LIMIT ?`,
        limit,
      )
      .toArray();
    return rows.map((row) => {
      const entry: AuditEntry = {
        id: row.id,
        ts: new Date(row.ts).toISOString(),
        actor: row.actor,
        tool: row.tool,
        outcome: row.outcome,
        dryRun: row.dry_run === 1,
      };
      if (row.args_redacted !== null) {
        entry.args = JSON.parse(row.args_redacted) as JsonValue;
      }
      if (row.booking_id !== null) entry.bookingId = row.booking_id;
      if (row.credits !== null) entry.credits = row.credits;
      if (row.error !== null) entry.error = row.error;
      return entry;
    });
  }

  // ------------------------------------------------------------ maintenance

  /**
   * Daily cron work: refresh a token that expires within six hours, then prune
   * expired idempotency rows, audit rows past {@link AUDIT_RETENTION_MS} and
   * abandoned reservations.
   *
   * Never throws: a refresh failure is recorded as `last_error` and reported in the
   * summary, because the prune must still happen and a throwing cron is retried.
   */
  async maintain(): Promise<MaintenanceSummary> {
    const now = this.now();
    const row = this.#readRow();
    let refreshed = false;
    let error: string | undefined;

    if (row?.refresh_token && row.expires_at - now < REFRESH_WINDOW_MS) {
      try {
        this.#persist(await this.#refresh(row));
        refreshed = true;
      } catch (err) {
        error = this.#recordError(err);
      }
    }

    const pruned =
      this.#prune("idempotency", "expires_at <= ?", now) +
      this.#prune("audit", "ts < ?", now - AUDIT_RETENTION_MS) +
      this.#prune(
        "bookings_ledger",
        "status = 'reserved' AND created_at < ?",
        now - STALE_RESERVATION_MS,
      );

    const summary: MaintenanceSummary = { refreshed, pruned, session: this.#sessionInfo() };
    if (error !== undefined) summary.error = error;
    return summary;
  }

  // ------------------------------------------------------------- test seams

  /** The clock. Overridden per-instance by tests via `runInDurableObject()`. */
  protected now(): number {
    return Date.now();
  }

  /** Parsed configuration. Overridden per-instance by tests via `runInDurableObject()`. */
  protected loadConfig(): Config {
    return parseConfig(this.env);
  }

  /** Outbound `fetch` handed to the auth module; a seam for offline tests. */
  protected fetcher(): typeof fetch {
    return (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
  }

  // --------------------------------------------------------------- internals

  get #sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  #migrate(): void {
    const sql = this.#sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER NOT NULL,
      obtained_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      user_uuid TEXT NOT NULL,
      last_error TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      kind TEXT,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS bookings_ledger (
      booking_key TEXT PRIMARY KEY,
      booking_id TEXT,
      date TEXT NOT NULL,
      iso_week TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      actor TEXT NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      tool TEXT NOT NULL,
      args_redacted TEXT,
      outcome TEXT NOT NULL,
      booking_id TEXT,
      credits INTEGER,
      dry_run INTEGER NOT NULL DEFAULT 0,
      error TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS locations (
      location_id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_ledger_date ON bookings_ledger (date, status)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_ledger_week ON bookings_ledger (iso_week, status)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_ledger_booking ON bookings_ledger (booking_id)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit (ts)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency (expires_at)");
  }

  #readRow(): SessionRow | undefined {
    return this.#sql
      .exec<SessionRow>(
        `SELECT access_token, refresh_token, expires_at, obtained_at, source, user_uuid, last_error
           FROM session WHERE id = ?`,
        SESSION_ROW_ID,
      )
      .toArray()[0];
  }

  /** The one place a token is written. Clears `last_error` on success. */
  #persist(rec: SessionRecord): void {
    const accessToken = requireText(rec.accessToken, "accessToken");
    if (!Number.isFinite(rec.expiresAt)) {
      throw new AppError("VALIDATION", "The session record has no numeric expiresAt.");
    }
    this.#sql.exec(
      `INSERT OR REPLACE INTO session
         (id, access_token, refresh_token, expires_at, obtained_at, source, user_uuid, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      SESSION_ROW_ID,
      accessToken,
      rec.refreshToken ?? null,
      Math.trunc(rec.expiresAt),
      Math.trunc(rec.obtainedAt ?? this.now()),
      rec.source,
      rec.userUuid ?? "",
    );
  }

  /**
   * Runs one refresh-then-login attempt. Callers reach this through
   * {@link WeWorkSession.getAccessToken}, which guarantees only one runs at a time.
   */
  async #obtain(row: SessionRow | undefined): Promise<SessionRecord> {
    const config = this.loadConfig();

    if (row?.refresh_token) {
      try {
        const record = await this.#refresh(row);
        this.#persist(record);
        return record;
      } catch (err) {
        // A rejected refresh token is recoverable by logging in again; anything else
        // (blocked, rate-limited, upstream down) must surface as-is.
        if (!(err instanceof AppError) || err.code !== "UPSTREAM_AUTH") {
          this.#recordError(err);
          throw err;
        }
      }
    }

    if (config.hasWeworkCredentials && config.loginStrategy !== "manual") {
      try {
        const strategy = createHeadlessLoginStrategy({
          username: config.weworkUsername ?? "",
          password: config.weworkPassword ?? "",
          fetch: this.fetcher(),
          now: () => this.now(),
        });
        const record = await strategy.login();
        this.#persist(record);
        return record;
      } catch (err) {
        this.#recordError(err);
        throw err;
      }
    }

    const base = config.publicBaseUrl || "<base>";
    const hint = `Ask the user to open ${base}/admin/connect and paste a fresh WeWork session.`;
    if (row) {
      const expired = new AppError(
        "SESSION_EXPIRED",
        "The stored WeWork session has expired and cannot be renewed automatically.",
        { hint },
      );
      this.#recordError(expired);
      throw expired;
    }
    throw new AppError("SESSION_MISSING", "No WeWork session is connected.", { hint });
  }

  async #refresh(row: SessionRow): Promise<SessionRecord> {
    const record = await refreshSession(rowToRecord(row), {
      fetch: this.fetcher(),
      now: () => this.now(),
    });
    return { ...record, obtainedAt: this.now() };
  }

  /** Stores a redacted failure reason for `/healthz` and `/admin`; returns it. */
  #recordError(err: unknown): string {
    const message = errorMessage(err);
    this.#sql.exec("UPDATE session SET last_error = ? WHERE id = ?", message, SESSION_ROW_ID);
    return message;
  }

  #sessionInfo(): SessionInfo {
    const row = this.#readRow();
    if (!row) return { state: "none", source: "none", hasRefreshToken: false };
    const msLeft = row.expires_at - this.now();
    const info: SessionInfo = {
      state: msLeft <= 0 ? "expired" : msLeft < REFRESH_WINDOW_MS ? "expiring" : "valid",
      source: row.source as SessionInfo["source"],
      obtainedAt: new Date(row.obtained_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      hasRefreshToken: row.refresh_token !== null && row.refresh_token !== "",
    };
    if (row.last_error !== null) info.lastError = row.last_error;
    return info;
  }

  /** Cap usage for a date and its ISO week, ignoring dry runs and stale reservations. */
  #counts(date: string, now: number, excludeKey = ""): CapsRemaining {
    const cutoff = now - STALE_RESERVATION_MS;
    const where = `dry_run = 0 AND status IN ${ACTIVE_STATUSES}
        AND (status = 'confirmed' OR created_at >= ?)
        AND booking_key <> ?`;
    const day = this.#count(
      `SELECT COUNT(*) AS n FROM bookings_ledger WHERE date = ? AND ${where}`,
      date,
      cutoff,
      excludeKey,
    );
    const week = this.#count(
      `SELECT COUNT(*) AS n FROM bookings_ledger WHERE iso_week = ? AND ${where}`,
      isoWeekKey(date),
      cutoff,
      excludeKey,
    );
    return { day, week };
  }

  #count(query: string, ...bindings: SqlStorageValue[]): number {
    return this.#sql.exec<CountRow>(query, ...bindings).one().n;
  }

  /**
   * Deletes the rows of `table` matching `where` and returns how many went.
   *
   * `table` and `where` are literals from this module only — never caller input.
   */
  #prune(table: string, where: string, cutoff: number): number {
    const doomed = this.#count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, cutoff);
    if (doomed > 0) this.#sql.exec(`DELETE FROM ${table} WHERE ${where}`, cutoff);
    return doomed;
  }
}

/**
 * Resolves the one session Durable Object stub.
 *
 * Always go through this helper rather than calling `idFromName` inline, so the
 * single-instance invariant (and the future multi-account seam) lives in one place.
 */
export function getSessionStub(env: Env, accountId = "default"): DurableObjectStub<WeWorkSession> {
  const name = accountId === "default" ? SESSION_DO_NAME : `session:${accountId}`;
  return env.SESSION.get(env.SESSION.idFromName(name));
}

/**
 * ISO-8601 week key (`"2026-W37"`, Monday-Sunday) for a `YYYY-MM-DD` date.
 *
 * The week is derived from the *date string*, not from any wall clock: a booking on
 * 2026-01-01 belongs to the week that contains it regardless of where the caller is.
 */
export function isoWeekKey(date: string): string {
  const day = normaliseDate(date);
  const parts = day.split("-").map((p) => Number.parseInt(p, 10));
  const [year = 1970, month = 1, dayOfMonth = 1] = parts;
  const ms = Date.UTC(year, month - 1, dayOfMonth);
  // Shift to the Thursday of the same ISO week: its calendar year is the ISO year.
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  const thursday = new Date(ms + (3 - weekday) * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
  const week = 1 + Math.round((thursday.getTime() - week1Monday) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function remaining(caps: Config | CapsLimits, used: CapsRemaining): CapsRemaining {
  return {
    day: Math.max(0, caps.maxBookingsPerDay - used.day),
    week: Math.max(0, caps.maxBookingsPerWeek - used.week),
  };
}

interface CapsLimits {
  maxBookingsPerDay: number;
  maxBookingsPerWeek: number;
}

function rowToRecord(row: SessionRow): SessionRecord {
  const record: SessionRecord = {
    accessToken: row.access_token,
    expiresAt: row.expires_at,
    obtainedAt: row.obtained_at,
    source: row.source as SessionRecord["source"],
    userUuid: row.user_uuid,
  };
  if (row.refresh_token) record.refreshToken = row.refresh_token;
  return record;
}

/** `"booking:abc"` -> `"booking"`; a coarse label for the idempotency row. */
function kindOf(key: string): string {
  const head = key.split(":")[0] ?? "";
  return head && head !== key ? head : "generic";
}

function normaliseDate(date: string): string {
  const trimmed = typeof date === "string" ? date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new AppError("VALIDATION", "date must be a calendar date in YYYY-MM-DD form.");
  }
  return trimmed;
}

/** A key name: something the operator will recognise in the list and the audit log. */
function requireKeyName(value: string): string {
  const trimmed = requireText(value, "name");
  if (trimmed.length > API_KEY_NAME_MAX) {
    throw new AppError(
      "VALIDATION",
      `An API key name must be 1 to ${API_KEY_NAME_MAX} characters.`,
    );
  }
  return trimmed;
}

/** Lower-case hex SHA-256, exactly 64 characters. */
function requireDigest(value: string): string {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new AppError("VALIDATION", "sha256 must be a 64-character hex SHA-256 digest.");
  }
  return trimmed;
}

/** A non-empty subset of the three scopes, de-duplicated and in canonical order. */
function requireScopes(value: Scope[]): Scope[] {
  const offered = Array.isArray(value) ? value : [];
  const scopes = SCOPE_ORDER.filter((scope) => offered.includes(scope));
  if (scopes.length === 0) {
    throw new AppError("VALIDATION", "scopes must be a non-empty subset of read, write, admin.");
  }
  return scopes;
}

const SCOPE_ORDER: readonly Scope[] = ["read", "write", "admin"] as const;

/** Reads the stored `scopes` JSON back, tolerating a row written by an older build. */
function decodeScopes(json: string): Scope[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? SCOPE_ORDER.filter((scope) => parsed.includes(scope)) : [];
  } catch {
    return [];
  }
}

function requireText(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new AppError("VALIDATION", `${field} must be a non-empty string.`);
  }
  return trimmed;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Anything that looks like a credential, whatever key it arrived under. */
const TOKEN_LIKE = /^(?:[A-Za-z0-9_-]{8,}\.){2}[A-Za-z0-9_-]{8,}$|^[A-Za-z0-9_.\-=+/]{40,}$/;

/**
 * Audit-log scrubber: `redact()` by key, then by *shape*.
 *
 * `redact()` only knows key names, so a JWT passed as `{ session: "eyJ…" }` would
 * survive it. The audit log is the one place raw tool arguments are persisted, so
 * anything token-shaped is replaced here too.
 */
function scrubArgs(args: unknown): unknown {
  return scrubShapes(redact(args), 0);
}

function scrubShapes(value: unknown, depth: number): unknown {
  if (typeof value === "string") return TOKEN_LIKE.test(value) ? REDACTED : value;
  if (value === null || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => scrubShapes(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = scrubShapes(item, depth + 1);
  }
  return out;
}

/** A one-line, token-free failure reason suitable for `last_error`. */
function errorMessage(err: unknown): string {
  if (err instanceof AppError) return `${err.code}: ${scrubShapes(err.message, 0) as string}`;
  if (err instanceof Error) return scrubShapes(err.message, 0) as string;
  return "Unknown error";
}
