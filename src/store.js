/**
 * Persistence for ZollTax's multi-tenant model.
 *
 *   Users  : data/users.json — one record per account (a "client"). Passwords
 *            are scrypt-hashed; the account id doubles as the tenant id.
 *   Config : data/clients/<userId>.enc — the tenant's integration keys, an
 *            { ENV_KEY: value } object encrypted with AES-256-GCM (crypto.js).
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can't corrupt the
 * store. No external dependencies.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, encryptJson, decryptJson, randomId } from './crypto.js';
import { CONFIG_KEYS } from './config-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.ZOLLTAX_DATA_DIR
  ? process.env.ZOLLTAX_DATA_DIR
  : join(__dirname, '..', 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');
const CLIENTS_DIR = join(DATA_DIR, 'clients');

function ensureDirs() {
  mkdirSync(CLIENTS_DIR, { recursive: true });
}
function writeAtomic(file, contents) {
  ensureDirs();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, file);
}

// ── Users ────────────────────────────────────────────────────────────────────

function readUsers() {
  try {
    return JSON.parse(readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writeUsers(users) {
  writeAtomic(USERS_FILE, JSON.stringify(users, null, 2));
}

/** Public shape — never includes the password hash. */
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name || '', role: u.role, createdAt: u.createdAt, disabledAt: u.disabledAt || null };
}

export function listUsers() {
  return readUsers().map(publicUser);
}
export function getUser(id) {
  return publicUser(readUsers().find((u) => u.id === id));
}
export function countUsers() {
  return readUsers().length;
}

export function createUser({ email, password, name = '', role = 'client' }) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm || !/^[^@\s]+@[^@\s]+$/.test(norm)) throw new Error('A valid email is required.');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  const users = readUsers();
  if (users.some((u) => u.email === norm)) throw new Error('An account with that email already exists.');
  const user = {
    id: randomId(),
    email: norm,
    name: String(name || '').trim(),
    role: role === 'admin' ? 'admin' : 'client',
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
    disabledAt: null,
  };
  users.push(user);
  writeUsers(users);
  return publicUser(user);
}

/** Verifies credentials; returns the public user or null. */
export function authenticate(email, password) {
  const norm = String(email || '').trim().toLowerCase();
  const user = readUsers().find((u) => u.email === norm);
  if (!user || user.disabledAt) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return publicUser(user);
}

/** Raw record — server-side only (includes passwordHash + 2FA fields). */
export function getUserRecord(id) {
  return readUsers().find((u) => u.id === id) || null;
}

/** Merge a small patch of allowed fields (2FA state, name) into a user record. */
export function patchUser(id, patch) {
  const users = readUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  for (const k of ['totpEnc', 'totpEnabled', 'recovery', 'name']) if (k in patch) u[k] = patch[k];
  writeUsers(users);
  return publicUser(u);
}

export function has2fa(id) {
  const u = getUserRecord(id);
  return !!(u && u.totpEnabled);
}

export function setPassword(id, password) {
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters.');
  const users = readUsers();
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error('User not found.');
  user.passwordHash = hashPassword(password);
  writeUsers(users);
}

export function deleteUser(id) {
  const users = readUsers();
  const next = users.filter((u) => u.id !== id);
  if (next.length === users.length) throw new Error('User not found.');
  writeUsers(next);
  try {
    unlinkSync(join(CLIENTS_DIR, `${id}.enc`));
  } catch {
    /* no config file — fine */
  }
}

/**
 * Seed the first admin from the environment on an empty store, so a fresh
 * deployment has exactly one way in. No-op once any user exists.
 */
export function bootstrapAdmin() {
  if (readUsers().length) return;
  const email = process.env.ZOLLTAX_ADMIN_EMAIL;
  const password = process.env.ZOLLTAX_ADMIN_PASSWORD;
  if (!email || !password) return;
  try {
    createUser({ email, password, name: 'Admin', role: 'admin' });
    console.log(`[zolltax] seeded admin account ${email}`);
  } catch (e) {
    console.error(`[zolltax] could not seed admin: ${e.message}`);
  }
}

// ── Per-tenant config (encrypted) ────────────────────────────────────────────

const configFile = (userId) => join(CLIENTS_DIR, `${userId}.enc`);

/** Decrypted { ENV_KEY: value } for a tenant, or {} if none saved yet. */
export function getTenantConfig(userId) {
  const file = configFile(userId);
  if (!existsSync(file)) return {};
  try {
    return decryptJson(readFileSync(file, 'utf8')) || {};
  } catch (e) {
    console.error(`[zolltax] failed to decrypt config for ${userId}: ${e.message}`);
    return {};
  }
}

/**
 * Merge changes into a tenant's config. `set` writes non-empty values (only
 * whitelisted keys); `clear` removes keys. Returns the new decrypted config.
 */
export function saveTenantConfig(userId, { set = {}, clear = [], enabled } = {}) {
  const cfg = getTenantConfig(userId);
  for (const key of Object.keys(set)) {
    if (!CONFIG_KEYS.includes(key)) continue;
    const value = set[key];
    if (value === undefined || value === null || value === '') continue;
    cfg[key] = String(value);
  }
  for (const key of clear) {
    if (CONFIG_KEYS.includes(key)) delete cfg[key];
  }
  // Per-group enable flags (group disabled → its integration is ignored).
  if (enabled && typeof enabled === 'object') {
    cfg.__enabled = { ...(cfg.__enabled || {}) };
    for (const [group, on] of Object.entries(enabled)) cfg.__enabled[group] = !!on;
  }
  writeAtomic(configFile(userId), encryptJson(cfg));
  return cfg;
}

/** A group is on unless explicitly disabled. */
export function groupEnabled(cfg, groupId) {
  return cfg?.__enabled?.[groupId] !== false;
}
