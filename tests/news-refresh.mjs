import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const worker = await import(modUrl);

class KV {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  async get(key, type) {
    const value = this.map.get(key);
    if (value == null) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.map.set(key, value); }
}

function env(entries = {}) {
  return { KV_DAILY_BREW: new KV(entries), GEMINI_API_KEY: 'test', ALLOWED_ORIGIN: '' };
}
function ctx() {
  const tasks = [];
  return { tasks, waitUntil(p) { tasks.push(p); } };
}
function current(lang, refreshedAt) {
  return JSON.stringify({ lang, generatedAt: refreshedAt, refreshedAt, items: [{ id:'1', title:'Coffee', short_title:'Coffee', url:'https://x.test', source:'Test', publishedAt: refreshedAt, generatedAt: refreshedAt }] });
}
const rssXml = `<?xml version="1.0"?><rss><channel>${Array.from({length:6},(_,i)=>`<item><title>Specialty coffee ${i}</title><link>https://e.test/${i}</link><source>Daily</source><pubDate>Fri, 24 Jul 2026 00:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
function mockPipelineFetch({ rssOk = true, retry503 = 0 } = {}) {
  let rssCalls = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('news.google.com')) {
      rssCalls++;
      if (retry503 && rssCalls <= retry503) return new Response('busy', { status: 503, headers: { server: 'test', 'content-type': 'text/plain' } });
      return rssOk ? new Response(rssXml, { status: 200 }) : new Response('<html>bad</html>', { status: 503, headers: { server: 'test', 'content-type': 'text/html' } });
    }
    if (u.includes('generativelanguage')) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: Array.from({length:5},(_,i)=>({ index:i, short_title:`Short ${i}` })) }) }] } }] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch ${u}`);
  };
  return () => rssCalls;
}

test('JST 04:59 keeps previous 05:00 news fresh; 05:00 starts a new news day', () => {
  const news = { refreshedAt: '2999-01-01T00:00:00.000Z', items: [] };
  assert.equal(worker.isNewsFresh(news, new Date('2026-07-23T19:59:00.000Z')), true);
  assert.equal(worker.isNewsFresh(news, new Date('2999-01-01T00:00:00.000Z')), true);
  assert.equal(worker.isNewsFresh({ ...news, refreshedAt: '2026-07-23T19:59:59.000Z' }, new Date('2999-01-01T00:00:00.000Z')), false);
});

test('fresh /news does not fetch RSS', async () => {
  const getCalls = mockPipelineFetch();
  const e = env({ 'daily-brew:current:ja': current('ja', '2999-01-01T00:00:00.000Z') });
  const res = await worker.default.fetch(new Request('https://api.test/news?lang=ja'), e, ctx());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Daily-Brew-State'), 'fresh');
  assert.equal(getCalls(), 0);
});

test('stale normal access returns stale and schedules background refresh', async () => {
  const getCalls = mockPipelineFetch();
  const c = ctx();
  const e = env({ 'daily-brew:current:ja': current('ja', '2020-01-01T00:00:00.000Z') });
  const res = await worker.default.fetch(new Request('https://api.test/news?lang=ja'), e, c);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Daily-Brew-State'), 'stale');
  assert.equal(c.tasks.length, 1);
  await Promise.all(c.tasks);
  assert.equal(getCalls(), 1);
});

test('stale blocking waits for refresh', async () => {
  mockPipelineFetch();
  const e = env({ 'daily-brew:current:ja': current('ja', '2020-01-01T00:00:00.000Z') });
  const res = await worker.default.fetch(new Request('https://api.test/news?lang=ja', { headers: { 'X-Daily-Brew-Warmup': 'blocking' } }), e, ctx());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Daily-Brew-State'), 'refreshed');
});

test('blocking failure returns 503 even with stale data', async () => {
  mockPipelineFetch({ rssOk: false });
  const e = env({ 'daily-brew:current:ja': current('ja', '2020-01-01T00:00:00.000Z') });
  const res = await worker.default.fetch(new Request('https://api.test/news?lang=ja', { headers: { 'X-Daily-Brew-Warmup': 'blocking' } }), e, ctx());
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('X-Daily-Brew-State'), 'refresh-failed');
});

test('normal failure returns stale data as 200; no data and failure returns 503', async () => {
  mockPipelineFetch({ rssOk: false });
  let e = env({ 'daily-brew:current:ja': current('ja', '2020-01-01T00:00:00.000Z') });
  let c = ctx();
  let res = await worker.default.fetch(new Request('https://api.test/news?lang=ja'), e, c);
  await Promise.all(c.tasks);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Daily-Brew-State'), 'stale');
  e = env();
  res = await worker.default.fetch(new Request('https://api.test/news?lang=ja'), e, ctx());
  assert.equal(res.status, 503);
});

test('503 RSS response is retried up to three times', async () => {
  const getCalls = mockPipelineFetch({ retry503: 2 });
  const e = env();
  const res = await worker.default.fetch(new Request('https://api.test/news?lang=ja'), e, ctx());
  assert.equal(res.status, 200);
  assert.equal(getCalls(), 3);
});

test('cooldown suppresses user refresh and languages remain isolated', async () => {
  const getCalls = mockPipelineFetch();
  const recentFail = JSON.stringify({ lang:'ja', runAt:'2026-07-23T19:50:00.000Z', result:'rss_failed', counts:{rssFetched:0,afterDedup:0,afterNoRepeat:0,geminiReturned:0,published:0}, lastAttemptAt: new Date().toISOString(), lastError:'RSS failed' });
  const e = env({
    'daily-brew:current:ja': current('ja', '2020-01-01T00:00:00.000Z'),
    'daily-brew:status:ja': recentFail,
    'daily-brew:current:en': current('en', '2999-01-01T00:00:00.000Z'),
  });
  const c = ctx();
  const ja = await worker.default.fetch(new Request('https://api.test/news?lang=ja'), e, c);
  const en = await worker.default.fetch(new Request('https://api.test/news?lang=en'), e, ctx());
  assert.equal(ja.headers.get('X-Daily-Brew-State'), 'stale');
  assert.equal(en.headers.get('X-Daily-Brew-State'), 'fresh');
  assert.equal(c.tasks.length, 0);
  assert.equal(getCalls(), 0);
});
