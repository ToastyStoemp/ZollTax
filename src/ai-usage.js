/**
 * Persistent daily spend guard for the invoice reader — the real bill cap.
 *
 * One JSON file in the data dir (0600) holds a per-tenant { day, calls, tokens }
 * counter that resets at each UTC midnight. Unlike the in-memory rate limiter
 * this survives restarts, so a crash-loop or a busy day can't quietly run up the
 * Anthropic bill. Limits are the tenant's own (configurable in Settings), passed
 * in by the caller.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './store.js';

const FILE = join(DATA_DIR, 'ai-usage.json');
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

function readAll() {
  try {
    const o = JSON.parse(readFileSync(FILE, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
function writeAll(map) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
  renameSync(tmp, FILE);
}
function entry(map, userId, now) {
  const e = map[userId];
  if (!e || e.day !== dayOf(now)) return { day: dayOf(now), calls: 0, tokens: 0 };
  return { day: e.day, calls: Number(e.calls) || 0, tokens: Number(e.tokens) || 0 };
}

/** Remaining budget for this tenant today. Read-only — does not consume. */
export function aiQuota(userId, limits, now = Date.now()) {
  const u = entry(readAll(), userId, now);
  const remainingCalls = Math.max(0, limits.dailyCalls - u.calls);
  const remainingTokens = Math.max(0, limits.dailyTokens - u.tokens);
  return {
    ok: remainingCalls > 0 && remainingTokens > 0,
    remainingCalls,
    remainingTokens,
    dailyCalls: limits.dailyCalls,
    dailyTokens: limits.dailyTokens,
    day: u.day,
  };
}

/** Record one completed call's token usage against this tenant. */
export function aiRecord(userId, usage, now = Date.now()) {
  const map = readAll();
  const u = entry(map, userId, now);
  u.calls += 1;
  u.tokens += (Number(usage && usage.inputTokens) || 0) + (Number(usage && usage.outputTokens) || 0);
  map[userId] = u;
  writeAll(map);
  return u;
}
