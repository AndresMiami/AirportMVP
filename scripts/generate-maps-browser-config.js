'use strict';

const fs = require('fs');
const path = require('path');

const BROWSER_KEY_RE = /^AIza[0-9A-Za-z_-]{20,200}$/;
const REQUIRED_CONTEXTS = new Set(['production', 'deploy-preview', 'branch-deploy']);

function generateMapsBrowserConfig({ env = process.env, outputPath } = {}) {
  const context = String(env.CONTEXT || 'dev').trim();
  const rawKey = String(env.GOOGLE_MAPS_BROWSER_API_KEY || '').trim();
  const apiKey = BROWSER_KEY_RE.test(rawKey) ? rawKey : null;

  if (REQUIRED_CONTEXTS.has(context) && !apiKey) {
    throw new Error(
      `GOOGLE_MAPS_BROWSER_API_KEY is missing or invalid for Netlify context ${context}`
    );
  }

  const target = outputPath || path.join(__dirname, '..', 'maps-browser-config.js');
  const source = [
    '// Generated at deploy time. Public browser credential; protect it in GCP.',
    `window.LINKMIA_MAPS_CONFIG = Object.freeze({ apiKey: ${JSON.stringify(apiKey)} });`,
    ''
  ].join('\n');
  fs.writeFileSync(target, source, { encoding: 'utf8', mode: 0o644 });
  return Object.freeze({ context, configured: Boolean(apiKey), outputPath: target });
}

if (require.main === module) {
  try {
    const result = generateMapsBrowserConfig();
    console.log(`Maps browser config generated for ${result.context}: ${result.configured ? 'configured' : 'disabled'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { BROWSER_KEY_RE, REQUIRED_CONTEXTS, generateMapsBrowserConfig };
