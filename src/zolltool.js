/**
 * ZollTool read-API client. Logs in with a dedicated account's credentials and
 * reads that account's events + transactions (materialized server-side from the
 * op-log). Used to match convention payment clusters to ZollTool events so a
 * cluster can be named/dated and booked into Lexware for the right event.
 *
 *   POST /api/auth/login                         → { accessToken, refreshToken }
 *   GET  /api/data/events                        → SalesEvent[]
 *   GET  /api/data/events/:id/transactions       → Transaction[]
 *   GET  /api/data/transactions?from&to          → Transaction[]
 *
 * Env: ZOLLTOOL_URL, ZOLLTOOL_EMAIL, ZOLLTOOL_PASSWORD.
 */

const norm = (u) => u.trim().replace(/\/+$/, '');

export function loadZolltoolConfig(env = process.env) {
  return {
    url: env.ZOLLTOOL_URL ? norm(env.ZOLLTOOL_URL) : '',
    email: env.ZOLLTOOL_EMAIL || '',
    password: env.ZOLLTOOL_PASSWORD || '',
  };
}

export class ZolltoolError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ZolltoolError';
    this.status = status;
  }
}

export class ZolltoolClient {
  #access;
  #refresh;

  constructor(cfg = loadZolltoolConfig()) {
    this.config = cfg;
  }

  get configured() {
    return !!(this.config.url && this.config.email && this.config.password);
  }

  async #login() {
    if (!this.configured) {
      throw new ZolltoolError('ZollTool not configured (set ZOLLTOOL_URL / ZOLLTOOL_EMAIL / ZOLLTOOL_PASSWORD).');
    }
    const res = await fetch(`${this.config.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });
    if (!res.ok) throw new ZolltoolError(`Login failed (${res.status}): ${await res.text()}`, res.status);
    const json = await res.json();
    this.#access = json.accessToken;
    this.#refresh = json.refreshToken;
    return json.user;
  }

  async #refreshAccess() {
    if (!this.#refresh) return false;
    const res = await fetch(`${this.config.url}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refreshToken: this.#refresh }),
    });
    if (!res.ok) return false;
    const json = await res.json();
    this.#access = json.accessToken;
    this.#refresh = json.refreshToken;
    return true;
  }

  async #get(path) {
    if (!this.#access) await this.#login();
    const doFetch = () =>
      fetch(`${this.config.url}${path}`, { headers: { authorization: `Bearer ${this.#access}`, accept: 'application/json' } });
    let res = await doFetch();
    if (res.status === 401) {
      const ok = (await this.#refreshAccess()) || (await this.#login().then(() => true).catch(() => false));
      if (ok) res = await doFetch();
    }
    if (!res.ok) throw new ZolltoolError(`GET ${path} failed (${res.status}): ${await res.text()}`, res.status);
    return res.json();
  }

  /** Verify credentials + connectivity; returns the logged-in user. */
  connect() {
    return this.#login();
  }

  getEvents() {
    return this.#get('/api/data/events');
  }

  getEventTransactions(eventId) {
    return this.#get(`/api/data/events/${encodeURIComponent(eventId)}/transactions`);
  }

  getTransactions(from, to) {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return this.#get(`/api/data/transactions${qs ? `?${qs}` : ''}`);
  }
}
