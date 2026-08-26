import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, sweep, _reset } from '../src/rate-limit.js';

test('allows up to max, then blocks within the window', () => {
  _reset();
  const t0 = 1_000_000;
  const results = [];
  for (let i = 0; i < 4; i++) results.push(rateLimit('k', 3, 1000, t0));
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false]);
  assert.equal(results[3].retryAfterMs, 1000);
  assert.equal(results[2].remaining, 0);
});

test('resets after the window elapses', () => {
  _reset();
  assert.equal(rateLimit('k', 1, 1000, 0).ok, true);
  assert.equal(rateLimit('k', 1, 1000, 500).ok, false); // same window
  assert.equal(rateLimit('k', 1, 1000, 1000).ok, true); // new window
});

test('keys are independent', () => {
  _reset();
  assert.equal(rateLimit('a', 1, 1000, 0).ok, true);
  assert.equal(rateLimit('a', 1, 1000, 0).ok, false);
  assert.equal(rateLimit('b', 1, 1000, 0).ok, true); // different key unaffected
});

test('sweep drops expired buckets', () => {
  _reset();
  rateLimit('old', 5, 1000, 0);
  rateLimit('fresh', 5, 1000, 900);
  sweep(1500); // 'old' expired at 1000, 'fresh' at 1900
  // After sweeping, 'old' starts a fresh window (full budget), 'fresh' keeps its count.
  assert.equal(rateLimit('old', 5, 1000, 1500).remaining, 4);
  assert.equal(rateLimit('fresh', 5, 1000, 1500).remaining, 3);
});
