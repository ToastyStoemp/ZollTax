/**
 * Side-effect module: loads the project's .env into process.env (only keys not
 * already set in the real environment, so shell/CI env always wins). Import this
 * FIRST — before any module that reads process.env at import time — e.g.
 *   import './load-env.js';
 * No dependency on the `dotenv` package.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Override the .env location (e.g. a mounted secrets file) via ZOLLTAX_ENV_FILE.
const ENV_FILE = process.env.ZOLLTAX_ENV_FILE || join(projectRoot, '.env');

/**
 * Write or update a single KEY=value line in .env (creating the file if needed),
 * and reflect it into process.env. Used by the first-run setup wizard to persist
 * the generated encryption key. Throws if the file can't be written.
 */
export function persistEnvVar(key, value) {
  let lines = [];
  try {
    lines = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  } catch {
    /* no file yet — start fresh */
  }
  const entry = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.trim().replace(/\s*=.*/, '') === key && l.includes('='));
  if (idx >= 0) lines[idx] = entry;
  else {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(entry);
  }
  writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 });
  process.env[key] = value;
}

export function loadDotEnv() {
  let raw;
  try {
    raw = readFileSync(join(projectRoot, '.env'), 'utf8');
  } catch {
    return; // no .env — rely on process.env
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();
