import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveCategoryId } from './lexware.js';

/**
 * @typedef {Object} LexEvent  A convention / point-of-sale event.
 * @property {string} name       e.g. "Aninite"
 * @property {string} country    e.g. "Austria"
 * @property {string} startDate  YYYY-MM-DD — first day (→ Belegdatum & payment date)
 * @property {string} endDate    YYYY-MM-DD — last day  (→ Fälligkeitsdatum)
 * @property {number} vatRate    VAT percent applied to the revenue, e.g. 0, 7, 19, 20, 21
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Load a catalog of reusable events keyed by id: { aninite: { name, ... } }. */
export function loadEventCatalog(path) {
  if (!path) return {};
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`Events catalog not found: ${full}`);
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse events catalog ${full}: ${e.message}`);
  }
}

/**
 * Resolve an event reference into a full event object.
 * @param {string|LexEvent} ref  an id into the catalog, or an inline event object
 * @param {Record<string, LexEvent>} catalog
 */
export function resolveEvent(ref, catalog = {}) {
  let event;
  if (typeof ref === 'string') {
    event = catalog[ref];
    if (!event) {
      const ids = Object.keys(catalog);
      throw new Error(
        `Unknown event id "${ref}".` +
          (ids.length ? ` Known ids: ${ids.join(', ')}.` : ' The events catalog is empty.')
      );
    }
  } else if (ref && typeof ref === 'object') {
    event = ref;
  } else {
    throw new Error('No event provided. Set "event" in your data file or pass event flags.');
  }
  return validateEvent(event);
}

/** Validate + normalise an event, throwing on missing/invalid fields. */
export function validateEvent(e) {
  const missing = ['name', 'country', 'startDate', 'endDate'].filter((k) => !e?.[k]);
  if (missing.length) throw new Error(`Event is missing: ${missing.join(', ')}.`);
  for (const k of ['startDate', 'endDate']) {
    if (!DATE_RE.test(e[k])) throw new Error(`Event ${k} must be YYYY-MM-DD, got "${e[k]}".`);
  }
  if (e.startDate > e.endDate) {
    throw new Error(`Event startDate (${e.startDate}) is after endDate (${e.endDate}).`);
  }
  const vatRate = e.vatRate == null ? 0 : Number(e.vatRate);
  if (Number.isNaN(vatRate) || vatRate < 0) {
    throw new Error(`Event vatRate must be a non-negative number, got "${e.vatRate}".`);
  }
  return { ...e, vatRate };
}

/**
 * Turn an event + booking amounts into the voucher input consumed by
 * buildRevenueVoucher(). This is where the screenshot's derived fields live:
 *
 *   Kunde            → "Revenue - {name}"                    (customerName)
 *   Belegdatum       → event.startDate                       (voucherDate)
 *   Fälligkeitsdatum → event.endDate                         (dueDate)
 *   Beschreibung     → "Point of Sales - {name} - {country}" (remark)
 *   Steuer           → event.vatRate                         (taxRatePercent)
 *   Zahlungsdatum    → event.startDate                       (paymentDate, informational)
 *
 * @param {LexEvent} event
 * @param {Object} booking { voucherNumber, totalGrossAmount, taxType?, voucherStatus?, categoryId? }
 */
export function deriveVoucherInput(event, booking = {}) {
  return {
    voucherNumber: booking.voucherNumber,
    voucherDate: event.startDate,
    dueDate: event.endDate,
    taxType: booking.taxType ?? 'gross',
    taxRatePercent: event.vatRate,
    totalGrossAmount: booking.totalGrossAmount,
    voucherItems: booking.voucherItems, // optional multi-rate split; overrides the single item
    remark: `Point of Sales - ${event.name} - ${event.country}`,
    customerName: `Revenue - ${event.name}`,
    voucherStatus: booking.voucherStatus ?? 'open',
    paymentDate: event.startDate,
    categoryId: resolveCategoryId(booking.category ?? booking.categoryId),
  };
}
