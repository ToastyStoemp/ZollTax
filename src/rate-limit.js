/**
 * Tiny in-memory fixed-window rate limiter (zero-dep). Keyed by an arbitrary
 * string (typically "<scope>:<client-ip>"). Single-process only — a multi-node
 * deployment would need a shared store. Deterministic given `now`, so the core
 * is unit-testable.
 */

const buckets = new Map(); // key → { count, resetAt }

/**
 * Count one hit against `key`. Returns { ok, remaining, retryAfterMs }.
 * `ok` is false once more than `max` hits land inside the `windowMs` window.
 */
export function rateLimit(key, max, windowMs, now = Date.now()) {
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  const ok = b.count <= max;
  return { ok, remaining: Math.max(0, max - b.count), retryAfterMs: ok ? 0 : b.resetAt - now };
}

/** Drop expired buckets so the map can't grow without bound. */
export function sweep(now = Date.now()) {
  for (const [key, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(key);
  }
}

/** For tests. */
export function _reset() {
  buckets.clear();
}

// Periodic cleanup; unref so it never keeps the process alive.
const timer = setInterval(() => sweep(), 5 * 60 * 1000);
if (typeof timer.unref === 'function') timer.unref();
