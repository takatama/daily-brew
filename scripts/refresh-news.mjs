#!/usr/bin/env node
/**
 * Run the Worker's refresh pipeline against the production KV namespace.
 *
 * Usage:
 *   node scripts/refresh-news.mjs          # both ja and en
 *   node scripts/refresh-news.mjs ja       # ja only
 *   node scripts/refresh-news.mjs en       # en only
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const KV_BINDING = 'KV_DAILY_BREW';

loadDevVars();

if (!process.env.GEMINI_API_KEY) {
  console.error('Missing required environment variable: GEMINI_API_KEY');
  process.exit(1);
}

const { refreshLanguageNews } = await import('../src/index.ts');

function loadDevVars() {
  try {
    const devVars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    for (const line of devVars.split('\n')) {
      const match = line
        .trim()
        .match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]]) continue;

      const value = match[2].trim();
      const quote = value[0];
      process.env[match[1]] =
        (quote === '"' || quote === "'") && value.endsWith(quote)
          ? value.slice(1, -1)
          : value;
    }
  } catch {
    // .dev.vars is optional when the environment is already configured.
  }
}

function cleanWranglerEnv() {
  const { CLOUDFLARE_API_TOKEN: _removed, ...cleanEnv } = process.env;
  return cleanEnv;
}

function runWrangler(args, stdio = ['ignore', 'pipe', 'pipe']) {
  return execFileSync('npx', ['wrangler', ...args], {
    env: cleanWranglerEnv(),
    encoding: 'utf8',
    stdio,
  });
}

const remoteKv = {
  async get(key, typeOrOptions) {
    const value = runWrangler([
      'kv',
      'key',
      'get',
      '--binding',
      KV_BINDING,
      '--remote',
      '--text',
      key,
    ]).trim();

    if (!value) return null;
    const type =
      typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
    return type === 'json' ? JSON.parse(value) : value;
  },

  async put(key, value) {
    runWrangler(
      [
        'kv',
        'key',
        'put',
        '--binding',
        KV_BINDING,
        '--remote',
        key,
        value,
      ],
      'inherit',
    );
  },
};

const requestedLang = process.argv[2];
const langs = requestedLang === 'ja'
  ? ['ja']
  : requestedLang === 'en'
    ? ['en']
    : ['ja', 'en'];

const env = {
  KV_DAILY_BREW: remoteKv,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ALLOWED_ORIGIN: '',
};

for (const lang of langs) {
  console.log(`[${lang}] running Worker refresh pipeline...`);
  await refreshLanguageNews(lang, env);

  const status = await remoteKv.get(`daily-brew:status:${lang}`, 'json');
  console.log(
    `[${lang}] ${status.result}: ${status.counts.published} items published`,
  );
  if (status.result === 'error' || status.result === 'rss_failed') {
    process.exitCode = 1;
  }
}
