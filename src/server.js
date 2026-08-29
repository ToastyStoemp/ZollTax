import './load-env.js'; // MUST be first: loads .env before modules read process.env
import './load-env.js'; // side effect: load .env into process.env before anything reads it
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize as normPath } from 'node:path';
import { LexwareClient, LexwareApiError, resolveCategoryId } from './lexware.js';
import { buildRevenueVoucher } from './voucher.js';
import { buildFeeVoucher } from './expense.js';
import { summarize } from './mypos.js';
import { CONFIG_GROUPS, GROUP_IDS, redactConfig } from './config-schema.js';
import { masterKeyConfigured, ensureMasterKey, encryptJson, decryptJson } from './crypto.js';
import {
  authenticate,
  bootstrapAdmin,
  countUsers,
  createUser,
  deleteUser,
  getUser,
  getUserRecord,
  patchUser,
  has2fa,
  getTenantConfig,
  groupEnabled,
  listUsers,
  saveTenantConfig,
  setPassword,
} from './store.js';
import { getTenantClients, invalidateTenant } from './tenant.js';
import {
  EXPENSE_CATEGORIES, listExpenses, addExpense, updateExpense, deleteExpense,
  saveInvoice, readInvoice, computePnl,
} from './ledger.js';
import { rateLimit } from './rate-limit.js';
import { parseInvoicePdf, matchEvent, pingAiKey } from './invoice-ai.js';
import { aiQuota, aiRecord } from './ai-usage.js';
import { createSession, getSession, touchSession, revokeSession, revokeAllForUser, listForUser, listAll } from './sessions.js';
import { parseDevice, lookupGeo, geoEnabled } from './geo.js';
import { generateSecret, otpauthUri, verifyToken, generateRecoveryCodes, hashRecovery } from './totp.js';
import { issueChallenge, verifyChallenge, SOLVER_JS } from './captcha.js';

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
// Invoice scanning (Claude): opt-in per tenant via a key in Settings. A tight
// per-user burst cap sits on top of the persistent daily spend guard.
const PARSE_RATE_MAX = Number(process.env.ZOLLTAX_AI_RATE_MAX || 8);

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
/** The live server-side session for this request's cookie, or null. */
function currentSession(req) {
  const id = parseCookies(req)[COOKIE];
  return id ? getSession(id) : null;
}
function setSessionCookie(res, sessionId) {
  const attrs = [`${COOKIE}=${sessionId}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${30 * 24 * 60 * 60}`];
  if (SECURE_COOKIE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Create a session for a just-authenticated user, enriched with device + geo. */
async function startSession(req, res, userId) {
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  const geo = await lookupGeo(ip);
  const id = createSession({ userId, ip, ua, device: parseDevice(ua), geo });
  setSessionCookie(res, id);
}

// ── Authenticated API routes: (ctx) → JSON. ctx = { url, body, user, clients } ─

const routes = {
  'GET /api/status': async ({ user, clients }) => ({
    enabled: enabledMap(getTenantConfig(user.id)),
    zolltool: { configured: clients.zoll.configured, url: clients.zoll.config.url || null },
    mypos: { mode: clients.mypos.mode },
    shopify: await clients.shopify.status({ warmToken: true }),
    sumup: clients.sumup.status(),
    lexware: { configured: !!clients.lexware.apiKey, feeCategory: !!clients.lexware.feeCategory },
  }),

  'GET /api/config': async ({ user }) => {
    const cfg = getTenantConfig(user.id);
    return { groups: CONFIG_GROUPS, values: redactConfig(cfg), enabled: enabledMap(cfg) };
  },

  'PUT /api/config': async ({ user, body }) => {
    if (!masterKeyConfigured()) throw new HttpError(500, 'Server has no encryption key configured (ZOLLTAX_MASTER_KEY).');
    saveTenantConfig(user.id, { set: body.set || {}, clear: body.clear || [], enabled: body.enabled });
    invalidateTenant(user.id);
    const cfg = getTenantConfig(user.id);
    return { ok: true, values: redactConfig(cfg), enabled: enabledMap(cfg) };
  },

  // Live connectivity check for one integration, using the saved config.
  'POST /api/config/test': async ({ body, clients }) => testConnection(clients, String(body.group || '')),

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

  // ── ZollLedger: per-event expenses + P&L ──
  'GET /api/ledger/expenses': async ({ user, url }) => ({
    categories: EXPENSE_CATEGORIES,
    expenses: listExpenses(user.id, url.searchParams.get('eventId') || undefined),
  }),
  'POST /api/ledger/expenses': async ({ user, body }) => ({ expense: addExpense(user.id, body || {}) }),
  'GET /api/ledger/pnl': async ({ user, clients }) => {
    const expenses = listExpenses(user.id);
    // Event list (for names/countries) — degrade gracefully if ZollTool is off.
    let events = [];
    try { events = await clients.zoll.getEvents(); } catch { /* unreachable */ }
    const known = new Set(events.map((e) => e.id));
    for (const ex of expenses) {
      if (ex.eventId && !known.has(ex.eventId)) { events.push({ id: ex.eventId, name: ex.eventId, venue: {}, dateStart: '' }); known.add(ex.eventId); }
    }
    // Revenue = sum of non-reverted transactions per event, in base currency.
    const revenueByEvent = {};
    try {
      for (const t of await clients.zoll.getTransactions()) {
        if (t.revertedBy) continue;
        const base = t.baseTotal != null ? Number(t.baseTotal) : (Number(t.total) || 0) / (t.exchangeRate || 1);
        revenueByEvent[t.eventId] = (revenueByEvent[t.eventId] || 0) + base;
      }
    } catch { /* revenue stays 0 when ZollTool is unreachable */ }
    const rows = computePnl(events, revenueByEvent, expenses)
      .sort((a, b) => (b.start || '').localeCompare(a.start || ''));
    return { rows, sourceOk: clients.zoll.configured };
  },

  // Scan an invoice PDF with Claude → prefill fields + auto-match an event.
  // Cost is bounded three ways: a PDF size cap, a per-IP burst limit, and the
  // persistent daily call/token quota (ai-usage.js) — the hard bill ceiling.
  'POST /api/ledger/parse': async ({ user, body, clients }) => {
    const ai = clients.ai;
    if (!ai.configured) throw new HttpError(503, 'Invoice scanning is off — add an Anthropic API key in Settings → Invoice scanning.');
    const base64 = String((body && body.base64) || '');
    if (!base64) throw new HttpError(400, 'No PDF provided.');
    const approxBytes = Math.floor((base64.length * 3) / 4);
    if (approxBytes > ai.maxPdfBytes) {
      throw new HttpError(413, `PDF too large (max ${Math.round(ai.maxPdfBytes / 1024 / 1024)} MB).`);
    }
    const burst = rateLimit(`ai:${user.id}`, PARSE_RATE_MAX, RATE_WINDOW);
    if (!burst.ok) throw new HttpError(429, 'Too many scans — wait a moment and try again.');
    const limits = { dailyCalls: ai.dailyCalls, dailyTokens: ai.dailyTokens };
    if (!aiQuota(user.id, limits).ok) throw new HttpError(429, 'The daily invoice-scan limit has been reached. Try again tomorrow.');
    const { fields, usage } = await parseInvoicePdf(base64, ai);
    aiRecord(user.id, usage); // count real token spend against today's budget
    let events = [];
    try { events = await clients.zoll.getEvents(); } catch { /* no ZollTool → skip matching */ }
    const { match, candidates } = matchEvent(fields, events);
    return { fields, match, candidates, remainingToday: aiQuota(user.id, limits).remainingCalls };
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

  // ── Two-factor auth (TOTP authenticator) ───────────────────────────────────
  // Account: change your own password (verifies the current one).
  'PUT /api/account/password': async ({ user, body }) => {
    const cur = String((body || {}).currentPassword || '');
    const next = String((body || {}).newPassword || '');
    if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
    if (!authenticate(user.email, cur)) throw new HttpError(401, 'Current password is incorrect.');
    setPassword(user.id, next);
    return { ok: true };
  },

  'GET /api/2fa/status': async ({ user }) => ({ enabled: has2fa(user.id) }),
  'POST /api/2fa/setup': async ({ user }) => {
    // Generate a secret and stash it (encrypted, not yet enabled). Shown once for
    // manual entry / as an otpauth:// link to add to an authenticator app.
    const secret = generateSecret();
    patchUser(user.id, { totpEnc: encryptJson(secret), totpEnabled: false });
    return { secret, otpauth: otpauthUri({ secret, account: user.email, issuer: 'ZollTax' }) };
  },
  'POST /api/2fa/enable': async ({ user, body }) => {
    const rec = getUserRecord(user.id);
    if (!rec?.totpEnc) throw new HttpError(400, 'Start 2FA setup first.');
    if (!verifyToken(decryptJson(rec.totpEnc), body.code)) {
      throw new HttpError(400, 'That code is not valid — check your device clock and try again.');
    }
    const codes = generateRecoveryCodes(10);
    patchUser(user.id, { totpEnabled: true, recovery: codes.map(hashRecovery) });
    return { enabled: true, recovery: codes }; // recovery codes shown exactly once
  },
  'POST /api/2fa/disable': async ({ user, body }) => {
    const rec = getUserRecord(user.id);
    if (!rec?.totpEnabled) return { enabled: false };
    const ok = verifyToken(decryptJson(rec.totpEnc), body.code) || (rec.recovery || []).includes(hashRecovery(body.code || ''));
    if (!ok) throw new HttpError(400, 'Enter a valid authenticator or recovery code to disable 2FA.');
    patchUser(user.id, { totpEnc: null, totpEnabled: false, recovery: [] });
    return { enabled: false };
  },

  // ── Sessions (this account) ────────────────────────────────────────────────
  'GET /api/sessions': async ({ user, sessionId }) => ({
    geo: geoEnabled(),
    sessions: listForUser(user.id).map((s) => ({ ...s, current: s.id === sessionId })),
  }),

  // ── Admin: user (client) management ────────────────────────────────────────
  'GET /api/admin/users': async ({ user }) => {
    requireAdmin(user);
    return { users: listUsers() };
  },
  'POST /api/admin/users': async ({ user, body }) => {
    requireAdmin(user);
    return { user: createUser({ email: body.email, password: body.password, name: body.name, role: body.role }) };
  },
  'GET /api/admin/sessions': async ({ user, sessionId }) => {
    requireAdmin(user);
    const byId = Object.fromEntries(listUsers().map((u) => [u.id, u]));
    return {
      geo: geoEnabled(),
      sessions: listAll().map((s) => ({
        ...s,
        current: s.id === sessionId,
        email: byId[s.userId]?.email || s.userId,
        role: byId[s.userId]?.role || '',
      })),
    };
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

// Revoke a session by id — your own (/api/sessions/:id) or any (admin).
async function sessionSubroute(method, path, ctx) {
  if (method !== 'DELETE') return undefined;
  let m = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (m) {
    if (!listForUser(ctx.user.id).some((s) => s.id === m[1])) throw new HttpError(404, 'Session not found');
    revokeSession(m[1]);
    return { ok: true };
  }
  m = /^\/api\/admin\/sessions\/([^/]+)$/.exec(path);
  if (m) {
    requireAdmin(ctx.user);
    revokeSession(m[1]);
    return { ok: true };
  }
  return undefined;
}

// ZollLedger: edit/delete an expense, or attach its invoice PDF (id in the path).
async function ledgerSubroute(method, path, ctx) {
  let m = /^\/api\/ledger\/expenses\/([^/]+)$/.exec(path);
  if (m) {
    if (method === 'PUT') {
      const expense = updateExpense(ctx.user.id, m[1], ctx.body || {});
      if (!expense) throw new HttpError(404, 'Expense not found');
      return { expense };
    }
    if (method === 'DELETE') {
      if (!deleteExpense(ctx.user.id, m[1])) throw new HttpError(404, 'Expense not found');
      return { ok: true };
    }
  }
  m = /^\/api\/ledger\/expenses\/([^/]+)\/invoice$/.exec(path);
  if (m && method === 'POST') {
    const expense = saveInvoice(ctx.user.id, m[1], (ctx.body || {}).base64, (ctx.body || {}).filename);
    if (!expense) throw new HttpError(400, 'No such expense, or the file was empty.');
    return { expense };
  }
  return undefined;
}

// ── Config: per-group enable + connectivity test ─────────────────────────────

const enabledMap = (cfg) => Object.fromEntries(GROUP_IDS.map((id) => [id, groupEnabled(cfg, id)]));

/** Live check for one integration using the tenant's saved config. */
async function testConnection(clients, group) {
  try {
    switch (group) {
      case 'lexware': {
        if (!clients.lexware.apiKey) return { ok: false, detail: 'No API key set.' };
        const p = await new LexwareClient({ apiKey: clients.lexware.apiKey, apiUrl: clients.lexware.apiUrl }).ping();
        return { ok: true, detail: `Connected${p?.companyName ? ` — ${p.companyName}` : ''}.` };
      }
      case 'zolltool': {
        if (!clients.zoll.configured) return { ok: false, detail: 'Not configured (server URL + token or login).' };
        await clients.zoll.connect();
        return { ok: true, detail: 'ZollTool read API reachable.' };
      }
      case 'ai': {
        if (!clients.ai.configured) return { ok: false, detail: 'No API key set.' };
        const p = await pingAiKey(clients.ai.apiKey);
        return p.ok ? { ok: true, detail: `API key valid — using ${clients.ai.model}.` } : { ok: false, detail: p.detail || 'Key check failed.' };
      }
      case 'mypos': {
        if (clients.mypos.mode !== 'live') return { ok: false, detail: 'Missing myPOS credentials.' };
        const gw = String(clients.mypos.config?.gatewayUrl || '').replace(/^https?:\/\//, '') || '(none)';
        const cid = String(clients.mypos.config?.clientId || '');
        const cidHint = cid ? `${cid.slice(0, 12)}…` : '(none)';
        try {
          const accounts = await clients.mypos.listAccounts();
          return { ok: true, detail: `Authenticated — ${accounts.length} account(s) via ${gw}.` };
        } catch (e) {
          return { ok: false, detail: `${e instanceof Error ? e.message : String(e)} [gateway: ${gw}, client: ${cidHint}]` };
        }
      }
      case 'shopify': {
        const st = await clients.shopify.status({ warmToken: true });
        if (st.mode !== 'live') return { ok: false, detail: 'Missing Shopify credentials.' };
        if (st.ready === false) return { ok: false, detail: 'Token exchange failed — check the client ID/secret.' };
        return { ok: true, detail: `Connected to ${st.shop || 'Shopify'}.` };
      }
      case 'sumup': {
        if (clients.sumup.mode !== 'live') return { ok: false, detail: 'Missing SumUp credentials.' };
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
        await clients.sumup.listTransactions({ from, to });
        return { ok: true, detail: 'SumUp API reachable.' };
      }
      default:
        return { ok: false, detail: 'Unknown integration.' };
    }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
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

    // Proof-of-work CAPTCHA (public): a challenge + the inline browser solver.
    if (method === 'GET' && path === '/api/captcha/challenge') return send(res, 200, issueChallenge());
    if (method === 'GET' && path === '/api/captcha/solver.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      return res.end(SOLVER_JS);
    }

    const body = method === 'POST' || method === 'PUT' ? await readBody(req) : undefined;

    // First-run setup (only usable while no account exists).
    if (method === 'GET' && path === '/api/setup/status') {
      return send(res, 200, { needsSetup: countUsers() === 0, hasMasterKey: masterKeyConfigured() });
    }
    if (method === 'POST' && path === '/api/setup') {
      if (countUsers() > 0) return send(res, 409, { error: 'ZollTax is already set up.' });
      // Account creation is bot-gated by the proof-of-work CAPTCHA.
      const cap = verifyChallenge(body.captchaToken, body.captchaSolution);
      if (!cap.ok) return send(res, 400, { error: cap.error });
      // Generate + persist an encryption key on first run if none was provided.
      try {
        ensureMasterKey();
      } catch (e) {
        return send(res, 500, {
          error: `Could not initialize the encryption key (${e.message}). Ensure the data dir is writable, or set ZOLLTAX_MASTER_KEY.`,
        });
      }
      let user;
      try {
        user = createUser({ email: body.email, password: body.password, name: body.name, role: 'admin' });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      await startSession(req, res, user.id);
      return send(res, 200, { user, features: { invoiceScan: getTenantClients(user.id).ai.configured } });
    }

    // Public auth endpoints.
    if (method === 'POST' && path === '/api/auth/login') {
      const user = authenticate(body.email, body.password);
      if (!user) return send(res, 401, { error: 'Invalid email or password.' });
      // Second factor, if this account has it enabled.
      if (has2fa(user.id)) {
        const rec = getUserRecord(user.id);
        const code = String(body.code || '').trim();
        if (!code) return send(res, 401, { error: 'Authenticator code required.', needs2fa: true });
        if (verifyToken(decryptJson(rec.totpEnc), code)) {
          /* valid TOTP */
        } else {
          const idx = (rec.recovery || []).indexOf(hashRecovery(code));
          if (idx < 0) return send(res, 401, { error: 'Invalid authenticator code.', needs2fa: true });
          const remaining = rec.recovery.slice();
          remaining.splice(idx, 1); // recovery codes are single-use
          patchUser(user.id, { recovery: remaining });
        }
      }
      await startSession(req, res, user.id);
      return send(res, 200, { user, features: { invoiceScan: getTenantClients(user.id).ai.configured } });
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      const sess = currentSession(req);
      if (sess) revokeSession(sess.id);
      clearSessionCookie(res);
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/auth/me') {
      const sess = currentSession(req);
      const user = sess ? getUser(sess.userId) : null;
      if (!user) return send(res, 401, { error: 'Not authenticated' });
      return send(res, 200, { user, twoFactor: has2fa(user.id), features: { invoiceScan: getTenantClients(user.id).ai.configured } });
    }

    // Everything else requires a valid server-side session.
    const sess = currentSession(req);
    if (!sess) return send(res, 401, { error: 'Not authenticated' });
    const user = getUser(sess.userId);
    if (!user) {
      revokeSession(sess.id);
      return send(res, 401, { error: 'Not authenticated' });
    }
    touchSession(sess.id);
    const ctx = { url, body, user, sessionId: sess.id, ip, clients: getTenantClients(user.id) };

    // Ledger invoice PDF download (binary — bypasses the JSON senders).
    const invM = /^\/api\/ledger\/expenses\/([^/]+)\/invoice$/.exec(path);
    if (method === 'GET' && invM) {
      const inv = readInvoice(user.id, invM[1]);
      if (!inv) return send(res, 404, { error: 'No invoice on file.' });
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${inv.filename.replace(/["\r\n]/g, '')}"`,
      });
      return res.end(inv.buffer);
    }

    const sub = (await adminUserSubroute(method, path, ctx))
      ?? (await sessionSubroute(method, path, ctx))
      ?? (await ledgerSubroute(method, path, ctx));
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

// Ensure an encryption key exists, generating + persisting one to the data
// volume when neither an env key nor a prior key file is present. Self-heals
// installs that reached this point without a key (e.g. an env-seeded admin, or
// a container whose earlier key was written to an ephemeral .env).
try {
  ensureMasterKey();
} catch (e) {
  console.error(`  encryption: could not initialize key — ${e.message} (set ZOLLTAX_MASTER_KEY or make the data dir writable)`);
}

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
