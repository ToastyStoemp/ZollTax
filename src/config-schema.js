/**
 * The per-tenant configuration schema. Each field maps 1:1 to an env var name
 * the integration clients already read (loadMyposConfig, loadShopifyConfig, …),
 * so a tenant's stored config is just an { ENV_KEY: value } object we hand to
 * those loaders. `secret: true` fields are masked in the UI and never sent back
 * to the browser in cleartext.
 */
export const CONFIG_GROUPS = [
  {
    id: 'lexware',
    label: 'Lexware Office',
    hint: 'Books revenue + fee vouchers. API key from Lexware Office → Settings → Public API.',
    fields: [
      { key: 'LEXWARE_API_KEY', label: 'API key', secret: true },
      { key: 'LEXWARE_API_URL', label: 'API URL', placeholder: 'https://api.lexoffice.io/v1' },
      { key: 'LEXWARE_FEE_CATEGORY', label: 'Fee category UUID', hint: 'Expense account for the monthly myPOS fees voucher.' },
    ],
  },
  {
    id: 'zolltool',
    label: 'ZollTool',
    hint: 'Reads events + transactions to match clusters. Mint a read-only token in ZollTool → Admin → API access.',
    fields: [
      { key: 'ZOLLTOOL_URL', label: 'Server URL', placeholder: 'https://sync.example.com' },
      { key: 'ZOLLTOOL_API_TOKEN', label: 'API token (zt_…)', secret: true },
      { key: 'ZOLLTOOL_EMAIL', label: 'Email (legacy login)' },
      { key: 'ZOLLTOOL_PASSWORD', label: 'Password (legacy login)', secret: true },
    ],
  },
  {
    id: 'mypos',
    label: 'myPOS Banking API',
    hint: 'Verifies clusters against live settled data. From the myPOS Partner Portal.',
    fields: [
      { key: 'MYPOS_GATEWAY_URL', label: 'Gateway URL', placeholder: 'https://api-gateway.mypos.com' },
      { key: 'MYPOS_CLIENT_ID', label: 'Integration client ID' },
      { key: 'MYPOS_CLIENT_SECRET', label: 'Integration client secret', secret: true },
      { key: 'MYPOS_MERCHANT_CLIENT_ID', label: 'Merchant client ID' },
      { key: 'MYPOS_MERCHANT_CLIENT_SECRET', label: 'Merchant client secret', secret: true },
      { key: 'MYPOS_PARTNER_ID', label: 'Partner ID', placeholder: 'mps-p-…' },
      { key: 'MYPOS_APPLICATION_ID', label: 'Application ID', placeholder: 'mps-app-…' },
      { key: 'MYPOS_MODE', label: 'Mode', placeholder: 'live (blank = mock)' },
      { key: 'MYPOS_ACCOUNT', label: 'Default account (optional)' },
    ],
  },
  {
    id: 'shopify',
    label: 'Shopify Admin API',
    hint: 'Pulls online + Shopify POS orders. Custom app with read_orders + read_locations.',
    fields: [
      { key: 'SHOPIFY_SHOP', label: 'Shop domain', placeholder: 'mystore.myshopify.com' },
      { key: 'SHOPIFY_CLIENT_ID', label: 'Client ID' },
      { key: 'SHOPIFY_CLIENT_SECRET', label: 'Client secret', secret: true },
      { key: 'SHOPIFY_ACCESS_TOKEN', label: 'Static access token (optional)', secret: true },
      { key: 'SHOPIFY_API_VERSION', label: 'API version', placeholder: '2024-10' },
      { key: 'SHOPIFY_MODE', label: 'Mode', placeholder: 'live (blank = mock)' },
    ],
  },
  {
    id: 'sumup',
    label: 'SumUp API',
    hint: 'Pulls POS/online transactions. API key with transactions.history.',
    fields: [
      { key: 'SUMUP_API_KEY', label: 'API key', secret: true },
      { key: 'SUMUP_MERCHANT_CODE', label: 'Merchant code' },
      { key: 'SUMUP_API_URL', label: 'API URL', placeholder: 'https://api.sumup.com' },
      { key: 'SUMUP_MODE', label: 'Mode', placeholder: 'live (blank = mock)' },
    ],
  },
];

/** Flat list of every valid config key. */
export const CONFIG_KEYS = CONFIG_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

/** Set of keys that must never be echoed back to the browser. */
export const SECRET_KEYS = new Set(
  CONFIG_GROUPS.flatMap((g) => g.fields.filter((f) => f.secret).map((f) => f.key)),
);

/**
 * The browser-safe view of a tenant config: real values for non-secret keys,
 * and a boolean `<KEY>__set` marker for every secret so the UI can show
 * "saved / not set" without leaking the secret itself.
 */
export function redactConfig(cfg) {
  const out = {};
  for (const key of CONFIG_KEYS) {
    if (SECRET_KEYS.has(key)) out[`${key}__set`] = !!cfg[key];
    else out[key] = cfg[key] ?? '';
  }
  return out;
}
