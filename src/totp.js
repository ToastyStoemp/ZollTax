/**
 * RFC 6238 TOTP (authenticator-app 2FA) + recovery codes. Zero-dep (node:crypto).
 * SHA-1, 6 digits, 30s period — the universal default understood by Google
 * Authenticator, Authy, 1Password, etc.
 */
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** New base32 TOTP secret (160 bits). */
export function generateSecret() {
  return base32Encode(randomBytes(20));
}

/** otpauth:// URI for authenticator apps (also handy as a tap-to-add link). */
export function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Current 6-digit code for a secret (used by the enrollment confirm step + tests). */
export function generateToken(secret, now = Date.now()) {
  return hotp(base32Decode(secret), Math.floor(now / 1000 / 30));
}

/**
 * Verify a 6-digit code against the secret, allowing ±`window` steps for clock
 * drift. `now` is ms since epoch (injectable for tests).
 */
export function verifyToken(secret, token, { window = 1, now = Date.now() } = {}) {
  const code = String(token || '').replace(/\D/g, '');
  if (code.length !== 6) return false;
  const secretBuf = base32Decode(secret);
  if (!secretBuf.length) return false;
  const counter = Math.floor(now / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secretBuf, counter + i);
    if (expected.length === code.length && timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
}

// ── Recovery codes (single-use backup, stored hashed) ────────────────────────

export function generateRecoveryCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = randomBytes(5).toString('hex'); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export const hashRecovery = (code) =>
  createHash('sha256').update(String(code).toLowerCase().replace(/\s/g, '')).digest('hex');
