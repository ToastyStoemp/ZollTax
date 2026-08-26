/**
 * Server-side login sessions — the source of truth for who's logged in, so
 * sessions can be listed (device, IP, geo, last seen) and revoked remotely.
 * Replaces the old stateless cookie. Held in memory for speed and persisted to
 * data/sessions.json for durability across restarts.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './store.js';

const FILE = join(DATA_DIR, 'sessions.json');
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // absolute lifetime
const TOUCH_MS = 5 * 60 * 1000; // only persist lastSeen this often

/** @type {Map<string, object>} */
const sessions = new Map();

(function load() {
  try {
    const arr = JSON.parse(readFileSync(FILE, 'utf8'));
    const now = Date.now();
    for (const s of arr) if (!s.revokedAt && now - s.createdAt < TTL_MS) sessions.set(s.id, s);
  } catch {
    /* none yet */
  }
})();

let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 500);
  flushTimer.unref?.();
}
function flush() {
  flushTimer = null;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify([...sessions.values()]));
    renameSync(tmp, FILE);
  } catch (e) {
    console.error(`[zollevents] session flush failed: ${e.message}`);
  }
}

export function createSession({ userId, ip, ua, device, geo }) {
  const id = randomBytes(24).toString('hex');
  const now = Date.now();
  sessions.set(id, { id, userId, createdAt: now, lastSeenAt: now, ip: ip || '', ua: ua || '', device: device || '', geo: geo || null, revokedAt: null });
  scheduleFlush();
  return id;
}

/** Returns the live session for a cookie id, or null (expired/revoked/unknown). */
export function getSession(id) {
  const s = sessions.get(id);
  if (!s || s.revokedAt || Date.now() - s.createdAt >= TTL_MS) return null;
  return s;
}

export function touchSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  const now = Date.now();
  if (now - s.lastSeenAt > TOUCH_MS) {
    s.lastSeenAt = now;
    scheduleFlush();
  }
}

export function revokeSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  scheduleFlush();
  return true;
}

export function revokeAllForUser(userId, exceptId) {
  let n = 0;
  for (const [id, s] of sessions) {
    if (s.userId === userId && id !== exceptId) {
      sessions.delete(id);
      n++;
    }
  }
  if (n) scheduleFlush();
  return n;
}

const publicShape = (s) => ({
  id: s.id,
  userId: s.userId,
  createdAt: s.createdAt,
  lastSeenAt: s.lastSeenAt,
  ip: s.ip,
  device: s.device,
  geo: s.geo,
});

export function listForUser(userId) {
  return [...sessions.values()].filter((s) => s.userId === userId).sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(publicShape);
}
export function listAll() {
  return [...sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(publicShape);
}
