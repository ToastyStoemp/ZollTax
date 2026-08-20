#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { config, assertApiKey } from './config.js';
import { LexwareClient, LexwareApiError, categoryLabel } from './lexware.js';
import { buildRevenueVoucher } from './voucher.js';
import { loadEventCatalog, resolveEvent, deriveVoucherInput } from './events.js';

const HELP = `
ZollTax CLI — book a revenue PDF into Lexware Office (lexoffice)

Usage:
  node src/index.js [payload.json] [--dry-run]
  node src/index.js --check

Reads a single payload file (default ./payload.json) describing the event and
amounts, builds a salesinvoice voucher, and attaches the PDF. See payload.json
for the shape and README.md for how each field maps to the Lexware UI.

Options:
  --dry-run     Build & print the payload, send nothing (no contact created).
  --events <f>  Events catalog to resolve a string "event" id (default ./data/events.json).
  --check       Verify the API key (GET /profile) and exit.
  -h, --help    Show this help.

Environment (.env or shell):
  LEXWARE_API_KEY   Your public API key (required to send).
  LEXWARE_API_URL   API base URL. Default ${config.apiUrl}
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--check') args.check = true;
    else if (a === '--events') args.events = argv[++i];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

function loadJson(path, label) {
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`${label} not found: ${full}`);
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse ${label} ${full}: ${e.message}`);
  }
}

const fmtEuro = (n) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);

function printSummary({ voucher, event, pdfPath, customerLabel, paymentDate, voucherStatus }) {
  console.log('\n── Voucher to be booked ─────────────────────────────');
  console.log(`  Kunde:            ${customerLabel}`);
  console.log(`  Belegtyp:         Einnahme (salesinvoice)`);
  console.log(`  Belegnummer:      ${voucher.voucherNumber ?? '(none)'}`);
  console.log(`  Belegdatum:       ${event.startDate}   (event start)`);
  console.log(`  Fälligkeitsdatum: ${event.endDate}   (event end)`);
  console.log(`  Beschreibung:     ${voucher.remark ?? ''}`);
  console.log(`  Kategorie:        ${categoryLabel(voucher.voucherItems[0]?.categoryId)}`);
  console.log(`  Steuer:           ${event.vatRate === 0 ? 'Keine' : event.vatRate + '%'}`);
  console.log(`  Gesamtbetrag:     ${fmtEuro(voucher.totalGrossAmount)}  (tax ${fmtEuro(voucher.totalTaxAmount)})`);
  for (const [i, it] of voucher.voucherItems.entries()) {
    if (voucher.voucherItems.length > 1)
      console.log(`     • item ${i + 1}: ${fmtEuro(it.amount)} @ ${it.taxRatePercent}%`);
  }
  console.log(`  Belegstatus:      ${voucherStatus}   (Zahlungsdatum ${paymentDate})`);
  console.log(`  PDF:              ${pdfPath}`);
  console.log('─────────────────────────────────────────────────────\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const client = new LexwareClient();

  if (args.check) {
    assertApiKey();
    const profile = await client.getProfile();
    console.log('✓ API key works. Connected organisation:');
    console.log(`  ${profile.companyName ?? '(unknown)'}  —  ${profile.organizationId ?? ''}`);
    return;
  }

  const payloadPath = args._[0] || './payload.json';
  const payload = loadJson(payloadPath, 'payload');
  const payloadDir = dirname(resolve(payloadPath));

  // Resolve the event (inline object, or a string id into the catalog).
  const event = resolveEvent(payload.event, safeCatalog(args.events));

  // Build voucher input from the event + booking amounts.
  const input = deriveVoucherInput(event, payload);
  const useCollective = payload.customer === 'collective';

  // PDF path — resolve relative to the payload file.
  if (!payload.pdf) throw new Error('payload.pdf is required (path to the revenue PDF).');
  const pdfPath = isAbsolute(payload.pdf) ? payload.pdf : resolve(payloadDir, payload.pdf);
  if (!existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);

  // -------- dry run: no network, no contact creation --------
  if (args.dryRun) {
    const voucher = buildRevenueVoucher(input);
    printSummary({
      voucher,
      event,
      pdfPath,
      customerLabel: useCollective ? 'Sammelkontakt (collective)' : `${input.customerName}  (will find/create contact)`,
      paymentDate: input.paymentDate,
      voucherStatus: input.voucherStatus,
    });
    console.log('Dry run — nothing sent. Full API payload:\n');
    console.log(JSON.stringify(voucher, null, 2));
    if (payload.paidPrivately) warnPaidPrivately();
    return;
  }

  // -------- live run --------
  assertApiKey();

  let contactId;
  let customerLabel;
  if (useCollective) {
    customerLabel = 'Sammelkontakt (collective)';
  } else {
    console.log(`→ Ensuring customer contact "${input.customerName}"…`);
    contactId = await client.ensureCustomerContact(input.customerName);
    customerLabel = `${input.customerName}  (${contactId})`;
  }

  const voucher = buildRevenueVoucher({ ...input, contactId });
  printSummary({
    voucher,
    event,
    pdfPath,
    customerLabel,
    paymentDate: input.paymentDate,
    voucherStatus: input.voucherStatus,
  });

  console.log('→ Creating voucher…');
  const created = await client.createVoucher(voucher);
  console.log(`✓ Voucher created: ${created.id}`);

  console.log('→ Uploading PDF…');
  await client.uploadVoucherFile(created.id, pdfPath);
  console.log('✓ PDF attached.');

  if (payload.paidPrivately) warnPaidPrivately();

  console.log(`\nDone. Open it in Lexware Office:`);
  console.log(`  https://app.lexware.de/permalink/vouchers/view/${created.id}`);
}

function safeCatalog(path) {
  const p = path || './data/events.json';
  return existsSync(resolve(p)) ? loadEventCatalog(p) : {};
}

function warnPaidPrivately() {
  console.log(
    '\n⚠ Note: "Betrag wurde bereits privat bezahlt" cannot be set via the public API.\n' +
      '  The voucher is created as "open". Mark it as privately paid in the Lexware UI,\n' +
      '  or leave it open and register the payment there.'
  );
}

main().catch((err) => {
  if (err instanceof LexwareApiError) {
    console.error(`\n✗ ${err.message}`);
    if (err.body && err.body.IssueList) {
      for (const issue of err.body.IssueList) {
        console.error(`   • ${issue.type ?? ''} ${issue.source ?? ''}: ${issue.i18nKey ?? ''}`);
      }
    }
  } else {
    console.error(`\n✗ ${err.message}`);
  }
  process.exit(1);
});
