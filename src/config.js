import './load-env.js'; // loads .env into process.env (shared with the web server)

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
