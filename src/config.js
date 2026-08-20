import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

/**
 * Minimal .env loader (no dependency on the `dotenv` package).
 * Only sets variables that aren't already defined in the real environment,
 * so shell/CI env always wins over the file.
 */
function loadDotEnv() {
  let raw;
  try {
    raw = readFileSync(join(projectRoot, '.env'), 'utf8');
  } catch {
    return; // no .env file — rely on process.env
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes if present
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

export const config = {
  apiKey: process.env.LEXWARE_API_KEY || '',
  apiUrl: (process.env.LEXWARE_API_URL || 'https://api.lexoffice.io/v1').replace(/\/+$/, ''),
};

export function assertApiKey() {
  if (!config.apiKey || config.apiKey === 'paste-your-api-key-here') {
    throw new Error(
      'Missing LEXWARE_API_KEY. Copy .env.example to .env and paste your API key, ' +
        'or set the LEXWARE_API_KEY environment variable.'
    );
  }
}
