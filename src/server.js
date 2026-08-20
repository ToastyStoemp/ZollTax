import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize as normPath } from 'node:path';
import { config, assertApiKey } from './config.js';
import { LexwareClient, LexwareApiError, resolveCategoryId } from './lexware.js';
import { buildRevenueVoucher } from './voucher.js';
import { buildFeeVoucher } from './expense.js';
import { MyposClient, summarize } from './mypos.js';
import { ZolltoolClient } from './zolltool.js';

/**
 * Accounting bridge backend: serves the cluster UI (public/) and a small JSON
 * API that the page cannot do itself because it needs secrets / cross-origin
 * access — reading ZollTool events, verifying against live myPOS, and booking
 * Lexware vouchers. All credentials stay here (env), never in the browser.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 4000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
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

// Reused across requests so the ZollTool session / myPOS token can be cached.
const zoll = new ZolltoolClient();
const mypos = new MyposClient();

const routes = {
  'GET /api/status': async () => ({
    zolltool: { configured: zoll.configured, url: zoll.config.url || null },
    mypos: { mode: mypos.mode },
    lexware: { configured: !!config.apiKey, feeCategory: !!process.env.LEXWARE_FEE_CATEGORY },
  }),

  'GET /api/zolltool/events': async () => {
    const events = await zoll.getEvents();
    return { events };
  },

  'GET /api/zolltool/transactions': async (url) => {
    const eventId = url.searchParams.get('eventId');
    const txns = eventId
      ? await zoll.getEventTransactions(eventId)
      : await zoll.getTransactions(url.searchParams.get('from'), url.searchParams.get('to'));
    return { transactions: txns };
  },

  'GET /api/mypos/verify': async (url) => {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const account = url.searchParams.get('account') || undefined;
    if (!from || !to) throw new HttpError(400, 'from and to are required (YYYY-MM-DD).');
    const txns = await mypos.listTransactions({ from, to, account });
    return { mode: mypos.mode, summary: summarize(txns), from, to };
  },

  'POST /api/lexware/book': async (_url, body) => bookVoucher(body),
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function bookVoucher(p) {
  const kind = p.kind === 'fees' ? 'fees' : 'revenue';
  const client = new LexwareClient();

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
        categoryId: p.categoryId || process.env.LEXWARE_FEE_CATEGORY,
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
    // Validation / missing-config failures are the caller's fault → 400, not 500.
    throw new HttpError(400, e.message);
  }

  if (p.dryRun) return { dryRun: true, kind, voucher, customerName: customerName ?? null };

  assertApiKey();
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(req, res);
      return send(res, 404, { error: 'Not found' });
    }
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const result = await handler(url, body);
    send(res, 200, result);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err instanceof LexwareApiError ? 502 : 500;
    if (status >= 500) console.error(err);
    send(res, status, { error: err instanceof Error ? err.message : 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\nAccounting bridge → http://localhost:${PORT}`);
  console.log(`  ZollTool: ${zoll.configured ? zoll.config.url : 'not configured'}`);
  console.log(`  myPOS:    ${mypos.mode} mode`);
  console.log(`  Lexware:  ${config.apiKey ? 'configured' : 'not configured'}\n`);
});
