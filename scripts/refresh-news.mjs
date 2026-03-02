#!/usr/bin/env node
/**
 * Fetch RSS → deduplicate → generate short_titles via Gemini → write to KV
 *
 * Usage:
 *   node scripts/refresh-news.mjs          # both ja and en
 *   node scripts/refresh-news.mjs ja       # ja only
 *   node scripts/refresh-news.mjs en       # en only
 *
 * Required env vars:
 *   GEMINI_API_KEY
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID
 */

// Load .dev.vars automatically (same file used by wrangler dev)
try {
  const { readFileSync } = await import('fs');
  const devVars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  for (const line of devVars.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* .dev.vars is optional */ }

const KV_NAMESPACE_ID = 'c9e10bdcf21e416f95b9d7e8eed8f919';
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const KEY_PREFIX = 'daily-brew';

const BLOCKED_SOURCES = [
  'PR TIMES', 'PRtimes', 'prtimes',
  'アットプレス', 'atpress', 'newscast',
  'Business Wire', 'PR Newswire', 'GlobeNewswire', 'EIN Presswire',
  '新聞', 'タウン情報', 'ジャーナル',
];

const RSS_URLS = {
  ja: 'https://news.google.com/rss/search?q=(%E3%83%8F%E3%83%B3%E3%83%89%E3%83%89%E3%83%AA%E3%83%83%E3%83%97%20OR%20%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%E6%8A%BD%E5%87%BA%20OR%20%E3%82%B9%E3%83%9A%E3%82%B7%E3%83%A3%E3%83%AB%E3%83%86%E3%82%A3%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%20OR%20%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%E7%84%99%E7%85%8E%20OR%20%E3%83%90%E3%83%AA%E3%82%B9%E3%82%BF)%20-site%3Aprtimes.jp%20-site%3Aatpress.ne.jp%20-site%3Anewscast.co.jp%20-site%3Akeizaishimbun.co.jp&hl=ja&gl=JP&ceid=JP:ja',
  en: 'https://news.google.com/rss/search?q=(pour%20over%20coffee%20OR%20home%20espresso%20OR%20specialty%20coffee%20OR%20coffee%20roasting%20OR%20barista)%20-site%3Abusinesswire.com%20-site%3Aprnewswire.com%20-site%3Aglobenewswire.com&hl=en&gl=US&ceid=US:en',
};

// ── XML helpers ───────────────────────────────────────────────────────────────

function extractTag(block, tag) {
  const cdata = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`));
  if (cdata) return cdata[1].trim();
  const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return plain ? plain[1].trim() : '';
}

function extractAttr(block, tag, attr) {
  const m = block.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"[^>]*>`));
  return m ? m[1].trim() : '';
}

// ── Dedup helpers ─────────────────────────────────────────────────────────────

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(title) {
  return new Set(title.split(' ').filter(t => t.length > 1));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / new Set([...a, ...b]).size;
}

function hashString(input) {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = (h * 33) ^ input.charCodeAt(i);
  return `n_${(h >>> 0).toString(16)}`;
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function fetchRssItems(lang, count) {
  const res = await fetch(RSS_URLS[lang], { headers: { 'User-Agent': 'daily-brew/refresh-news' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

  return blocks
    .map(([, block]) => {
      const title   = extractTag(block, 'title');
      const url     = extractTag(block, 'link');
      const source  = extractTag(block, 'source') || extractAttr(block, 'source', 'url');
      const pubDate = extractTag(block, 'pubDate');
      const publishedAt = pubDate ? (isNaN(new Date(pubDate).getTime()) ? null : new Date(pubDate).toISOString()) : null;
      return { title, url, source, publishedAt };
    })
    .filter(item =>
      item.title &&
      item.url &&
      !BLOCKED_SOURCES.some(b => item.source.toLowerCase().includes(b.toLowerCase()))
    )
    .slice(0, count);
}

function deduplicateByTitle(items) {
  const result = [];
  for (const item of items) {
    const tokens = tokenize(normalizeTitle(item.title));
    if (!result.some(kept => jaccard(tokens, tokenize(normalizeTitle(kept.title))) > 0.6)) {
      result.push(item);
    }
  }
  return result;
}

async function generateShortTitles(lang, items) {
  const titlesJson = JSON.stringify(items.map((item, i) => ({ index: i, title: item.title })));
  const prompt = lang === 'ja'
    ? `以下のコーヒーニュースのタイトル一覧を見て、各記事の short_title を生成してください。\n\nタイトル一覧:\n${titlesJson}\n\n条件:\n- short_title: 20〜30文字の日本語タイトル（記事の核心を簡潔に）\n- 厳格なJSONのみ返す（マークダウン・前後説明禁止）\n\nJSON形式:\n{\n  "items": [\n    { "index": 0, "short_title": "..." }\n  ]\n}`
    : `Given the following coffee news titles, generate a short_title for each article.\n\nTitles:\n${titlesJson}\n\nRequirements:\n- short_title: 40-60 character concise title capturing the article's essence\n- Return strict JSON only (no markdown, no extra text)\n\nJSON format:\n{\n  "items": [\n    { "index": 0, "short_title": "..." }\n  ]\n}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API failed: ${res.status}`);

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  if (!text) return [];

  let parsed;
  try { parsed = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
  if (!parsed?.items) return [];

  const nowIso = new Date().toISOString();
  return parsed.items
    .map(result => {
      const rss = items[result.index];
      if (!rss) return null;
      const short_title = result.short_title?.trim();
      if (!short_title) return null;
      return {
        id: hashString(rss.url.trim().toLowerCase().replace(/\/$/, '') || rss.title),
        title: rss.title,
        short_title,
        url: rss.url,
        source: rss.source,
        publishedAt: rss.publishedAt,
        generatedAt: nowIso,
      };
    })
    .filter(Boolean);
}

async function writeToKV(lang, items) {
  const key = `${KEY_PREFIX}:current:${lang}`;
  const value = JSON.stringify({ lang, generatedAt: new Date().toISOString(), items });
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } = process.env;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'text/plain' },
      body: value,
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`KV write failed: ${res.status} ${err}`);
  }
}

async function refresh(lang) {
  console.log(`[${lang}] fetching RSS...`);
  const raw = await fetchRssItems(lang, 20);
  const deduped = deduplicateByTitle(raw).slice(0, 5);
  if (deduped.length === 0) { console.log(`[${lang}] no items after dedup, skipped`); return; }

  console.log(`[${lang}] generating short_titles for ${deduped.length} items...`);
  const items = await generateShortTitles(lang, deduped);
  if (items.length === 0) { console.log(`[${lang}] Gemini returned no items, skipped`); return; }

  console.log(`[${lang}] writing ${items.length} items to KV...`);
  await writeToKV(lang, items);
  console.log(`[${lang}] done: ${items.map(i => i.short_title).join(' / ')}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const langs = process.argv[2] === 'ja' ? ['ja'] : process.argv[2] === 'en' ? ['en'] : ['ja', 'en'];

for (const lang of langs) {
  try {
    await refresh(lang);
  } catch (err) {
    console.error(`[${lang}] failed:`, err.message);
    process.exit(1);
  }
}
