import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coerceFields, matchEvent } from '../src/invoice-ai.js';

const EVENTS = [
  { id: 'e1', name: 'FACTS Spring', dateStart: '2026-04-10', dateEnd: '2026-04-12', venue: { country: 'Belgium' } },
  { id: 'e2', name: 'Dokomi', dateStart: '2026-05-30', dateEnd: '2026-06-01', venue: { country: 'Germany' } },
];

test('coerceFields clamps and normalizes model output', () => {
  const f = coerceFields({ vendor: 'Hotel Ibis', category: 'nope', amount: '123.456', currency: 'eur ', date: '2026-4-9', stayStart: '2026-04-09', confidence: 5 });
  assert.equal(f.category, 'other'); // invalid category falls back
  assert.equal(f.amount, 123.46); // rounded to cents
  assert.equal(f.currency, 'EUR'); // upper + stripped to 3 letters
  assert.equal(f.date, ''); // malformed date rejected
  assert.equal(f.stayStart, '2026-04-09'); // valid ISO kept
  assert.equal(f.confidence, 1); // clamped to [0,1]
});

test('matchEvent auto-matches on overlapping dates + country', () => {
  const fields = coerceFields({ category: 'accommodation', amount: 300, currency: 'EUR', stayStart: '2026-04-09', stayEnd: '2026-04-12', country: 'BE' });
  const { match, candidates } = matchEvent(fields, EVENTS);
  assert.ok(match, 'expected a confident match');
  assert.equal(match.eventId, 'e1');
  assert.deepEqual(match.why.sort(), ['country', 'dates']);
  assert.equal(candidates[0].eventId, 'e1');
});

test('matchEvent picks by date overlap even when country is blank', () => {
  const fields = coerceFields({ date: '2026-05-31', country: '' });
  const { match } = matchEvent(fields, EVENTS);
  assert.equal(match && match.eventId, 'e2');
});

test('matchEvent stays unmatched when only country matches (no dates)', () => {
  const fields = coerceFields({ country: 'Germany' }); // no dates at all
  const { match, candidates } = matchEvent(fields, EVENTS);
  assert.equal(match, null); // country alone (score 30) is below the auto-pick bar
  assert.equal(candidates[0].eventId, 'e2'); // still surfaced as a candidate
});

test('daily quota guard blocks once the call cap is spent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zolltax-ai-'));
  process.env.ZOLLTAX_DATA_DIR = dir;
  process.env.ZOLLTAX_AI_DAILY_CALLS = '2';
  process.env.ZOLLTAX_AI_DAILY_TOKENS = '1000000';
  try {
    const { aiQuota, aiRecord } = await import('../src/ai-usage.js?fresh=' + Date.now());
    assert.equal(aiQuota().ok, true);
    aiRecord({ inputTokens: 10, outputTokens: 5 });
    assert.equal(aiQuota().remainingCalls, 1);
    aiRecord({ inputTokens: 10, outputTokens: 5 });
    assert.equal(aiQuota().ok, false); // cap reached
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ZOLLTAX_DATA_DIR;
    delete process.env.ZOLLTAX_AI_DAILY_CALLS;
    delete process.env.ZOLLTAX_AI_DAILY_TOKENS;
  }
});
