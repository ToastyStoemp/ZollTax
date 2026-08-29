/**
 * Persistent daily spend guard for the invoice reader — the real bill cap.
 *
 * A single JSON counter in the data dir (0600) tracks calls + tokens for the
 * current UTC day and resets at midnight. Unlike the in-memory rate limiter this
 * survives restarts, so a crash-loop or a busy day can't quietly run up the
 * Anthropic bill. Env: ZOLLTAX_AI_DAILY_CALLS, ZOLLTAX_AI_DAILY_TOKENS.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './store.js';

const FILE = join(DATA_DIR, 'ai-usage.json');
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

export function aiLimits(env = process.env) {
  return {
    dailyCalls: Number(env.ZOLLTAX_AI_DAILY_CALLS || 100),
    dailyTokens: Number(env.ZOLLTAX_AI_DAILY_TOKENS || 2_000_000),
  };
}

function read(now) {
  let o;
  try { o = JSON.parse(readFileSync(FILE, 'utf8')); } catch { o = {}; }
  if (o.day !== dayOf(now)) return { day: dayOf(now), calls: 0, tokens: 0 };
  return { day: o.day, calls: Number(o.calls) || 0, tokens: Number(o.tokens) || 0 };
}
function write(o) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 });
  renameSync(tmp, FILE);
}

/** Remaining budget for today. Read-only — does not consume. */
export function aiQuota(env = process.env, now = Date.now()) {
  const lim = aiLimits(env);
  const u = read(now);
  const remainingCalls = Math.max(0, lim.dailyCalls - u.calls);
  const remainingTokens = Math.max(0, lim.dailyTokens - u.tokens);
  return {
    ok: remainingCalls > 0 && remainingTokens > 0,
    remainingCalls,
    remainingTokens,
    dailyCalls: lim.dailyCalls,
    dailyTokens: lim.dailyTokens,
    day: u.day,
  };
}

/** Record one completed call's token usage. Returns the updated day totals. */
export function aiRecord(usage, now = Date.now()) {
  const u = read(now);
  u.calls += 1;
  u.tokens += (Number(usage && usage.inputTokens) || 0) + (Number(usage && usage.outputTokens) || 0);
  write(u);
  return u;
}
