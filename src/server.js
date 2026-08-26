import './load-env.js'; // MUST be first: loads .env before modules read process.env
import { persistEnvVar } from './load-env.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize as normPath } from 'node:path';
import { LexwareClient, LexwareApiError, resolveCategoryId } from './lexware.js';
import { buildRevenueVoucher } from './voucher.js';
import { buildFeeVoucher } from './expense.js';
import { summarize } from './mypos.js';
import { CONFIG_GROUPS, redactConfig } from './config-schema.js';
import { masterKeyConfigured, generateMasterKeyHex, resetMasterKeyCache, signSession, verifySession } from './crypto.js';
import {
  authenticate,
  bootstrapAdmin,
  countUsers,
  createUser,
  deleteUser,
  getUser,
  getTenantConfig,
  listUsers,
  saveTenantConfig,
  setPassword,
} from './store.js';
import { getTenantClients, invalidateTenant } from './tenant.js';
import { rateLimit } from './rate-limit.js';

/**
 * ZollTax backend: serves the cluster UI (public/) and a JSON API. Multi-tenant
 * — every request is authenticated by a signed session cookie, and the
 * integration clients (myPOS, Shopify, SumUp, ZollTool, Lexware) are built from
 * the logged-in client's own encrypted config. Secrets never reach the browser.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 4000);
const COOKIE = 'zt_sess';
const SECURE_COOKIE = process.env.ZOLLTAX_SECURE_COOKIE === '1';
// Trust X-Forwarded-For only when a reverse proxy actually fronts us — otherwise
// a client could spoof its IP and dodge rate limits.
const TRUST_PROXY = process.env.ZOLLTAX_TRUST_PROXY === '1';
// 8 MB: booking payloads carry a base64 PDF, so keep headroom while still
// capping memory-exhaustion abuse.
const MAX_BODY = Number(process.env.ZOLLTAX_MAX_BODY || 8 * 1024 * 1024);
// Per-client-IP caps. Auth/setup run an expensive hash, so they're tighter.
const GLOBAL_MAX = Number(process.env.ZOLLTAX_RATE_MAX || 300);
const AUTH_MAX = Number(process.env.ZOLLTAX_AUTH_RATE_MAX || 15);
const RATE_WINDOW = 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    // Stop buffering past the cap (memory is now safe). We throw rather than
    // destroy the socket so the 413 response can still be written; a client that
    // keeps uploading is cleaned up by the server's requestTimeout.
    if (total > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

/** Client IP for rate limiting — the proxy's forwarded address only if trusted. */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  const full = normPath(join(PUBLIC_DIR, path));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

// ── Session cookie helpers ───────────────────────────────────────────────────

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}
function sessionUser(req) {
  const id = verifySession(parseCookies(req)[COOKIE]);
  return id ? getUser(id) : null;
}
function setSessionCookie(res, userId) {
  const attrs = [`${COOKIE}=${signSession(userId)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${30 * 24 * 60 * 60}`];
  if (SECURE_COOKIE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── Authenticated API routes: (ctx) → JSON. ctx = { url, body, user, clients } ─

const routes = {
  'GET /api/status': async ({ clients }) => ({
    zolltool: { configured: clients.zoll.configured, url: clients.zoll.config.url || null },
    mypos: { mode: clients.mypos.mode },
    shopify: await clients.shopify.status({ warmToken: true }),
    sumup: clients.sumup.status(),
    lexware: { configured: !!clients.lexware.apiKey, feeCategory: !!clients.lexware.feeCategory },
  }),

  'GET /api/config': async ({ user }) => ({
    groups: CONFIG_GROUPS,
    values: redactConfig(getTenantConfig(user.id)),
  }),

  'PUT /api/config': async ({ user, body }) => {
    if (!masterKeyConfigured()) throw new HttpError(500, 'Server has no encryption key configured (ZOLLTAX_MASTER_KEY).');
    saveTenantConfig(user.id, { set: body.set || {}, clear: body.clear || [] });
    invalidateTenant(user.id);
    return { ok: true, values: redactConfig(getTenantConfig(user.id)) };
  },

  'GET /api/zolltool/events': async ({ clients }) => ({ events: await clients.zoll.getEvents() }),

  'GET /api/zolltool/transactions': async ({ url, clients }) => {
    const eventId = url.searchParams.get('eventId');
    const txns = eventId
      ? await clients.zoll.getEventTransactions(eventId)
      : await clients.zoll.getTransactions(url.searchParams.get('from'), url.searchParams.get('to'));
    return { transactions: txns };
  },

  'GET /api/zolltool/cash': async ({ url, clients }) => {
    const eventId = url.searchParams.get('eventId');
    if (!eventId) throw new HttpError(400, 'eventId is required.');
    const txns = await clients.zoll.getEventTransactions(eventId);
    let cash = 0, currency = 'EUR', count = 0;
    for (const t of txns) {
      if (t.revertedBy) continue;
      const legs = (t.payments || []).filter((p) => p.kind === 'cash');
      if (!legs.length) continue;
      const rate = t.exchangeRate || 1;
      cash += legs.reduce((s, p) => s + (Number(p.amount) || 0), 0) / rate;
      currency = t.baseCurrency || t.currency || currency;
      count++;
    }
    return { eventId, cash: Math.round(cash * 100) / 100, currency, count };
  },

  'GET /api/mypos/accounts': async ({ clients }) => ({
    mode: clients.mypos.mode,
    accounts: await clients.mypos.listAccounts(),
  }),

  'GET /api/mypos/verify': async ({ url, clients }) => {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const account = url.searchParams.get('account') || undefined;
    if (!from || !to) throw new HttpError(400, 'from and to are required (YYYY-MM-DD).');
    const txns = await clients.mypos.listTransactions({ from, to, account });
    return { mode: clients.mypos.mode, summary: summarize(txns), from, to };
  },

  'GET /api/mypos/transactions': async ({ url, clients }) => {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!from || !to) throw new HttpError(400, 'from and to are required (YYYY-MM-DD).');
    const accountsParam = url.searchParams.get('accounts');
    const accounts = accountsParam ? accountsParam.split(',').filter(Boolean) : undefined;
    const transactions = await clients.mypos.listTransactions({ from, to, accounts });
    return { mode: clients.mypos.mode, count: transactions.length, from, to, transactions };
  },

  'GET /api/shopify/orders': async ({ url, clients }) => {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!from || !to) throw new HttpError(400, 'from and to are required (YYYY-MM-DD).');
    const orders = await clients.shopify.listOrders({ from, to });
    return { mode: clients.shopify.mode, count: orders.length, from, to, orders };
  },

  'GET /api/sumup/transactions': async ({ url, clients }) => {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!from || !to) throw new HttpError(400, 'from and to are required (YYYY-MM-DD).');
    const transactions = await clients.sumup.listTransactions({ from, to });
    return { mode: clients.sumup.mode, count: transactions.length, from, to, transactions };
  },

  'POST /api/lexware/book': async ({ body, clients }) => bookVoucher(body, clients.lexware),

  // ── Admin: user (client) management ────────────────────────────────────────
  'GET /api/admin/users': async ({ user }) => {
    requireAdmin(user);
    return { users: listUsers() };
  },
  'POST /api/admin/users': async ({ user, body }) => {
    requireAdmin(user);
    return { user: createUser({ email: body.email, password: body.password, name: body.name, role: body.role }) };
  },
};

function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw new HttpError(403, 'Admins only.');
}

// Admin routes that carry an :id (matched manually, not by exact key).
async function adminUserSubroute(method, path, ctx) {
  const m = /^\/api\/admin\/users\/([^/]+)(\/password)?$/.exec(path);
  if (!m) return undefined;
  requireAdmin(ctx.user);
  const id = m[1];
  if (method === 'DELETE' && !m[2]) {
    if (id === ctx.user.id) throw new HttpError(400, 'You cannot delete your own account.');
    deleteUser(id);
    invalidateTenant(id);
    return { ok: true };
  }
  if (method === 'POST' && m[2] === '/password') {
    setPassword(id, ctx.body.password);
    return { ok: true };
  }
  throw new HttpError(404, 'Not found');
}

// ── Lexware booking (per-tenant credentials) ─────────────────────────────────

async function bookVoucher(p, lexware) {
  const kind = p.kind === 'fees' ? 'fees' : 'revenue';
  const client = new LexwareClient({ apiKey: lexware.apiKey, apiUrl: lexware.apiUrl });

  let voucher;
  let customerName;
  try {
    if (kind === 'fees') {
      voucher = buildFeeVoucher({
        voucherNumber: p.voucherNumber,
        voucherDate: p.voucherDate,
        dueDate: p.dueDate,
        totalGrossAmount: p.totalGrossAmount,
        taxRatePercent: p.taxRatePercent ?? 0,
        taxType: p.taxType ?? 'gross',
        remark: p.remark,
        categoryId: p.categoryId || lexware.feeCategory,
      });
    } else {
      customerName = p.customerName || (p.event?.name ? `Revenue - ${p.event.name}` : undefined);
      voucher = buildRevenueVoucher({
        voucherNumber: p.voucherNumber,
        voucherDate: p.voucherDate ?? p.event?.startDate,
        dueDate: p.dueDate ?? p.event?.endDate,
        taxType: p.taxType ?? 'gross',
        taxRatePercent: p.taxRatePercent ?? p.event?.vatRate ?? 0,
        totalGrossAmount: p.totalGrossAmount,
        remark: p.remark,
        categoryId: resolveCategoryId(p.category),
      });
    }
  } catch (e) {
    throw new HttpError(400, e.message);
  }

  if (p.dryRun) return { dryRun: true, kind, voucher, customerName: customerName ?? null };

  if (!lexware.apiKey) throw new HttpError(400, 'Lexware API key is not configured for this client (Settings → Lexware Office).');
  if (kind === 'revenue' && customerName && p.customer !== 'collective') {
    voucher.contactId = await client.ensureCustomerContact(customerName);
    delete voucher.useCollectiveContact;
  }
  const created = await client.createVoucher(voucher);
  if (p.pdfBase64) {
    await client.uploadVoucherFileBuffer(created.id, Buffer.from(p.pdfBase64, 'base64'), p.filename || `${p.voucherNumber}.pdf`);
  }
  return {
    dryRun: false,
    kind,
    voucherId: created.id,
    permalink: `https://app.lexware.de/permalink/vouchers/view/${created.id}`,
  };
}

// ── Request pipeline ─────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const method = req.method;

    // Static assets (and the SPA) are public; the UI gates itself on /api/auth/me.
    if (method === 'GET' && !path.startsWith('/api/')) return serveStatic(req, res);

    // Per-client-IP rate limiting for the API surface. A coarse global ceiling
    // plus a tight cap on the credential/setup endpoints (which run a hash).
    const ip = clientIp(req);
    const g = rateLimit(`g:${ip}`, GLOBAL_MAX, RATE_WINDOW);
    if (!g.ok) {
      return send(res, 429, { error: 'Too many requests — slow down.' }, { 'retry-after': String(Math.ceil(g.retryAfterMs / 1000)) });
    }
    if (method === 'POST' && (path === '/api/auth/login' || path === '/api/setup')) {
      const a = rateLimit(`a:${ip}`, AUTH_MAX, RATE_WINDOW);
      if (!a.ok) {
        return send(res, 429, { error: 'Too many attempts — try again shortly.' }, { 'retry-after': String(Math.ceil(a.retryAfterMs / 1000)) });
      }
    }

    const body = method === 'POST' || method === 'PUT' ? await readBody(req) : undefined;

    // First-run setup (only usable while no account exists).
    if (method === 'GET' && path === '/api/setup/status') {
      return send(res, 200, { needsSetup: countUsers() === 0, hasMasterKey: masterKeyConfigured() });
    }
    if (method === 'POST' && path === '/api/setup') {
      if (countUsers() > 0) return send(res, 409, { error: 'ZollTax is already set up.' });
      // Generate + persist an encryption key on first run if none was provided.
      if (!masterKeyConfigured()) {
        try {
          persistEnvVar('ZOLLTAX_MASTER_KEY', generateMasterKeyHex());
          resetMasterKeyCache();
        } catch (e) {
          return send(res, 500, {
            error: `Could not save the encryption key to .env (${e.message}). Set ZOLLTAX_MASTER_KEY manually and retry.`,
          });
        }
      }
      let user;
      try {
        user = createUser({ email: body.email, password: body.password, name: body.name, role: 'admin' });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      setSessionCookie(res, user.id);
      return send(res, 200, { user });
    }

    // Public auth endpoints.
    if (method === 'POST' && path === '/api/auth/login') {
      const user = authenticate(body.email, body.password);
      if (!user) return send(res, 401, { error: 'Invalid email or password.' });
      setSessionCookie(res, user.id);
      return send(res, 200, { user });
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      clearSessionCookie(res);
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/auth/me') {
      const user = sessionUser(req);
      if (!user) return send(res, 401, { error: 'Not authenticated' });
      return send(res, 200, { user });
    }

    // Everything else requires a valid session.
    const user = sessionUser(req);
    if (!user) return send(res, 401, { error: 'Not authenticated' });
    const ctx = { url, body, user, clients: getTenantClients(user.id) };

    const sub = await adminUserSubroute(method, path, ctx);
    if (sub !== undefined) return send(res, 200, sub);

    const handler = routes[`${method} ${path}`];
    if (!handler) return send(res, 404, { error: 'Not found' });
    return send(res, 200, await handler(ctx));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err instanceof LexwareApiError ? 502 : 500;
    if (status >= 500) console.error(err);
    send(res, status, { error: err instanceof Error ? err.message : 'Server error' });
  }
});

// Blunt slow-client / slowloris connection-holding: a request must arrive within
// these windows or the socket is closed, freeing it for real traffic.
server.requestTimeout = 30_000; // whole request must complete in 30s
server.headersTimeout = 20_000; // headers must arrive within 20s
server.keepAliveTimeout = 10_000; // idle keep-alive sockets close after 10s

bootstrapAdmin();

server.listen(PORT, () => {
  console.log(`\nZollTax → http://localhost:${PORT}`);
  console.log(`  encryption: ${masterKeyConfigured() ? 'configured' : 'NOT configured (set ZOLLTAX_MASTER_KEY)'}`);
  console.log(`  accounts:   ${listUsers().length}`);
  if (!listUsers().length) {
    console.log(`  → first run: open http://localhost:${PORT} and complete the setup wizard.\n`);
  } else {
    console.log('');
  }
});
