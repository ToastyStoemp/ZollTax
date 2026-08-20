import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from './config.js';

/**
 * Booking categories (Kategorie) for salesinvoice/revenue vouchers.
 * These are fixed lexoffice UUIDs — the public API exposes only this handful,
 * NOT the full SKR chart. lexoffice shows the account name for whatever ID you
 * send; it does not "change" it. Pick the one that matches your revenue.
 */
export const REVENUE_CATEGORIES = {
  einnahmen: '8f8664a1-fd86-11e1-a21f-0800200c9a66', // generic revenue
  warenverkaeufe: '8f8664a8-fd86-11e1-a21f-0800200c9a66', // goods sales
  dienstleistung: '8f8664a0-fd86-11e1-a21f-0800200c9a66', // services
};

const CATEGORY_LABELS = {
  [REVENUE_CATEGORIES.einnahmen]: 'Einnahmen',
  [REVENUE_CATEGORIES.warenverkaeufe]: 'Warenverkäufe',
  [REVENUE_CATEGORIES.dienstleistung]: 'Dienstleistung',
};

// Friendly aliases → canonical key.
const CATEGORY_ALIASES = {
  revenue: 'einnahmen',
  income: 'einnahmen',
  goods: 'warenverkaeufe',
  warenverkäufe: 'warenverkaeufe',
  warenverkauf: 'warenverkaeufe',
  services: 'dienstleistung',
  service: 'dienstleistung',
};

/** Default category for revenue vouchers: generic "Einnahmen". */
export const REVENUE_CATEGORY_ID = REVENUE_CATEGORIES.einnahmen;

/** Resolve a category name/alias/UUID to a categoryId. Unknown → treated as a raw UUID. */
export function resolveCategoryId(value) {
  if (!value) return REVENUE_CATEGORY_ID;
  const key = String(value).trim().toLowerCase();
  const canonical = CATEGORY_ALIASES[key] || key;
  return REVENUE_CATEGORIES[canonical] || value;
}

/** Human-readable name for a categoryId (falls back to the raw id). */
export function categoryLabel(id) {
  return CATEGORY_LABELS[id] || id;
}

const MAX_RETRIES = 4;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Thin wrapper around the Lexware Office (lexoffice) public REST API.
 * Handles auth, JSON + multipart requests, and 429 rate-limit retries.
 */
export class LexwareClient {
  constructor({ apiKey = config.apiKey, apiUrl = config.apiUrl } = {}) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
  }

  async #request(method, path, { json, body, headers = {} } = {}) {
    const url = `${this.apiUrl}${path}`;
    const finalHeaders = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      ...headers,
    };
    let payload = body;
    if (json !== undefined) {
      finalHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method, headers: finalHeaders, body: payload });

      // Rate limited — respect Retry-After and back off.
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(retryAfter * 1000);
        continue;
      }

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!res.ok) {
        throw new LexwareApiError(res.status, res.statusText, data, `${method} ${path}`);
      }
      return data;
    }
  }

  /**
   * Create a bookkeeping voucher (Beleg). For revenue use type "salesinvoice".
   * Returns { id, resourceUri, ... }.
   */
  createVoucher(voucher) {
    return this.#request('POST', '/vouchers', { json: voucher });
  }

  getVoucher(id) {
    return this.#request('GET', `/vouchers/${id}`);
  }

  /**
   * Attach a file (the PDF) to an existing voucher.
   * @param {string} voucherId
   * @param {string} filePath  path to the PDF on disk
   */
  async uploadVoucherFile(voucherId, filePath) {
    const buffer = await readFile(filePath);
    return this.uploadVoucherFileBuffer(voucherId, buffer, basename(filePath));
  }

  /**
   * Attach a PDF given as in-memory bytes (e.g. generated in the browser and
   * posted as base64) rather than a path on disk.
   * @param {string} voucherId
   * @param {Buffer|Uint8Array} bytes
   * @param {string} filename
   */
  async uploadVoucherFileBuffer(voucherId, bytes, filename) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), basename(filename));
    // Do NOT set Content-Type manually — fetch adds the multipart boundary.
    return this.#request('POST', `/vouchers/${voucherId}/files`, { body: form });
  }

  /** Convenience: verify the key works and return the connected account. */
  getProfile() {
    return this.#request('GET', '/profile');
  }

  /** Find a company contact by exact name (customer role). Returns the contact or null. */
  async findCompanyContactByName(name) {
    const q = encodeURIComponent(name);
    const page = await this.#request('GET', `/contacts?name=${q}&customer=true&size=50`);
    const matches = (page.content || []).filter((c) => c?.company?.name === name);
    return matches[0] || null;
  }

  /** Create a company contact with the customer role. */
  createCompanyContact(name) {
    return this.#request('POST', '/contacts', {
      json: { version: 0, roles: { customer: {} }, company: { name } },
    });
  }

  /**
   * Ensure a customer contact named `name` exists; reuse it if found so we
   * don't create duplicates across bookings. Returns the contact id.
   */
  async ensureCustomerContact(name) {
    const existing = await this.findCompanyContactByName(name);
    if (existing) return existing.id;
    const created = await this.createCompanyContact(name);
    return created.id;
  }
}

export class LexwareApiError extends Error {
  constructor(status, statusText, body, context) {
    const detail =
      body && typeof body === 'object'
        ? body.message || JSON.stringify(body)
        : String(body || '');
    super(`Lexware API ${status} ${statusText} on ${context}${detail ? ` — ${detail}` : ''}`);
    this.name = 'LexwareApiError';
    this.status = status;
    this.body = body;
  }
}
