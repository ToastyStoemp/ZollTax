/**
 * ZollLedger — per-event expense capture + profit/loss.
 *
 * Expenses are stored per tenant as data/ledger/<userId>.json (0600); an
 * attached invoice PDF (often added later, e.g. hotels) lives beside it as
 * data/ledger/<userId>/<expenseId>.pdf. Every expense stays editable and starts
 * unbooked — Lexware booking is a separate month-end step (bookedVoucherId is
 * the hook it will set). P&L pairs an event's ZollTool revenue with its expenses.
 *
 * Amounts are plain business data (not integration secrets), so the index is
 * stored as JSON on the private data volume rather than encrypted like configs.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomId } from './crypto.js';
import { DATA_DIR } from './store.js';

export const EXPENSE_CATEGORIES = [
  { id: 'booth', label: 'Booth / table fee' },
  { id: 'travel', label: 'Travel' },
  { id: 'accommodation', label: 'Accommodation' },
  { id: 'other', label: 'Other' },
];
const CATEGORY_IDS = new Set(EXPENSE_CATEGORIES.map((c) => c.id));

const LEDGER_DIR = join(DATA_DIR, 'ledger');
const indexFile = (userId) => join(LEDGER_DIR, `${userId}.json`);
const filesDir = (userId) => join(LEDGER_DIR, userId);
const invoicePath = (userId, id) => join(filesDir(userId), `${id}.pdf`);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function readIndex(userId) {
  try {
    const o = JSON.parse(readFileSync(indexFile(userId), 'utf8'));
    return { expenses: Array.isArray(o.expenses) ? o.expenses : [] };
  } catch {
    return { expenses: [] };
  }
}
function writeIndex(userId, data) {
  mkdirSync(LEDGER_DIR, { recursive: true });
  const tmp = `${indexFile(userId)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, indexFile(userId));
}

function normalize(e) {
  return {
    id: e.id,
    eventId: String(e.eventId || ''),
    category: CATEGORY_IDS.has(e.category) ? e.category : 'other',
    amount: round2(e.amount),
    currency: String(e.currency || 'EUR').toUpperCase().slice(0, 3),
    date: String(e.date || '').slice(0, 10),
    vendor: String(e.vendor || '').slice(0, 200),
    note: String(e.note || '').slice(0, 1000),
    invoice: e.invoice || null, // { filename, size, uploadedAt }
    bookedVoucherId: e.bookedVoucherId || null,
    createdAt: e.createdAt || Date.now(),
    updatedAt: e.updatedAt || Date.now(),
  };
}

export function listExpenses(userId, eventId) {
  const all = readIndex(userId).expenses.map(normalize).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return eventId ? all.filter((e) => e.eventId === eventId) : all;
}
export function getExpense(userId, id) {
  return readIndex(userId).expenses.map(normalize).find((e) => e.id === id) || null;
}
export function addExpense(userId, data) {
  const idx = readIndex(userId);
  const now = Date.now();
  const e = normalize({ ...data, id: randomId(), invoice: null, bookedVoucherId: null, createdAt: now, updatedAt: now });
  idx.expenses.push(e);
  writeIndex(userId, idx);
  return e;
}
export function updateExpense(userId, id, patch) {
  const idx = readIndex(userId);
  const i = idx.expenses.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const prev = normalize(idx.expenses[i]);
  // Preserve immutable/managed fields; callers can't spoof them via patch.
  const merged = normalize({
    ...prev, ...patch,
    id, invoice: prev.invoice, bookedVoucherId: prev.bookedVoucherId,
    createdAt: prev.createdAt, updatedAt: Date.now(),
  });
  idx.expenses[i] = merged;
  writeIndex(userId, idx);
  return merged;
}
export function deleteExpense(userId, id) {
  const idx = readIndex(userId);
  const next = idx.expenses.filter((e) => e.id !== id);
  if (next.length === idx.expenses.length) return false;
  writeIndex(userId, { expenses: next });
  try { unlinkSync(invoicePath(userId, id)); } catch { /* no file */ }
  return true;
}

/** Attach (or replace) the invoice PDF for an expense, from a base64 string. */
export function saveInvoice(userId, id, base64, filename) {
  const idx = readIndex(userId);
  const i = idx.expenses.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) return null;
  mkdirSync(filesDir(userId), { recursive: true });
  writeFileSync(invoicePath(userId, id), buf, { mode: 0o600 });
  idx.expenses[i] = normalize({
    ...idx.expenses[i],
    invoice: { filename: String(filename || 'invoice.pdf').slice(0, 200), size: buf.length, uploadedAt: Date.now() },
    updatedAt: Date.now(),
  });
  writeIndex(userId, idx);
  return normalize(idx.expenses[i]);
}
export function readInvoice(userId, id) {
  const e = getExpense(userId, id);
  if (!e || !e.invoice) return null;
  try { return { buffer: readFileSync(invoicePath(userId, id)), filename: e.invoice.filename }; } catch { return null; }
}

/**
 * Per-event P&L. `revenueByEvent` maps eventId → revenue number (summed by the
 * caller from ZollTool transactions). Expense amounts are summed as-entered — a
 * known simplification when expenses mix currencies (flagged via `currencies`).
 */
export function computePnl(events, revenueByEvent, expenses) {
  const byEvent = new Map();
  for (const e of expenses) {
    if (!byEvent.has(e.eventId)) byEvent.set(e.eventId, []);
    byEvent.get(e.eventId).push(e);
  }
  return events.map((ev) => {
    const exps = byEvent.get(ev.id) || [];
    const expenseTotal = round2(exps.reduce((s, e) => s + e.amount, 0));
    const revenue = round2(revenueByEvent[ev.id] || 0);
    const byCategory = {};
    for (const c of EXPENSE_CATEGORIES) {
      byCategory[c.id] = round2(exps.filter((e) => e.category === c.id).reduce((s, e) => s + e.amount, 0));
    }
    return {
      eventId: ev.id,
      name: ev.name || 'Event',
      country: ev.venue?.country || '',
      start: ev.dateStart || '',
      revenue,
      expenses: expenseTotal,
      margin: round2(revenue - expenseTotal),
      expenseCount: exps.length,
      unbooked: exps.filter((e) => !e.bookedVoucherId).length,
      currencies: [...new Set(exps.map((e) => e.currency))],
      byCategory,
    };
  });
}
