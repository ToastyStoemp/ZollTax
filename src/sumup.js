/**
 * SumUp API client - pulls merchant transaction history for a date range and
 * normalizes it into the same Payment/Fee rows used by the importer UI.
 *
 *   GET /v2.1/merchants/{merchant_code}/transactions/history
 *
 * Env: SUMUP_API_KEY, SUMUP_MERCHANT_CODE, SUMUP_API_URL (default
 *      https://api.sumup.com), SUMUP_MODE (live|mock).
 */

const MAX_RETRIES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => (v == null ? '' : String(v));
const pick = (row, keys) => {
  for (const k of keys) if (row?.[k] != null) return row[k];
  return undefined;
};

export function loadSumupConfig(env = process.env) {
  const apiKey = env.SUMUP_API_KEY || '';
  const merchantCode = env.SUMUP_MERCHANT_CODE || '';
  const hasCreds = !!(apiKey && merchantCode);
  const modeHint = (env.SUMUP_MODE || '').trim().toLowerCase();
  const mode = modeHint === 'mock' ? 'mock' : modeHint === 'live' ? 'live' : hasCreds ? 'live' : 'mock';
  return {
    mode,
    apiUrl: (env.SUMUP_API_URL || 'https://api.sumup.com').replace(/\/+$/, ''),
    apiKey,
    merchantCode,
  };
}

export class SumupError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SumupError';
    this.status = status;
  }
}

export class SumupClient {
  constructor(cfg = loadSumupConfig()) {
    this.config = cfg;
  }

  get mode() {
    return this.config.mode;
  }

  get configured() {
    return !!(this.config.apiKey && this.config.merchantCode);
  }

  status() {
    return {
      mode: this.mode,
      merchant: this.config.merchantCode || null,
      ready: this.mode === 'mock' || this.configured,
    };
  }

  async listTransactions({ from, to }) {
    if (this.mode === 'mock') return mockTransactions({ from, to });
    const rows = await this.#history({ from, to });
    return rows.flatMap(normalizeTransaction).filter(Boolean);
  }

  async #history({ from, to }) {
    if (!this.config.apiKey || !this.config.merchantCode) {
      throw new SumupError('Missing SUMUP_API_KEY / SUMUP_MERCHANT_CODE.', 401);
    }
    const out = [];
    let url = new URL(`${this.config.apiUrl}/v2.1/merchants/${encodeURIComponent(this.config.merchantCode)}/transactions/history`);
    url.searchParams.set('oldest_time', dayStartISO(from));
    url.searchParams.set('newest_time', dayEndISO(to));
    url.searchParams.set('order', 'ascending');
    url.searchParams.set('limit', '100');
    for (let guard = 0; url && guard < 500; guard++) {
      const json = await this.#get(url.toString());
      const rows = Array.isArray(json.items) ? json.items : [];
      out.push(...rows);
      url = nextPageUrl(json.links, this.config.apiUrl, this.config.merchantCode);
    }
    return out;
  }

  async #get(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${this.config.apiKey}`, accept: 'application/json' },
      });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!res.ok) throw new SumupError(`SumUp API ${res.status}: ${await res.text()}`, res.status);
      return res.json();
    }
  }
}

export function normalizeTransaction(row) {
  const status = str(pick(row, ['status', 'simple_status'])).toUpperCase();
  const type = str(pick(row, ['type'])).toUpperCase();
  if (status && !['SUCCESSFUL', 'REFUNDED'].includes(status)) return [];
  if (type && !['PAYMENT', ''].includes(type)) return [];

  const amount = round2(num(pick(row, ['amount', 'transaction_amount'])));
  const refunded = round2(num(pick(row, ['refunded_amount'])));
  const netAmount = round2(amount - refunded);
  if (netAmount <= 0) return [];

  const paymentType = str(pick(row, ['payment_type'])).toUpperCase();
  const isOnline = paymentType === 'ECOM';
  const terminal = isOnline ? 'SumUp Online' : 'SumUp POS';
  const ref = str(pick(row, ['transaction_code', 'id', 'transaction_id']));
  const card = str(pick(row, ['card_type', 'card', 'payment_type', 'entry_mode'])) || paymentType || 'SumUp';
  const date = str(pick(row, ['timestamp', 'created_at', 'date'])) || new Date().toISOString();
  const currency = str(pick(row, ['currency'])) || 'EUR';
  const fee = round2(Math.abs(num(pick(row, ['fee', 'fee_amount', 'transaction_fee']))));
  const rows = [{
    date,
    type: 'Payment',
    amount: netAmount,
    currency,
    terminal,
    card,
    ref,
    desc: `SumUp transaction ${ref || ''}`.trim(),
    source: 'sumup',
    isOnline,
  }];
  if (fee > 0) {
    rows.push({
      date,
      type: 'Fee',
      amount: -fee,
      currency,
      terminal,
      card: 'SumUp fee',
      ref,
      desc: `SumUp fee ${ref || ''}`.trim(),
      source: 'sumup',
      isOnline,
    });
  }
  return rows;
}

export function nextPageUrl(links, apiUrl, merchantCode) {
  const next = Array.isArray(links) ? links.find((l) => l.rel === 'next' && l.href) : null;
  if (!next) return null;
  const href = String(next.href);
  if (/^https?:\/\//i.test(href)) return href;
  const url = new URL(`${apiUrl}/v2.1/merchants/${encodeURIComponent(merchantCode)}/transactions/history`);
  const query = href.startsWith('?') ? href.slice(1) : href;
  for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
  return url;
}

function mockTransactions({ from, to }) {
  const f = Date.parse(/T/.test(from) ? from : `${from}T00:00:00Z`);
  const t = Date.parse(/T/.test(to) ? to : `${to}T23:59:59Z`);
  if (Number.isNaN(f) || Number.isNaN(t) || t < f) return [];
  const span = Math.max(0, t - f);
  const amounts = [18.5, 34.0, 52.75, 13.2, 89.99];
  return amounts.flatMap((amount, i) => {
    const date = new Date(f + Math.round((span * (i + 1)) / (amounts.length + 1))).toISOString();
    const fee = round2(amount * 0.0195);
    const ref = `SUMOCK${1000 + i}`;
    return [
      {
        date,
        type: 'Payment',
        amount,
        currency: 'EUR',
        terminal: 'SumUp POS',
        card: i % 2 ? 'MASTERCARD' : 'VISA',
        ref,
        desc: `SumUp transaction ${ref}`,
        source: 'sumup',
        isOnline: false,
      },
      {
        date,
        type: 'Fee',
        amount: -fee,
        currency: 'EUR',
        terminal: 'SumUp POS',
        card: 'SumUp fee',
        ref,
        desc: `SumUp fee ${ref}`,
        source: 'sumup',
        isOnline: false,
      },
    ];
  });
}

const dayStartISO = (d) => (/T/.test(d) ? d : `${d}T00:00:00Z`);
const dayEndISO = (d) => (/T/.test(d) ? d : `${d}T23:59:59Z`);
