/**
 * Zero-dependency crypto for ZollTax multi-tenant auth + secret storage.
 * Uses only node:crypto — no external packages.
 *
 *   Passwords : scrypt with a per-user random salt (timing-safe verify).
 *   Secrets   : AES-256-GCM under a master key from the environment, so each
 *               tenant's API keys are encrypted at rest.
 *   Sessions  : short HMAC-signed tokens (stateless; survive a restart).
 */

import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Master key + session secret ──────────────────────────────────────────────

// Where a generated key is persisted when no env key is supplied. Kept on the
// data volume (same dir as store.js) so it survives restarts and image rebuilds
// with no .env round-trip — the robust default for containers. Computed inline
// (not imported from store.js) to avoid an import cycle.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ZOLLTAX_DATA_DIR || join(__dirname, '..', 'data');
const KEY_FILE = join(DATA_DIR, 'master.key');

/**
 * 32-byte AES key. Prefer ZOLLTAX_MASTER_KEY (64 hex chars / base64); otherwise
 * derive one from ZOLLTAX_MASTER_PASSPHRASE. Absent both → secrets can't be
 * stored, which the caller surfaces as a setup error.
 */
let cachedKey = null;
export function getMasterKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.ZOLLTAX_MASTER_KEY || '';
  if (raw) {
    let buf;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
    else buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error('ZOLLTAX_MASTER_KEY must be 32 bytes (64 hex chars or base64).');
    }
    cachedKey = buf;
    return cachedKey;
  }
  const passphrase = process.env.ZOLLTAX_MASTER_PASSPHRASE || '';
  if (passphrase) {
    // Fixed salt so the same passphrase always yields the same key across boots.
    cachedKey = scryptSync(passphrase, 'zolltax-master-v1', 32);
    return cachedKey;
  }
  // Persisted key file on the data volume (written by ensureMasterKey on first
  // run) — survives restarts/rebuilds without any .env round-trip.
  try {
    const hex = readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      cachedKey = Buffer.from(hex, 'hex');
      return cachedKey;
    }
  } catch {
    /* no key file yet */
  }
  throw new Error(
    'No encryption key configured. Set ZOLLTAX_MASTER_KEY (64 hex chars) or ZOLLTAX_MASTER_PASSPHRASE.'
  );
}

/**
 * Return the master key, generating and persisting one to the data volume if
 * none is configured (env / passphrase / existing key file). Lets a fresh
 * install — a Docker container in particular — self-provision its key with no
 * manual .env. A preset ZOLLTAX_MASTER_KEY always takes precedence.
 */
export function ensureMasterKey() {
  if (masterKeyConfigured()) return getMasterKey();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(KEY_FILE, generateMasterKeyHex(), { mode: 0o600 });
  resetMasterKeyCache();
  return getMasterKey();
}

export function masterKeyConfigured() {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

/** Fresh 32-byte key as 64 hex chars — used by the first-run setup wizard. */
export function generateMasterKeyHex() {
  return randomBytes(32).toString('hex');
}

/** Drop the cached key so a newly-set ZOLLTAX_MASTER_KEY is picked up in-process. */
export function resetMasterKeyCache() {
  cachedKey = null;
}

function sessionSecret() {
  if (process.env.ZOLLTAX_SESSION_SECRET) return process.env.ZOLLTAX_SESSION_SECRET;
  // Seed from the master key (env or persisted file) so cookies are signed with
  // a strong, stable secret even when the key isn't in the environment.
  try {
    return getMasterKey().toString('hex');
  } catch {
    return 'zolltax-dev-session-secret';
  }
}

// ── Passwords ────────────────────────────────────────────────────────────────

/** Returns "scrypt$<saltHex>$<hashHex>" for storage. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Timing-safe verification against a stored "scrypt$salt$hash" string. */
export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ── Secret encryption (AES-256-GCM) ──────────────────────────────────────────

/** Encrypts a JSON-serializable value → "v1.<ivB64>.<tagB64>.<ctB64>". */
export function encryptJson(value) {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

/** Decrypts a "v1.iv.tag.ct" blob back to the original value. */
export function decryptJson(blob) {
  const key = getMasterKey();
  const [version, ivB64, tagB64, ctB64] = String(blob).split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('Malformed encrypted blob.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

// ── Session tokens (stateless, HMAC-signed) ──────────────────────────────────

/** Signs { sub, exp } → "<payloadB64url>.<sigB64url>". */
export function signSession(userId, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const payload = b64url(Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + ttlMs })));
  return `${payload}.${hmac(payload)}`;
}

/** Verifies a session token; returns the userId or null. */
export function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!sub || !exp || Date.now() > exp) return null;
    return sub;
  } catch {
    return null;
  }
}

function hmac(data) {
  return b64url(createHmac('sha256', sessionSecret()).update(data).digest());
}
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomId() {
  return randomBytes(12).toString('hex');
}
