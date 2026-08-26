import { config } from './config.js';
import { cacheGet, cacheSet } from './cache.js';

/**
 * myPOS Banking API client (via the myPOS API Gateway) — used to VERIFY a
 * convention cluster against the merchant's live settled transactions before it
 * is booked into Lexware.
 *
 * Dual auth (every gateway request carries four headers):
 *   1. POST {gateway}/api/v1/oauth/token   integration creds → Bearer token
 *   2. POST {gateway}/api/v1/auth/session  Bearer + merchant creds → X-Session
 *   3. GET  {gateway}/accounting/v1/transactions?from&to
 *      headers: Authorization: Bearer, X-Session, X-Partner-Id, X-Application-Id
 *
 * Credentials come from the myPOS Partner Portal (demo: demo-partners.mypos.com,
 * prod: partners.mypos.com) — an "Account Management" integration + merchant
 * approval. With no credentials, MYPOS_MODE=mock returns a fixture so the verify
 * badge works offline. Raw-shape assumptions are isolated in normalize()/extractRows().
 */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const MAX_RETRIES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadMyposConfig(env = process.env) {
  const clientId = env.MYPOS_CLIENT_ID || '';
  const clientSecret = env.MYPOS_CLIENT_SECRET || '';
  const merchantClientId = env.MYPOS_MERCHANT_CLIENT_ID || '';
  const merchantClientSecret = env.MYPOS_MERCHANT_CLIENT_SECRET || '';
  const partnerId = env.MYPOS_PARTNER_ID || '';
  const applicationId = env.MYPOS_APPLICATION_ID || '';
  const hasCreds = !!(
    clientId && clientSecret && merchantClientId && merchantClientSecret && partnerId && applicationId
  );
  const mode = (env.MYPOS_MODE || (hasCreds ? 'live' : 'mock')).toLowerCase() === 'live' ? 'live' : 'mock';
  return {
    mode,
    gatewayUrl: (env.MYPOS_GATEWAY_URL || 'https://demo-api-gateway.mypos.com').replace(/\/+$/, ''),
    clientId,
    clientSecret,
    merchantClientId,
    merchantClientSecret,
    partnerId,
    applicationId,
    scope: env.MYPOS_SCOPE || '',
    account: env.MYPOS_ACCOUNT || undefined,
  };
}

export class MyposError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'MyposError';
    this.status = status;
  }
}

export class MyposClient {
  #token;
  #session;
  #deviceCacheObj = null; // serial_number → friendly name (persisted to disk)

  constructor(cfg = loadMyposConfig()) {
    this.config = cfg;
  }

  get mode() {
    return this.config.mode;
  }

  /** The merchant's accounts (account_number, iban, currency, name). */
  async listAccounts() {
    if (this.config.mode === 'mock') {
      return [{ account_number: 'MOCK-EUR', iban: 'IE00MOCK', currency: 'EUR', name: 'Mock EUR Account' }];
    }
    const json = await this.#get(`${this.config.gatewayUrl}/accounting/v1/accounts`);
    return json?.items || [];
  }

  /** Normalized card transactions for a window, optionally scoped to accounts. */
  async listTransactions({ from, to, account, accounts }) {
    if (this.config.mode === 'mock') return mockTransactions({ from, to });
    const rows = await this.#fetchAllRows({ from, to, account, accounts });
    const txns = rows.map(normalize).filter(Boolean);
    await this.#applyDeviceNames(txns);
    return txns;
  }

  // Namespaces cache keys per tenant so different clients never share cached
  // device names or transactions (set by the per-tenant client factory).
  #ck(name) {
    return (this.config.cacheNs ? `${this.config.cacheNs}__` : '') + name;
  }

  // Persistent serial_number → friendly-name cache (loaded once from disk).
  #deviceCache() {
    if (!this.#deviceCacheObj) this.#deviceCacheObj = cacheGet(this.#ck('mypos-devices.json')) || {};
    return this.#deviceCacheObj;
  }

  /**
   * Label each transaction's device with its friendly name. Devices are grouped
   * by serial_number (stable across TID changes); the name is looked up once per
   * serial — from the most recent transaction's TID — and cached to disk, so we
   * hit the Terminals API at most once per new device ever.
   */
  async #applyDeviceNames(txns) {
    const cache = this.#deviceCache();
    const groups = new Map();
    for (const t of txns) {
      const serial = t.serial || t.terminal;
      if (!serial) continue;
      (groups.get(serial) || groups.set(serial, []).get(serial)).push(t);
    }
    let changed = false;
    for (const [serial, group] of groups) {
      if (!cache[serial]) {
        const recent = group.reduce((a, b) => (String(b.dateTime) > String(a.dateTime) ? b : a));
        cache[serial] = (await this.#lookupTerminalName(recent.terminal)) || recent.terminal || serial;
        changed = true;
      }
      for (const t of group) t.terminal = cache[serial];
    }
    if (changed) cacheSet(this.#ck('mypos-devices.json'), cache);
  }

  async #lookupTerminalName(tid) {
    if (!tid) return '';
    try {
      const d = await this.#get(`${this.config.gatewayUrl}/pos/v1/terminals/${encodeURIComponent(tid)}`);
      return String(d?.terminal_name || '').replace(/^myPOS\s+/i, '').trim();
    } catch {
      return '';
    }
  }

  async #accessToken(force = false) {
    const now = Date.now();
    if (!force && this.#token && this.#token.expiresAt > now + 30_000) return this.#token.value;
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new MyposError('Missing MYPOS_CLIENT_ID / MYPOS_CLIENT_SECRET (integration credentials).');
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    // Only send scope when explicitly configured — the gateway assigns the
    // integration's own scopes automatically, and an unlisted scope is rejected.
    if (this.config.scope) body.set('scope', this.config.scope);
    const res = await fetch(`${this.config.gatewayUrl}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (!res.ok) throw new MyposError(`OAuth token request failed (${res.status}): ${await res.text()}`, res.status);
    const json = await res.json();
    if (!json.access_token) throw new MyposError('OAuth response had no access_token.');
    this.#token = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
    return this.#token.value;
  }

  async #sessionId(force = false) {
    const now = Date.now();
    if (!force && this.#session && this.#session.expiresAt > now + 30_000) return this.#session.value;
    if (!this.config.merchantClientId || !this.config.merchantClientSecret) {
      throw new MyposError('Missing MYPOS_MERCHANT_CLIENT_ID / MYPOS_MERCHANT_CLIENT_SECRET.');
    }
    const token = await this.#accessToken(force);
    const res = await fetch(`${this.config.gatewayUrl}/api/v1/auth/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.config.merchantClientId,
        client_secret: this.config.merchantClientSecret,
      }),
    });
    if (!res.ok) throw new MyposError(`Session request failed (${res.status}): ${await res.text()}`, res.status);
    const json = await res.json();
    if (!json.session) throw new MyposError('Session response had no session id.');
    this.#session = { value: json.session, expiresAt: now + (json.expires_in ?? 300) * 1000 };
    return this.#session.value;
  }

  /** The merchant's account numbers (one per currency). */
  async #accountNumbers() {
    const json = await this.#get(`${this.config.gatewayUrl}/accounting/v1/accounts`);
    return (json?.items || []).map((a) => String(a.account_number)).filter(Boolean);
  }

  async #fetchAllRows({ from, to, account, accounts: wanted }) {
    // The transactions endpoint is per-account and requires from_date/to_date.
    // Use the explicitly-selected accounts, else a single configured account,
    // else pull across every account (all currencies).
    const acct = account ?? this.config.account;
    const accounts =
      Array.isArray(wanted) && wanted.length ? wanted : acct ? [acct] : await this.#accountNumbers();
    // A window fully in the past never changes → cache it permanently.
    const stable = to < new Date().toISOString().slice(0, 10);
    // Warm auth once so the parallel per-account fetches reuse the token/session.
    await this.#sessionId();
    const perAccount = await Promise.all(accounts.map((a) => this.#fetchAccountRows(a, from, to, stable)));
    return perAccount.flat();
  }

  async #fetchAccountRows(accountNumber, from, to, stable) {
    const key = this.#ck(`mypos-tx__${accountNumber}__${from}__${to}.json`);
    const cached = cacheGet(key);
    // Reuse a cached pull for a stable (past) window, or a recent one <10 min old.
    if (cached && (stable || Date.now() - cached.fetchedAt < 10 * 60 * 1000)) return cached.rows;
    const rows = [];
    for (let page = 1; page <= 200; page++) {
      const url = new URL(`${this.config.gatewayUrl}/accounting/v1/transactions`);
      url.searchParams.set('account_number', accountNumber);
      url.searchParams.set('from_date', from);
      url.searchParams.set('to_date', to);
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', '500'); // fewer round-trips
      const json = await this.#get(url.toString());
      const pageRows = extractRows(json);
      rows.push(...pageRows);
      if (!hasNextPage(json, pageRows.length)) break;
    }
    cacheSet(key, { fetchedAt: Date.now(), rows });
    return rows;
  }

  async #get(url) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#accessToken();
      const session = await this.#sessionId();
      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-session': session,
          'x-partner-id': this.config.partnerId,
          'x-application-id': this.config.applicationId,
          accept: 'application/json',
        },
      });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(retryAfter * 1000);
        continue;
      }
      if ((res.status === 401 || res.status === 403) && attempt < 1) {
        await this.#sessionId(true);
        continue;
      }
      if (!res.ok) throw new MyposError(`Banking API ${res.status}: ${await res.text()}`, res.status);
      return res.json();
    }
  }
}

/** Fold transactions into { currency, count, gross, fees, net } for verification. */
export function summarize(txns, fallbackCurrency = 'EUR') {
  const currency = txns[0]?.currency ?? fallbackCurrency;
  const gross = round2(txns.reduce((s, t) => s + (t.type === 'Fee' ? 0 : t.amount), 0));
  const fees = round2(txns.reduce((s, t) => s + (t.type === 'Fee' ? Math.abs(t.amount) : t.fee || 0), 0));
  const count = txns.filter((t) => t.type !== 'Fee').length;
  return { currency, count, gross, fees, net: round2(gross - fees) };
}

// ── Raw-shape adapter ────────────────────────────────────────────────────────
const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => (v == null ? undefined : String(v));
const pick = (row, keys) => {
  for (const k of keys) if (row[k] != null) return row[k];
  return undefined;
};

export function extractRows(json) {
  if (Array.isArray(json)) return json;
  const o = json ?? {};
  for (const key of ['data', 'transactions', 'content', 'items', 'results']) {
    if (Array.isArray(o[key])) return o[key];
  }
  return [];
}

function hasNextPage(json, rowsThisPage) {
  const o = json ?? {};
  const pg = o.pagination ?? o.meta ?? o;
  if (typeof pg.has_next_page === 'boolean') return pg.has_next_page;
  if (typeof pg.has_more === 'boolean') return pg.has_more;
  if (typeof pg.hasNextPage === 'boolean') return pg.hasNextPage;
  const page = num(pick(pg, ['page', 'current_page', 'currentPage']));
  const total = num(pick(pg, ['total_pages', 'totalPages', 'pageCount']));
  if (page && total) return page < total;
  return rowsThisPage >= 100;
}

/**
 * Normalize one myPOS Banking API transaction. The endpoint returns the full
 * account ledger; only rows with a `terminal_id` are card-terminal activity —
 * that filter naturally excludes bank transfers, payouts, the merchant's own
 * card spending, and non-card fees. A Credit is a card sale (Payment); a Debit
 * is the card fee. transaction_amount is already signed (+ sale / − fee).
 */
export function normalize(row) {
  const terminal = str(pick(row, ['terminal_id', 'terminalId']));
  if (!terminal) return null;
  const amount = round2(num(pick(row, ['transaction_amount', 'amount', 'value'])));
  if (!amount) return null;
  const isFee = String(pick(row, ['sign']) ?? '').toLowerCase() === 'debit';
  return {
    reference: str(pick(row, ['payment_reference', 'reference', 'id'])) ?? '',
    dateTime: str(pick(row, ['date', 'dateTime', 'created_at'])) ?? new Date().toISOString(),
    amount, // signed: + for a Credit (sale), − for a Debit (fee)
    currency: str(pick(row, ['transaction_currency', 'currency'])) ?? 'EUR',
    fee: 0,
    net: 0,
    type: isFee ? 'Fee' : 'Payment',
    terminal,
    serial: str(pick(row, ['serial_number'])),
    card: str(pick(row, ['pan', 'card'])),
    desc: str(pick(row, ['description', 'billing_descriptor'])),
  };
}

// ── Mock fixture (MYPOS_MODE=mock) ───────────────────────────────────────────
function mockTransactions({ from, to }) {
  const f = dayStart(from);
  const t = dayEnd(to);
  if (Number.isNaN(f) || Number.isNaN(t) || t < f) return [];
  const span = Math.max(0, t - f);
  const amounts = [24.9, 49.5, 12.0, 68.05, 41.06, 31.68];
  const n = Math.min(amounts.length, span > 2 * 86400000 ? 6 : 3);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const at = f + Math.round((span * (i + 1)) / (n + 1));
    const amount = amounts[i];
    const fee = round2(amount * 0.011);
    rows.push({
      reference: `MPMOCK${i + 1}`,
      dateTime: new Date(at).toISOString(),
      amount,
      currency: 'EUR',
      fee,
      net: round2(amount - fee),
      type: 'Payment',
      card: 'Visa',
    });
  }
  return rows;
}

const dayStart = (d) => Date.parse(/T/.test(d) ? d : `${d}T00:00:00Z`);
const dayEnd = (d) => Date.parse(/T/.test(d) ? d : `${d}T23:59:59Z`);

// Keep a stable reference so consumers can read the resolved config for status.
export const myposConfig = () => loadMyposConfig();
export { config as lexwareConfig };
