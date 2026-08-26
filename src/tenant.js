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
import { getTenantConfig } from './store.js';

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

function buildClients(userId, env) {
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
  };
}
