#!/usr/bin/env node
/**
 * RSS fetch & filter checker
 * Usage: node scripts/check-rss.mjs [ja|en]
 */

const BLOCKED_SOURCES = [
  'PR TIMES', 'PRtimes', 'prtimes',
  'アットプレス', 'atpress', 'newscast',
  'Business Wire', 'PR Newswire', 'GlobeNewswire', 'EIN Presswire',
  '新聞', 'タウン情報',
];

const RSS_URLS = {
  ja: 'https://news.google.com/rss/search?q=(%E3%83%8F%E3%83%B3%E3%83%89%E3%83%89%E3%83%AA%E3%83%83%E3%83%97%20OR%20%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%E6%8A%BD%E5%87%BA%20OR%20%E3%82%B9%E3%83%9A%E3%82%B7%E3%83%A3%E3%83%AB%E3%83%86%E3%82%A3%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%20OR%20%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%E7%84%99%E7%85%8E%20OR%20%E3%83%90%E3%83%AA%E3%82%B9%E3%82%BF)%20-site%3Aprtimes.jp%20-site%3Aatpress.ne.jp%20-site%3Anewscast.co.jp%20-site%3Akeizaishimbun.co.jp&hl=ja&gl=JP&ceid=JP:ja',
  en: 'https://news.google.com/rss/search?q=(pour%20over%20coffee%20OR%20home%20espresso%20OR%20specialty%20coffee%20OR%20coffee%20roasting%20OR%20barista)%20-site%3Abusinesswire.com%20-site%3Aprnewswire.com%20-site%3Aglobenewswire.com&hl=en&gl=US&ceid=US:en',
};

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

function isBlocked(source) {
  return BLOCKED_SOURCES.some(b => source.toLowerCase().includes(b.toLowerCase()));
}

const lang = process.argv[2] === 'en' ? 'en' : 'ja';
console.log(`\nFetching RSS for lang=${lang} ...\n`);

const res = await fetch(RSS_URLS[lang], { headers: { 'User-Agent': 'daily-brew/check-rss' } });
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  process.exit(1);
}

const xml = await res.text();
const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

let passed = 0, blocked = 0;
for (const [, block] of blocks) {
  const title  = extractTag(block, 'title');
  const link   = extractTag(block, 'link');
  const source = extractTag(block, 'source') || extractAttr(block, 'source', 'url');
  const pub    = extractTag(block, 'pubDate');

  if (!title || !link) continue;

  const b = isBlocked(source);
  if (b) {
    blocked++;
    console.log(`[BLOCKED] ${source}`);
    console.log(`          ${title}\n`);
  } else {
    passed++;
    console.log(`[OK] ${source}`);
    console.log(`     ${title}`);
    console.log(`     ${pub}`);
    console.log(`     ${link}\n`);
  }
}

console.log(`----`);
console.log(`Total: ${blocks.length}  OK: ${passed}  Blocked: ${blocked}`);
