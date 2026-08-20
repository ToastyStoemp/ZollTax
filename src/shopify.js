/**
 * Shopify Admin API client — pulls orders for a date range so online (and
 * Shopify POS) sales can be clustered and booked, instead of uploading a CSV.
 *
 *   GET /admin/api/{version}/orders.json?status=any&processed_at_min&processed_at_max
 *   GET /admin/api/{version}/locations.json   (to name POS locations)
 *
 * Auth is a custom-app Admin API access token (header X-Shopify-Access-Token).
 * Newer Shopify Dev Dashboard apps don't show a static token in the UI; for
 * those, the client exchanges SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for a
 * short-lived Admin API token and refreshes it before expiry.
 * Orders are normalized to the SAME shape the CSV parser produces
 * (parseShopify in public/index.html), so they flow through the existing
 * clustering: online orders (no location) → one monthly online cluster; POS
 * orders (a location) → device clusters. With no credentials, MYPOS-style
 * MOCK mode returns a fixture.
 *
 * Env: SHOPIFY_SHOP (mystore.myshopify.com), SHOPIFY_ACCESS_TOKEN or
 *      SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET,
 *      SHOPIFY_API_VERSION (default 2024-10), SHOPIFY_MODE (live|mock).
 */

const MAX_RETRIES = 5;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function loadShopifyConfig(env = process.env) {
  const shop = (env.SHOPIFY_SHOP || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const accessToken = env.SHOPIFY_ACCESS_TOKEN || '';
  const clientId = env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = env.SHOPIFY_CLIENT_SECRET || '';
  const hasToken = !!(shop && accessToken);
  const hasClientCredentials = !!(shop && clientId && clientSecret);
  const hasCreds = hasToken || hasClientCredentials;
  const mode = (env.SHOPIFY_MODE || (hasCreds ? 'live' : 'mock')).toLowerCase() === 'live' ? 'live' : 'mock';
  return {
    mode,
    shop,
    accessToken,
    clientId,
    clientSecret,
    apiVersion: env.SHOPIFY_API_VERSION || '2024-10',
  };
}

export class ShopifyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ShopifyError';
    this.status = status;
  }
}

export class ShopifyClient {
  #locationCache;
  #accessToken;
  #accessTokenExpiresAt = 0;
  #accessTokenPromise;

  constructor(cfg = loadShopifyConfig()) {
    this.config = cfg;
  }

  get mode() {
    return this.config.mode;
  }

  get #base() {
    return `https://${this.config.shop}/admin/api/${this.config.apiVersion}`;
  }

  get authMode() {
    if (this.config.accessToken) return 'static_token';
    if (this.config.clientId && this.config.clientSecret) return 'client_credentials';
    return 'none';
  }

  async status({ warmToken = false } = {}) {
    const base = {
      mode: this.mode,
      shop: this.config.shop || null,
      auth: this.authMode,
      ready: this.mode === 'mock' || this.authMode !== 'none',
    };
    if (this.mode === 'live' && warmToken && this.authMode === 'client_credentials') {
      try {
        await this.#token();
        return { ...base, ready: true, token: 'cached' };
      } catch (err) {
        return { ...base, ready: false, error: err instanceof Error ? err.message : 'Shopify authentication failed.' };
      }
    }
    return base;
  }

  /** Normalized paid orders whose payment was processed within [from, to]. */
  async listOrders({ from, to }) {
    if (this.config.mode === 'mock') return mockOrders(from, to);
    const locations = await this.#locations();
    const params = new URLSearchParams({
      status: 'any',
      limit: '250',
      processed_at_min: dayStartISO(from),
      processed_at_max: dayEndISO(to),
    });
    let url = `${this.#base}/orders.json?${params.toString()}`;
    const out = [];
    for (let guard = 0; url && guard < 500; guard++) {
      const { json, link } = await this.#get(url);
      for (const o of json.orders || []) {
        const t = normalizeOrder(o, locations);
        if (t) out.push(t);
      }
      url = nextPageUrl(link);
    }
    return out;
  }

  async #locations() {
    if (this.#locationCache) return this.#locationCache;
    try {
      const { json } = await this.#get(`${this.#base}/locations.json`);
      this.#locationCache = Object.fromEntries((json.locations || []).map((l) => [String(l.id), l.name]));
    } catch {
      this.#locationCache = {};
    }
    return this.#locationCache;
  }

  async #get(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': await this.#token(), accept: 'application/json' },
      });
      // Shopify leaky-bucket rate limit.
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!res.ok) throw new ShopifyError(`Shopify API ${res.status}: ${await res.text()}`, res.status);
      return { json: await res.json(), link: res.headers.get('link') || '' };
    }
  }

  async #token() {
    if (this.config.accessToken) return this.config.accessToken;
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new ShopifyError('Missing Shopify credentials. Set SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.', 401);
    }
    const now = Date.now();
    if (this.#accessToken && now < this.#accessTokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS) return this.#accessToken;
    if (!this.#accessTokenPromise) {
      this.#accessTokenPromise = this.#fetchAccessToken().finally(() => {
        this.#accessTokenPromise = null;
      });
    }
    return this.#accessTokenPromise;
  }

  async #fetchAccessToken() {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const res = await fetch(`https://${this.config.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.error_description || json.error || JSON.stringify(json) || res.statusText;
      throw new ShopifyError(`Shopify token exchange ${res.status}: ${msg}`, res.status);
    }
    if (!json.access_token) throw new ShopifyError('Shopify token exchange succeeded but returned no access_token.', 502);
    this.#accessToken = json.access_token;
    this.#accessTokenExpiresAt = Date.now() + (Number(json.expires_in) || 24 * 60 * 60) * 1000;
    return this.#accessToken;
  }
}

// ── Normalization (matches parseShopify's output shape) ──────────────────────

export function normalizeOrder(o, locations = {}) {
  const fin = String(o.financial_status || '').toLowerCase();
  if (!['paid', 'partially_refunded', 'refunded'].includes(fin)) return null;
  // current_total_price is net of refunds; fall back to total_price.
  const amount = round2(num(o.current_total_price ?? o.total_price));
  if (amount <= 0) return null;

  // Classify by source_name: web → online; draft orders are online too when
  // their location is the Online Store; pos / other draft → device cluster.
  // Fall back to location_id only when source_name is absent.
  const source = String(o.source_name || '').toLowerCase();
  const locName = o.location_id ? locations[String(o.location_id)] || '' : '';
  const isOnline = source
    ? (source === 'web' || (source === 'shopify_draft_order' && /online store/i.test(locName)))
    : !o.location_id;
  const terminal = isOnline
    ? 'Shopify Online'
    : locName || (source === 'shopify_draft_order' ? 'Shopify Draft' : 'Shopify POS');
  const gateway = (Array.isArray(o.payment_gateway_names) && o.payment_gateway_names[0]) || o.gateway || o.source_name || '';
  const name = o.name || (o.order_number != null ? `#${o.order_number}` : '');

  return {
    date: o.processed_at || o.created_at || new Date().toISOString(),
    type: 'Payment',
    amount,
    currency: o.currency || 'EUR',
    terminal,
    card: gateway,
    ref: name,
    desc: `Shopify order ${name}`,
    source: 'shopify',
    orderNum: name,
    isManual: /manual|custom/i.test(gateway),
    isOnline,
  };
}

// ── Pagination (Link header, cursor-based) ───────────────────────────────────
export function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

// ── Mock fixture (SHOPIFY_MODE=mock) ─────────────────────────────────────────
function mockOrders(from, to) {
  const f = Date.parse(/T/.test(from) ? from : `${from}T00:00:00Z`);
  const t = Date.parse(/T/.test(to) ? to : `${to}T23:59:59Z`);
  if (Number.isNaN(f) || Number.isNaN(t) || t < f) return [];
  const span = Math.max(0, t - f);
  const online = [42.5, 19.9, 68.05, 27.0, 55.4];
  const out = [];
  for (let i = 0; i < online.length; i++) {
    const at = f + Math.round((span * (i + 1)) / (online.length + 2));
    out.push({
      date: new Date(at).toISOString(),
      type: 'Payment',
      amount: online[i],
      currency: 'EUR',
      terminal: 'Shopify Online',
      card: 'PayPal Express Checkout',
      ref: `#${3200 + i}`,
      desc: `Shopify order #${3200 + i}`,
      source: 'shopify',
      orderNum: `#${3200 + i}`,
      isManual: false,
      isOnline: true,
    });
  }
  // One Shopify POS order too (in-person → a device cluster).
  out.push({
    date: new Date(f + Math.round(span / 2)).toISOString(),
    type: 'Payment',
    amount: 33.0,
    currency: 'EUR',
    terminal: 'Shopify POS — Booth',
    card: 'Shopify POS',
    ref: '#3299',
    desc: 'Shopify order #3299',
    source: 'shopify',
    orderNum: '#3299',
    isManual: false,
    isOnline: false,
  });
  return out;
}

const dayStartISO = (d) => (/T/.test(d) ? d : `${d}T00:00:00Z`);
const dayEndISO = (d) => (/T/.test(d) ? d : `${d}T23:59:59Z`);
