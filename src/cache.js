import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tiny JSON file cache under ./cache (gitignored). Used to avoid re-hitting the
 * myPOS servers for device names and historical transactions on every pull.
 */
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cache');
try {
  mkdirSync(CACHE_DIR, { recursive: true });
} catch {
  /* ignore */
}

const safe = (name) => name.replace(/[^\w.-]+/g, '_');

export function cacheGet(name) {
  try {
    return JSON.parse(readFileSync(join(CACHE_DIR, safe(name)), 'utf8'));
  } catch {
    return null;
  }
}

export function cacheSet(name, value) {
  try {
    writeFileSync(join(CACHE_DIR, safe(name)), JSON.stringify(value));
  } catch {
    /* best-effort cache; ignore write failures */
  }
}
