import { config } from './config.js';

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
    scope: env.MYPOS_SCOPE || 'banking.read',
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

  constructor(cfg = loadMyposConfig()) {
    this.config = cfg;
  }

  get mode() {
    return this.config.mode;
  }

  /** Normalized settled transactions for a window. */
  async listTransactions({ from, to, account }) {
    if (this.config.mode === 'mock') return mockTransactions({ from, to });
    const rows = await this.#fetchAllRows({ from, to, account });
    return rows.map(normalize).filter(Boolean);
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
      scope: this.config.scope,
    });
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

  async #fetchAllRows({ from, to, account }) {
    const out = [];
    const acct = account ?? this.config.account;
    for (let page = 1; page <= 200; page++) {
      const url = new URL(`${this.config.gatewayUrl}/accounting/v1/transactions`);
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);
      url.searchParams.set('page', String(page));
      if (acct) url.searchParams.set('account', acct);
      const json = await this.#get(url.toString());
      const rows = extractRows(json);
      out.push(...rows);
      if (!hasNextPage(json, rows.length)) break;
    }
    return out;
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
  if (typeof pg.has_more === 'boolean') return pg.has_more;
  if (typeof pg.hasNextPage === 'boolean') return pg.hasNextPage;
  const page = num(pick(pg, ['page', 'current_page', 'currentPage']));
  const total = num(pick(pg, ['total_pages', 'totalPages', 'pageCount']));
  if (page && total) return page < total;
  return rowsThisPage >= 100;
}

export function normalize(row) {
  const amount = round2(num(pick(row, ['amount', 'grossAmount', 'gross_amount', 'value'])));
  if (!amount) return null;
  const currency = str(pick(row, ['currency', 'currencyCode', 'currency_code'])) ?? 'EUR';
  let fee = num(pick(row, ['fee', 'feeAmount', 'fee_amount', 'commission', 'charge']));
  const netRaw = pick(row, ['net', 'netAmount', 'net_amount', 'settledAmount', 'settled_amount']);
  if (!fee && netRaw != null) fee = amount - num(netRaw);
  fee = round2(Math.max(0, fee));
  return {
    reference: str(pick(row, ['reference', 'payment_reference', 'paymentReference', 'id', 'trn_ref'])) ?? '',
    dateTime:
      str(pick(row, ['dateTime', 'date_time', 'date', 'createdAt', 'created_at', 'timestamp'])) ??
      new Date().toISOString(),
    amount,
    currency,
    fee,
    net: round2(amount - fee),
    type: 'Payment',
    card: str(pick(row, ['card', 'cardBrand', 'card_brand', 'scheme', 'paymentMethod', 'payment_method'])),
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
