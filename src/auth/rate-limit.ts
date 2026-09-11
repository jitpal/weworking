/**
 * Deliberately naive per-IP failure throttle for the two password forms
 * (`POST /admin/login` and `POST /oauth/authorize`).
 *
 * It lives in module memory, so it is per-isolate and evaporates on eviction. That
 * is the honest trade: `ADMIN_PASSWORD` is the only thing in front of the session
 * store, and a counter that survives 10 minutes inside one isolate already turns an
 * online guessing attack from "thousands of tries a second" into something slow
 * enough to notice, with no Durable Object round trip on the hot path. A determined
 * attacker can reset it by spreading requests across colos; a long password is the
 * real defence, which is why the self-hosting guide says so.
 */

/** Failures allowed inside {@link WINDOW_MS} before a bucket locks. */
export const MAX_FAILURES = 5;
/** Sliding window length: 10 minutes. */
export const WINDOW_MS = 10 * 60 * 1000;

/** `${bucket}:${ip}` -> epoch-ms timestamps of recent failures. */
const failures = new Map<string, number[]>();

/** Caps the map so a spray of distinct source IPs cannot grow it without bound. */
const MAX_TRACKED_KEYS = 5_000;

/** Best-effort client address: Cloudflare's own header first, then `X-Forwarded-For`. */
export function clientIp(request: Request): string {
  const direct = request.headers.get("CF-Connecting-IP");
  if (direct) return direct;
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

function prune(key: string, now: number): number[] {
  const recent = (failures.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length === 0) failures.delete(key);
  else failures.set(key, recent);
  return recent;
}

/** How long the caller must wait, in seconds; `0` when it is not limited. */
export function rateLimitRetryAfter(bucket: string, ip: string, now: number = Date.now()): number {
  const recent = prune(`${bucket}:${ip}`, now);
  if (recent.length < MAX_FAILURES) return 0;
  const oldest = recent[0] ?? now;
  return Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
}

/** True when this bucket/IP has spent its {@link MAX_FAILURES} inside the window. */
export function isRateLimited(bucket: string, ip: string, now: number = Date.now()): boolean {
  return rateLimitRetryAfter(bucket, ip, now) > 0;
}

/** Records one failed password attempt. */
export function recordFailure(bucket: string, ip: string, now: number = Date.now()): void {
  const key = `${bucket}:${ip}`;
  const recent = prune(key, now);
  if (failures.size >= MAX_TRACKED_KEYS && !failures.has(key)) failures.clear();
  recent.push(now);
  failures.set(key, recent);
}

/** Forgets a bucket/IP — called after a successful sign-in, and by tests. */
export function clearFailures(bucket?: string, ip?: string): void {
  if (bucket === undefined) {
    failures.clear();
    return;
  }
  if (ip === undefined) {
    for (const key of [...failures.keys()]) {
      if (key.startsWith(`${bucket}:`)) failures.delete(key);
    }
    return;
  }
  failures.delete(`${bucket}:${ip}`);
}
