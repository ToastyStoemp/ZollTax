import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateSecret, generateToken, verifyToken, base32Encode, base32Decode, generateRecoveryCodes, hashRecovery } from '../src/totp.js';
import { issueChallenge, verifyChallenge, SOLVER_JS } from '../src/captcha.js';

test('base32 round-trips', () => {
  const buf = Buffer.from('hello world 12345');
  assert.equal(base32Decode(base32Encode(buf)).toString(), buf.toString());
});

test('TOTP verifies the current code and rejects wrong ones', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  assert.equal(verifyToken(secret, generateToken(secret, now), { now }), true);
  assert.equal(verifyToken(secret, '000000', { now }), false);
  assert.equal(verifyToken(secret, generateToken(secret, now - 30_000), { now }), true); // drift -1 step
  assert.equal(verifyToken(secret, generateToken(secret, now - 120_000), { now }), false); // too far
});

test('recovery codes hash + match', () => {
  const codes = generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  const h = hashRecovery(codes[0]);
  assert.equal(hashRecovery(codes[0].toUpperCase()), h); // case-insensitive
  assert.notEqual(hashRecovery(codes[1]), h);
});

// Load the browser solver's SHA-256 into this scope and check it matches node.
const g = {};
new Function('globalThis', SOLVER_JS + '\nglobalThis._sha256bytes=_sha256bytes;globalThis.solveCaptcha=solveCaptcha;')(g);

test('browser SHA-256 matches node:crypto', () => {
  for (const s of ['', 'abc', 'The quick brown fox', 'nonce:123456', 'x'.repeat(100)]) {
    const mine = Buffer.from(g._sha256bytes(new TextEncoder().encode(s))).toString('hex');
    const node = createHash('sha256').update(s).digest('hex');
    assert.equal(mine, node, `mismatch for "${s}"`);
  }
});

test('CAPTCHA: solve then verify; reuse + tamper rejected', () => {
  const ch = issueChallenge();
  const solution = g.solveCaptcha(ch.nonce, ch.difficulty);
  assert.equal(verifyChallenge(ch.token, solution).ok, true);
  assert.equal(verifyChallenge(ch.token, solution).ok, false); // single-use
  assert.equal(verifyChallenge(ch.token + 'x', '0').ok, false); // tampered
  assert.equal(verifyChallenge(ch.token, '999999999').ok, false); // wrong solution (fresh token would be needed anyway)
});
