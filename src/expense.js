import { toApiDate } from './voucher.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Build a Lexware "purchaseinvoice" (expense) voucher for a month's myPOS fees.
 * Fees are booked as ONE monthly overview (not per event), so this takes the
 * month's total fee amount and a fee expense category.
 *
 * The expense category is a lexoffice account UUID — set LEXWARE_FEE_CATEGORY to
 * the account you book payment/transaction fees against (e.g. "Nebenkosten des
 * Geldverkehrs"). Without it, the dry-run still previews; a live booking needs it.
 *
 * @param {Object} input
 * @param {string} input.voucherNumber   e.g. "PN_2024_12_F"
 * @param {string} input.voucherDate      YYYY-MM-DD (month end or booking date)
 * @param {number} input.totalGrossAmount fee total (gross)
 * @param {number} [input.taxRatePercent] default 0 (myPOS fees usually reverse-charge/0)
 * @param {'gross'|'net'} [input.taxType]  default 'gross'
 * @param {string} [input.remark]
 * @param {string} [input.categoryId]     expense account UUID (LEXWARE_FEE_CATEGORY)
 * @param {string} [input.contactId]      the fee creditor (e.g. a "myPOS" contact)
 */
export function buildFeeVoucher(input) {
  const {
    voucherNumber,
    voucherDate,
    dueDate,
    totalGrossAmount,
    taxRatePercent = 0,
    taxType = 'gross',
    remark,
    categoryId,
    contactId,
    voucherStatus = 'open',
  } = input;

  if (!voucherDate) throw new Error('voucherDate is required (YYYY-MM-DD).');
  if (totalGrossAmount == null) throw new Error('totalGrossAmount is required.');
  if (!categoryId) throw new Error('A fee expense categoryId is required (set LEXWARE_FEE_CATEGORY).');

  const amount = round2(Number(totalGrossAmount));
  const rate = Number(taxRatePercent) || 0;
  const taxAmount = taxType === 'gross' ? round2(amount - amount / (1 + rate / 100)) : round2(amount * (rate / 100));

  const voucher = {
    type: 'purchaseinvoice',
    voucherStatus,
    voucherDate: toApiDate(voucherDate),
    taxType,
    totalGrossAmount: taxType === 'gross' ? amount : round2(amount + taxAmount),
    totalTaxAmount: taxAmount,
    voucherItems: [{ amount, taxAmount, taxRatePercent: rate, categoryId }],
  };

  if (contactId) voucher.contactId = contactId;
  else voucher.useCollectiveContact = true;
  if (voucherNumber) voucher.voucherNumber = voucherNumber;
  if (dueDate) voucher.dueDate = toApiDate(dueDate);
  if (remark) voucher.remark = remark;

  return voucher;
}
