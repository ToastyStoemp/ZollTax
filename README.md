# Accounting bridge (myPOS · ZollTool · Lexware)

Two things live here:

1. **Web app** (`npm run web`) — the convention **payment-cluster** tool: upload
   myPOS transaction exports / statements, Shopify, and Wise files; it clusters
   transactions into conventions, matches each cluster to a **ZollTool event**,
   **verifies** the totals against the live **myPOS Banking API**, and books the
   report into **Lexware** — revenue per event (online sales monthly), fees as one
   monthly voucher. UI in `public/index.html`, backend in `src/server.js`.
2. **CLI** (`node src/index.js`) — the original one-off "book a revenue PDF from a
   `payload.json`" tool (documented below).

No runtime dependencies (Node's built-in `fetch`/`http`/`FormData`; the web UI
loads SheetJS + jsPDF from a CDN). Requires **Node 18+** (built on Node 24).

## Web app

```bash
cp .env.example .env      # fill in ZOLLTOOL_*, MYPOS_*, LEXWARE_API_KEY
npm run web               # → http://localhost:4000
```

| Env | Purpose |
|-----|---------|
| `PORT` | Web server port (default 4000). |
| `LEXWARE_API_KEY` | Book vouchers (revenue + fees). |
| `LEXWARE_FEE_CATEGORY` | Expense account UUID for the monthly fees voucher. |
| `ZOLLTOOL_URL` / `ZOLLTOOL_EMAIL` / `ZOLLTOOL_PASSWORD` | ZollTool read-API login (a dedicated account). |
| `MYPOS_*` | myPOS Banking API gateway creds (Partner Portal). Unset → mock verify data. |

Flow: **upload** payment files → clusters render → **match** each to a ZollTool
event (auto-suggested by overlapping dates) → **Verify vs myPOS** (badge) → **Book
revenue to Lexware** per cluster / **Book fees** per month. Booking previews a
dry-run and asks before it writes.

## CLI (`payload.json` → Lexware)

Small tool to book a **revenue PDF** into Lexware Office via the public API. You
describe a **point-of-sale event** and the amount in one `payload.json`; it
creates an income voucher (Beleg, type `salesinvoice`), attaches the PDF, and
links the customer contact.

## Setup

```bash
cp .env.example .env      # then edit .env → LEXWARE_API_KEY=...
node src/index.js --check # verify the key works
```

Generate the API key at <https://app.lexware.de/addons/public-api>.

## Usage

```bash
node src/index.js [payload.json] [--dry-run]
```

Preview first (no network, nothing created):

```bash
node src/index.js payload.json --dry-run
```

Book it for real (drops `--dry-run`):

```bash
node src/index.js payload.json
```

## The payload file

Everything for one booking lives in one JSON file (default `./payload.json`):

```json
{
  "pdf": "./data/example.pdf",
  "voucherNumber": "PN_2026_08_001_P",
  "totalGrossAmount": 2700.00,
  "taxType": "gross",
  "customer": "contact",
  "voucherStatus": "open",
  "paidPrivately": true,

  "event": {
    "name": "Aninite",
    "country": "Austria",
    "startDate": "2026-08-07",
    "endDate": "2026-08-09",
    "vatRate": 0
  }
}
```

| Field | Meaning |
|-------|---------|
| `pdf` | Path to the revenue PDF, **relative to the payload file**. |
| `voucherNumber` | The Belegnummer. |
| `totalGrossAmount` | Total amount incl. tax (when `taxType` is `gross`). |
| `taxType` | `gross` (amounts include VAT, default) or `net`. |
| `category` | Booking category: `einnahmen` (default), `warenverkaeufe`, `dienstleistung`, or a raw UUID. |
| `customer` | `contact` → find/create a "Revenue - {name}" customer; `collective` → use the Sammelkontakt. |
| `voucherStatus` | `open` (default) or `draft`. |
| `paidPrivately` | Informational — prints a note (see limitation below). |
| `event` | The event object, **or** a string id resolved from `data/events.json`. |

Instead of an inline `event`, reference one from the catalog:

```json
{ "pdf": "./data/example.pdf", "voucherNumber": "PN_2026_08_001_P",
  "totalGrossAmount": 2700.00, "event": "aninite" }
```

## The Event structure

An event is one convention / point-of-sale run. Store reusable ones in
[`data/events.json`](data/events.json):

```json
{
  "aninite": {
    "name": "Aninite",
    "country": "Austria",
    "startDate": "2026-08-07",
    "endDate": "2026-08-09",
    "vatRate": 0
  }
}
```

| Event field | Type | Used for |
|-------------|------|----------|
| `name` | string | Customer name + description |
| `country` | string | Description |
| `startDate` | `YYYY-MM-DD` | **Belegdatum** + payment date |
| `endDate` | `YYYY-MM-DD` | **Fälligkeitsdatum** |
| `vatRate` | number | **Steuer** (0 shows as "Keine") |

### How the event maps to the voucher (the screenshot)

| Lexware UI field | Value | Source |
|------------------|-------|--------|
| Kunde | `Revenue - Aninite` | `Revenue - {event.name}` (contact) |
| Belegtyp | Einnahme | fixed (`salesinvoice`) |
| Belegnummer | `PN_2026_08_001_P` | `voucherNumber` |
| Belegdatum | 07.08.2026 | `event.startDate` |
| Fälligkeitsdatum | 09.08.2026 | `event.endDate` |
| Beschreibung | `Point of Sales - Aninite - Austria` | `Point of Sales - {name} - {country}` |
| Kategorie | Einnahmen | `payload.category` (default `einnahmen`) |
| Steuer | Keine | `event.vatRate` (0) |
| Gesamtbetrag | 2.700,00 € | `totalGrossAmount` |
| Belegstatus | Betrag wurde bereits privat bezahlt | see limitation below |

### Booking category (Kategorie)

lexoffice shows the account name for whatever category UUID you send — it does
**not** have an AI that "changes" your choice. The public API exposes only this
fixed set for revenue:

| `category` value | lexoffice name | UUID |
|------------------|----------------|------|
| `einnahmen` (default) | Einnahmen | `8f8664a1-…` |
| `warenverkaeufe` | Warenverkäufe (goods) | `8f8664a8-…` |
| `dienstleistung` | Dienstleistung (services) | `8f8664a0-…` |

If a voucher showed up as *Warenverkäufe*, it was sent with that ID — set
`"category": "einnahmen"` (or the account you want) in the payload. A raw UUID is
also accepted if you need an account outside this list.

### Splitting one PDF across VAT rates

Provide `voucherItems` instead of a single `totalGrossAmount` (the event's
`vatRate` is then ignored for the split):

```json
"voucherItems": [
  { "amount": 1500.00, "taxRatePercent": 7 },
  { "amount": 1200.00, "taxRatePercent": 19 }
]
```

## Known limitation: "Betrag wurde bereits privat bezahlt"

The public voucher API does **not** expose the payment status — `voucherStatus`
on create is limited to `open`/`draft`, and "paid privately" is registered only
in the Lexware UI. The app creates the voucher as `open` and, if
`paidPrivately: true`, prints a reminder. Mark it privately paid in the UI
afterwards (or leave it open and register the payment there).

## How it maps to the API

1. `POST /v1/contacts` (find or create the "Revenue - {name}" customer) — skipped for `collective`.
2. `POST /v1/vouchers` — creates the `salesinvoice` voucher.
3. `POST /v1/vouchers/{id}/files` — uploads the PDF (multipart, field `file`).

HTTP 429 (rate limit) responses are retried automatically with backoff.

## Project layout

```
payload.json     one booking: event + amounts + pdf
src/
  config.js      .env loader + API config
  events.js      Event structure, catalog lookup, field derivation
  voucher.js     builds & validates the voucher payload, computes tax
  lexware.js     API client (vouchers, files, contacts, profile)
  index.js       CLI entry point
data/
  events.json    reusable event catalog
  example.pdf    the sample revenue PDF
```
