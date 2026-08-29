/**
 * Invoice PDF → structured expense fields, via the Anthropic Messages API.
 *
 * Zero-dep: a single fetch, no SDK. The PDF is sent as a document block so we
 * never parse PDF bytes ourselves — Claude reads the text layer (and does light
 * OCR on scans). Cost is bounded upstream by ai-usage.js (persistent daily caps)
 * and here by a cheap model + a small max_tokens ceiling + a PDF size cap.
 *
 * Enabled only when ANTHROPIC_API_KEY is set, so the feature is opt-in per
 * deployment. Invoice PDFs are sent to Anthropic when a user scans one — a
 * conscious privacy trade the operator makes by configuring the key.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';

export function aiConfig(env = process.env) {
  return {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ZOLLTAX_AI_MODEL || 'claude-haiku-4-5',
    maxTokens: Number(env.ZOLLTAX_AI_MAX_TOKENS || 1024),
    maxPdfBytes: Number(env.ZOLLTAX_AI_MAX_PDF || 5 * 1024 * 1024),
    timeoutMs: Number(env.ZOLLTAX_AI_TIMEOUT_MS || 25_000),
  };
}
export const aiEnabled = (env = process.env) => !!aiConfig(env).apiKey;

const PROMPT = `You are extracting expense data from a single invoice or receipt PDF — a business cost for a market/convention vendor (hotel, travel, booth/stand fee, or other).
Return ONLY a JSON object, no prose, with exactly these keys:
{
  "vendor": string,            // business name on the invoice, e.g. "Hotel Ibis Koeln"
  "category": "booth"|"travel"|"accommodation"|"other",
  "amount": number,            // grand total actually paid, incl. tax; digits only, no currency symbol
  "currency": string,          // ISO 4217, 3 letters, e.g. "EUR"
  "date": string,              // invoice/issue date, YYYY-MM-DD; "" if unknown
  "stayStart": string,         // hotel check-in / service start, YYYY-MM-DD; "" if not applicable
  "stayEnd": string,           // hotel check-out / service end, YYYY-MM-DD; "" if not applicable
  "country": string,           // country of the vendor/venue, English name, e.g. "Germany"; "" if unknown
  "confidence": number         // 0..1, your confidence in amount + date
}
Rules: use the final grand total (never a subtotal or a per-night rate). If several dates appear, "date" is the invoice date and stayStart/stayEnd are the accommodation nights. Category is "accommodation" for hotels, "travel" for flights/trains/fuel/taxi/parking, "booth" for stand/table/exhibitor fees, otherwise "other".`;

/** Call Claude to read one PDF. Returns { fields, usage:{inputTokens,outputTokens} }. */
export async function parseInvoicePdf(base64, cfg = aiConfig()) {
  const payload = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      },
      { role: 'assistant', content: '{' }, // prefill forces a bare JSON object, no preamble
    ],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'The document reader timed out.' : 'Could not reach the document reader.');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `Reader error (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  const text = '{' + (Array.isArray(data.content) ? data.content.map((b) => b.text || '').join('') : '');
  return {
    fields: coerceFields(safeJson(text)),
    usage: {
      inputTokens: Number(data.usage && data.usage.input_tokens) || 0,
      outputTokens: Number(data.usage && data.usage.output_tokens) || 0,
    },
  };
}

function safeJson(t) {
  try { return JSON.parse(t); } catch { /* not clean JSON — try to salvage */ }
  const m = String(t).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return {};
}

const CATS = new Set(['booth', 'travel', 'accommodation', 'other']);
const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : '');

/** Clamp/normalize the model output into the shape the expense form expects. */
export function coerceFields(o) {
  o = o && typeof o === 'object' ? o : {};
  return {
    vendor: String(o.vendor || '').slice(0, 200),
    category: CATS.has(o.category) ? o.category : 'other',
    amount: Math.max(0, Math.round((Number(o.amount) || 0) * 100) / 100),
    currency: String(o.currency || 'EUR').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'EUR',
    date: isoDate(o.date),
    stayStart: isoDate(o.stayStart),
    stayEnd: isoDate(o.stayEnd),
    country: String(o.country || '').slice(0, 60),
    confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0)),
  };
}

// ── Event matching ───────────────────────────────────────────────────────────

/**
 * Rank a tenant's events against parsed invoice fields. Date overlap is the
 * strong signal (hotel nights / invoice date near the event window, with a
 * couple of days' slack for arrival & departure); country is a secondary boost.
 * `match` is set only when the top candidate is unambiguous.
 */
export function matchEvent(fields, events) {
  const iv = invoiceRange(fields);
  const country = normCountry(fields && fields.country);
  const scored = (events || [])
    .map((ev) => {
      const evStart = isoDate(ev.dateStart);
      const evEnd = isoDate(ev.dateEnd) || evStart;
      const why = [];
      let score = 0;
      if (iv && evStart && rangesOverlap(iv.start, iv.end, addDays(evStart, -2), addDays(evEnd, 2))) {
        score += 60;
        why.push('dates');
      }
      const evCountry = normCountry((ev.venue && ev.venue.country) || ev.country);
      if (country && evCountry && country === evCountry) {
        score += 30;
        why.push('country');
      }
      return { eventId: ev.id, name: ev.name || ev.id, country: (ev.venue && ev.venue.country) || '', start: evStart, score, why };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  // Auto-pick only when the dates matched and the lead isn't tied with the runner-up.
  const match = scored[0] && scored[0].score >= 60 && (!scored[1] || scored[1].score < scored[0].score) ? scored[0] : null;
  return { match, candidates: scored.slice(0, 5) };
}

function invoiceRange(f) {
  if (!f) return null;
  const start = f.stayStart || f.date;
  if (!start) return null;
  return { start, end: f.stayEnd || f.stayStart || f.date || start };
}
const rangesOverlap = (aS, aE, bS, bE) => aS <= bE && bS <= aE;
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// A few common aliases so "DE"/"Deutschland" match ZollTool's "Germany".
const COUNTRY_ALIASES = {
  de: 'germany', deu: 'germany', deutschland: 'germany', ger: 'germany',
  at: 'austria', aut: 'austria', oesterreich: 'austria', 'österreich': 'austria',
  be: 'belgium', bel: 'belgium', belgie: 'belgium', 'belgië': 'belgium', belgique: 'belgium',
  nl: 'netherlands', nld: 'netherlands', nederland: 'netherlands', holland: 'netherlands',
  fr: 'france', fra: 'france', frankreich: 'france',
  uk: 'united kingdom', gb: 'united kingdom', gbr: 'united kingdom', england: 'united kingdom',
  us: 'united states', usa: 'united states', 'united states of america': 'united states',
  ch: 'switzerland', che: 'switzerland', schweiz: 'switzerland',
  it: 'italy', ita: 'italy', italia: 'italy',
  es: 'spain', esp: 'spain', 'españa': 'spain', espana: 'spain',
};
function normCountry(c) {
  const s = String(c || '').trim().toLowerCase();
  return COUNTRY_ALIASES[s] || s;
}
