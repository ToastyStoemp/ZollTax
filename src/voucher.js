import { REVENUE_CATEGORY_ID } from './lexware.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Convert "YYYY-MM-DD" to the RFC-3339 datetime lexoffice expects, at local
 * midnight with the correct Europe/Berlin UTC offset for that date (CET/CEST).
 * A plain date is returned unchanged if it already contains a time part.
 */
export function toApiDate(dateStr) {
  if (!dateStr || /T/.test(dateStr)) return dateStr;
  const offset = berlinOffset(dateStr);
  return `${dateStr}T00:00:00.000${offset}`;
}

function berlinOffset(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    timeZoneName: 'longOffset',
  }).formatToParts(d);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+01:00';
  const m = tz.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : '+01:00';
}

/**
 * Build a valid Lexware "salesinvoice" (revenue) voucher payload.
 *
 * Amounts: provide `voucherItems` (each: amount, taxRatePercent, [categoryId])
 * to split across VAT rates, OR a single `totalGrossAmount` + `taxRatePercent`.
 * `taxType` "gross" means amounts INCLUDE tax; "net" means they exclude it.
 *
 * Contact: pass `contactId` for a named customer, otherwise the voucher uses
 * the collective contact (useCollectiveContact).
 *
 * @returns the JSON body for POST /vouchers
 */
export function buildRevenueVoucher(input) {
  const {
    voucherNumber,
    voucherDate,
    dueDate,
    taxType = 'gross',
    taxRatePercent,
    totalGrossAmount,
    voucherItems,
    remark,
    contactId,
    voucherStatus = 'open',
    categoryId = REVENUE_CATEGORY_ID,
  } = input;

  if (!voucherDate) throw new Error('voucherDate is required (format YYYY-MM-DD).');
  if (taxType !== 'gross' && taxType !== 'net') {
    throw new Error(`taxType must be "gross" or "net", got "${taxType}".`);
  }

  let items;
  if (Array.isArray(voucherItems) && voucherItems.length > 0) {
    items = voucherItems.map((it) => normaliseItem(it, taxType, categoryId));
  } else {
    if (totalGrossAmount == null || taxRatePercent == null) {
      throw new Error(
        'Provide either `voucherItems`, or both `totalGrossAmount` and `taxRatePercent`.'
      );
    }
    items = [normaliseItem({ amount: totalGrossAmount, taxRatePercent, categoryId }, taxType, categoryId)];
  }

  const netOrGrossTotal = round2(items.reduce((s, it) => s + it.amount, 0));
  const totalTax = round2(items.reduce((s, it) => s + it.taxAmount, 0));

  const voucher = {
    type: 'salesinvoice',
    voucherStatus,
    voucherDate: toApiDate(voucherDate),
    taxType,
    totalGrossAmount: taxType === 'gross' ? netOrGrossTotal : round2(netOrGrossTotal + totalTax),
    totalTaxAmount: totalTax,
    voucherItems: items,
  };

  if (contactId) voucher.contactId = contactId;
  else voucher.useCollectiveContact = true;

  if (voucherNumber) voucher.voucherNumber = voucherNumber;
  if (dueDate) voucher.dueDate = toApiDate(dueDate);
  if (remark) voucher.remark = remark;

  return voucher;
}

function normaliseItem(it, taxType, defaultCategoryId) {
  const rate = Number(it.taxRatePercent);
  if (Number.isNaN(rate)) throw new Error('Each voucher item needs a numeric taxRatePercent.');
  const amount = round2(Number(it.amount));
  if (Number.isNaN(amount)) throw new Error('Each voucher item needs a numeric amount.');

  const taxAmount =
    taxType === 'gross'
      ? round2(amount - amount / (1 + rate / 100))
      : round2(amount * (rate / 100));

  return {
    amount,
    taxAmount,
    taxRatePercent: rate,
    categoryId: it.categoryId || defaultCategoryId,
  };
}
