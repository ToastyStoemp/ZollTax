/**
 * Per-tenant integration clients. A tenant's stored config is an { ENV_KEY: value }
 * object (store.js), so we feed it straight into the existing loadXConfig()
 * loaders — each client ends up fully defined by that one tenant's keys, with no
 * leakage from process.env or other tenants.
 *
 * Built clients are cached per tenant (they hold warm myPOS sessions / Shopify
 * tokens); invalidateTenant() drops the cache when a client edits its config.
 */

import { loadMyposConfig, MyposClient } from './mypos.js';
import { loadShopifyConfig, ShopifyClient } from './shopify.js';
import { loadSumupConfig, SumupClient } from './sumup.js';
import { ZolltoolClient, loadZolltoolConfig } from './zolltool.js';
import { getTenantConfig, groupEnabled } from './store.js';
import { GROUP_KEYS, GROUP_IDS } from './config-schema.js';

const cache = new Map(); // userId → { zoll, mypos, shopify, sumup, lexware }

export function invalidateTenant(userId) {
  cache.delete(userId);
}

export function getTenantClients(userId) {
  const hit = cache.get(userId);
  if (hit) return hit;
  const clients = buildClients(userId, getTenantConfig(userId));
  cache.set(userId, clients);
  return clients;
}

/** Env with the keys of any disabled group removed, so it's treated as unset. */
function withEnabledOnly(cfg) {
  const env = { ...cfg };
  for (const group of GROUP_IDS) {
    if (!groupEnabled(cfg, group)) for (const key of GROUP_KEYS[group]) delete env[key];
  }
  return env;
}

function buildClients(userId, cfg) {
  const env = withEnabledOnly(cfg);
  const myposCfg = loadMyposConfig(env);
  myposCfg.cacheNs = userId; // keep each tenant's myPOS file cache separate
  return {
    zoll: new ZolltoolClient(loadZolltoolConfig(env)),
    mypos: new MyposClient(myposCfg),
    shopify: new ShopifyClient(loadShopifyConfig(env)),
    sumup: new SumupClient(loadSumupConfig(env)),
    lexware: {
      apiKey: env.LEXWARE_API_KEY || '',
      apiUrl: (env.LEXWARE_API_URL || 'https://api.lexoffice.io/v1').replace(/\/+$/, ''),
      feeCategory: env.LEXWARE_FEE_CATEGORY || '',
    },
    // Invoice-scanning (Claude). `configured` gates the feature; daily caps are
    // tenant-tunable, operational knobs (token/pdf/timeout) keep fixed defaults.
    ai: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.ZOLLTAX_AI_MODEL || 'claude-haiku-4-5',
      dailyCalls: Number(env.ZOLLTAX_AI_DAILY_CALLS) || 100,
      dailyTokens: Number(env.ZOLLTAX_AI_DAILY_TOKENS) || 2_000_000,
      maxTokens: 1024,
      maxPdfBytes: 5 * 1024 * 1024,
      timeoutMs: 25_000,
      get configured() { return !!this.apiKey; },
    },
  };
}
