interface Env {
  KV_DAILY_BREW: KVNamespace;
  AI: Ai;
  ALLOWED_ORIGIN: string;
  NEWS_ITEMS_PER_LANG?: string;
  PICK_HISTORY_SIZE?: string;
  CRON_LANGS?: string;
}

type Lang = 'ja' | 'en';

type NewsItem = {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: string | null;
  generatedAt: string;
};

type CurrentPayload = {
  lang: Lang;
  generatedAt: string;
  item: NewsItem;
};

type FeedEntry = {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  content: string;
};

const KEY_PREFIX = 'daily-brew';
const DEFAULT_ITEMS_PER_LANG = 8;
const DEFAULT_HISTORY_SIZE = 5;
const MAX_CANDIDATE_MULTIPLIER = 3;
const SUMMARY_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const RSS_FEEDS: Record<Lang, string[]> = {
  ja: [
    'https://prtimes.jp/topics/keywords/%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC/rss',
    'https://news.yahoo.co.jp/rss/topics/top-picks.xml',
  ],
  en: [
    'https://sprudge.com/feed',
    'https://dailycoffeenews.com/feed/',
  ],
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return buildCorsResponse(
        new Response(null, { status: 204 }),
        request,
        env,
      );
    }

    if (request.method === 'GET' && url.pathname === '/news') {
      const lang = normalizeLang(url.searchParams.get('lang'));
      const response = await handleGetNews(lang, env, ctx);
      return buildCorsResponse(response, request, env);
    }

    return buildCorsResponse(
      jsonResponse({ error: 'Not Found' }, 404),
      request,
      env,
    );
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const langs = parseCronLangs(env.CRON_LANGS);
    for (const lang of langs) {
      try {
        await refreshLanguageNews(lang, env);
      } catch (error) {
        console.error(
          `[daily-brew] scheduled refresh failed for ${lang}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  },
};

async function handleGetNews(
  lang: Lang,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const currentKey = kvKey('current', lang);
  const current = await env.KV_DAILY_BREW.get<CurrentPayload>(currentKey, 'json');
  if (current?.item) {
    return jsonResponse(current, 200);
  }

  const candidates = await getCandidates(lang, env);
  if (candidates.length === 0) {
    return new Response(null, { status: 204 });
  }

  const history = await getHistory(lang, env);
  const picked = selectNextCandidate(candidates, history, getHistorySize(env));
  if (!picked) {
    return new Response(null, { status: 204 });
  }

  const payload: CurrentPayload = {
    lang,
    generatedAt: new Date().toISOString(),
    item: picked,
  };

  await env.KV_DAILY_BREW.put(currentKey, JSON.stringify(payload));
  const updatedHistory = updateHistory(history, picked, getHistorySize(env));
  await env.KV_DAILY_BREW.put(kvKey('history', lang), JSON.stringify(updatedHistory));

  return jsonResponse(payload, 200);
}

async function refreshLanguageNews(lang: Lang, env: Env): Promise<void> {
  const generated = await generateCandidatesFromRss(lang, env);

  if (!generated || generated.length === 0) {
    console.log(`[daily-brew] skipped updating ${lang}: RSS returned no candidates`);
    return;
  }

  const merged = await mergeAndStoreCandidates(lang, generated, env);
  const history = await getHistory(lang, env);
  const picked = selectNextCandidate(merged, history, getHistorySize(env));

  if (!picked) {
    console.log(
      `[daily-brew] skipped updating ${lang}: no selectable candidate`,
    );
    return;
  }

  const currentPayload: CurrentPayload = {
    lang,
    generatedAt: new Date().toISOString(),
    item: picked,
  };

  await env.KV_DAILY_BREW.put(kvKey('current', lang), JSON.stringify(currentPayload));
  const updatedHistory = updateHistory(history, picked, getHistorySize(env));
  await env.KV_DAILY_BREW.put(kvKey('history', lang), JSON.stringify(updatedHistory));
}

async function generateCandidatesFromRss(
  lang: Lang,
  env: Env,
): Promise<NewsItem[]> {
  const itemCount = getItemsPerLang(env);
  const maxCandidates = itemCount * MAX_CANDIDATE_MULTIPLIER;

  const entries = await collectRssEntries(lang);
  const nowIso = new Date().toISOString();

  const uniqueEntries = dedupeFeedEntries(entries).slice(0, maxCandidates);
  const items: NewsItem[] = [];

  for (const entry of uniqueEntries) {
    const summary = await summarizeEntry(entry, lang, env);
    const item = sanitizeNewsItem(
      {
        title: entry.title,
        summary,
        url: entry.url,
        source: entry.source,
        publishedAt: entry.publishedAt,
      },
      nowIso,
    );
    if (item) {
      items.push(item);
    }
  }

  return items.slice(0, maxCandidates);
}

async function collectRssEntries(lang: Lang): Promise<FeedEntry[]> {
  const feeds = RSS_FEEDS[lang] ?? [];
  const allEntries: FeedEntry[] = [];

  for (const feedUrl of feeds) {
    try {
      const response = await fetch(feedUrl, {
        headers: {
          'User-Agent': 'daily-brew-worker/1.0',
          Accept: 'application/rss+xml, application/atom+xml, text/xml',
        },
      });

      if (!response.ok) {
        console.warn(`[daily-brew] RSS fetch failed: ${feedUrl} (${response.status})`);
        continue;
      }

      const xml = await response.text();
      const source = new URL(feedUrl).hostname;
      allEntries.push(...parseRssOrAtom(xml, source));
    } catch (error) {
      console.warn(
        `[daily-brew] RSS fetch error: ${feedUrl}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return allEntries;
}

function parseRssOrAtom(xml: string, defaultSource: string): FeedEntry[] {
  const normalized = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const rssItems = extractBlocks(normalized, 'item').map((block) =>
    parseRssItem(block, defaultSource),
  );
  const atomEntries = extractBlocks(normalized, 'entry').map((block) =>
    parseAtomEntry(block, defaultSource),
  );

  return [...rssItems, ...atomEntries].filter(
    (entry): entry is FeedEntry => entry !== null,
  );
}

function extractBlocks(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi');
  return xml.match(regex) ?? [];
}

function parseRssItem(block: string, defaultSource: string): FeedEntry | null {
  const title = decodeHtml(stripTags(getTagContent(block, 'title'))).trim();
  const url = decodeHtml(stripTags(getTagContent(block, 'link'))).trim();
  const description = decodeHtml(
    stripTags(
      getTagContent(block, 'description') || getTagContent(block, 'content:encoded'),
    ),
  ).trim();
  const source =
    decodeHtml(stripTags(getTagContent(block, 'source'))).trim() || defaultSource;
  const publishedAt = toIsoDate(getTagContent(block, 'pubDate'));

  if (!title || !url) {
    return null;
  }

  return {
    title,
    url,
    source,
    publishedAt,
    content: description || title,
  };
}

function parseAtomEntry(block: string, defaultSource: string): FeedEntry | null {
  const title = decodeHtml(stripTags(getTagContent(block, 'title'))).trim();
  const href = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] ?? '';
  const url = decodeHtml(href.trim());
  const summary = decodeHtml(
    stripTags(getTagContent(block, 'summary') || getTagContent(block, 'content')),
  ).trim();
  const source = defaultSource;
  const publishedAt = toIsoDate(
    getTagContent(block, 'updated') || getTagContent(block, 'published'),
  );

  if (!title || !url) {
    return null;
  }

  return {
    title,
    url,
    source,
    publishedAt,
    content: summary || title,
  };
}

function getTagContent(block: string, tagName: string): string {
  const escapedTag = tagName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, 'i');
  return block.match(regex)?.[1] ?? '';
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, ' ');
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function toIsoDate(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function dedupeFeedEntries(entries: FeedEntry[]): FeedEntry[] {
  const merged = new Map<string, FeedEntry>();
  for (const entry of entries) {
    const key = normalizeUrl(entry.url) || hashString(entry.title);
    if (!merged.has(key)) {
      merged.set(key, entry);
    }
  }
  return Array.from(merged.values());
}

async function summarizeEntry(entry: FeedEntry, lang: Lang, env: Env): Promise<string> {
  const fallback = fallbackSummary(entry.content, lang);

  try {
    const instruction =
      lang === 'ja'
        ? '次のニュースを日本語で100〜160文字に要約してください。URLや推測は書かず、事実のみ。'
        : 'Summarize this news item in English within 100-160 characters. No URL, no speculation, facts only.';

    const result = await env.AI.run(SUMMARY_MODEL, {
      messages: [
        { role: 'system', content: instruction },
        {
          role: 'user',
          content: `Title: ${entry.title}\nSource: ${entry.source}\nContent: ${entry.content}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 180,
    });

    const responseText =
      typeof result === 'object' && result && 'response' in result
        ? String((result as { response?: string }).response ?? '')
        : '';

    const summary = responseText.trim();
    return summary ? summary.slice(0, 220) : fallback;
  } catch (error) {
    console.warn(
      `[daily-brew] AI summary failed for ${entry.url}`,
      error instanceof Error ? error.message : String(error),
    );
    return fallback;
  }
}

function fallbackSummary(content: string, lang: Lang): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) {
    return lang === 'ja'
      ? '記事本文の要約を生成できませんでした。'
      : 'Unable to generate a summary for this article.';
  }
  return text.slice(0, 180);
}

async function mergeAndStoreCandidates(
  lang: Lang,
  newItems: NewsItem[],
  env: Env,
): Promise<NewsItem[]> {
  const existing = await getCandidates(lang, env);
  const mergedMap = new Map<string, NewsItem>();

  for (const item of [...newItems, ...existing]) {
    const key = normalizeUrl(item.url) || item.id;
    if (!mergedMap.has(key)) {
      mergedMap.set(key, item);
    }
  }

  const maxCandidates = getItemsPerLang(env) * MAX_CANDIDATE_MULTIPLIER;
  const merged = Array.from(mergedMap.values()).slice(0, maxCandidates);
  await env.KV_DAILY_BREW.put(kvKey('candidates', lang), JSON.stringify(merged));
  return merged;
}

function selectNextCandidate(
  candidates: NewsItem[],
  history: NewsItem[],
  historySize: number,
): NewsItem | null {
  if (candidates.length === 0) return null;

  const strictFiltered = candidates.filter(
    (candidate) => !isBlockedByHistory(candidate, history),
  );

  if (strictFiltered.length > 0) {
    return strictFiltered[0];
  }

  const relaxedHistory = history.slice(0, Math.max(0, historySize - 1));
  const relaxedFiltered = candidates.filter(
    (candidate) => !isBlockedByHistory(candidate, relaxedHistory),
  );

  return relaxedFiltered[0] ?? candidates[0] ?? null;
}

function isBlockedByHistory(candidate: NewsItem, history: NewsItem[]): boolean {
  const cUrl = normalizeUrl(candidate.url);
  const cTitle = normalizeTitle(candidate.title);

  for (const past of history) {
    const pUrl = normalizeUrl(past.url);
    if (cUrl && pUrl && cUrl === pUrl) {
      return true;
    }

    const pTitle = normalizeTitle(past.title);
    if (!cTitle || !pTitle) continue;

    if (
      cTitle === pTitle ||
      cTitle.includes(pTitle) ||
      pTitle.includes(cTitle)
    ) {
      return true;
    }

    if (jaccardSimilarity(tokenizeTitle(cTitle), tokenizeTitle(pTitle)) > 0.6) {
      return true;
    }
  }

  return false;
}

function updateHistory(
  history: NewsItem[],
  picked: NewsItem,
  historySize: number,
): NewsItem[] {
  const filtered = history.filter(
    (item) => normalizeUrl(item.url) !== normalizeUrl(picked.url),
  );
  return [picked, ...filtered].slice(0, historySize);
}

async function getCandidates(lang: Lang, env: Env): Promise<NewsItem[]> {
  return (
    (await env.KV_DAILY_BREW.get<NewsItem[]>(kvKey('candidates', lang), 'json')) ??
    []
  );
}

async function getHistory(lang: Lang, env: Env): Promise<NewsItem[]> {
  return (
    (await env.KV_DAILY_BREW.get<NewsItem[]>(kvKey('history', lang), 'json')) ?? []
  );
}

function sanitizeNewsItem(
  item: Partial<NewsItem>,
  nowIso: string,
): NewsItem | null {
  const title = item.title?.trim();
  const summary = item.summary?.trim();
  const url = item.url?.trim();
  const source = item.source?.trim();

  if (!title || !summary || !url || !source) return null;

  const normalizedUrl = normalizeUrl(url);
  const id =
    item.id?.trim() || hashString(normalizedUrl || `${title}-${source}`);

  return {
    id,
    title,
    summary: summary.slice(0, 220),
    url,
    source,
    publishedAt: item.publishedAt ?? null,
    generatedAt: nowIso,
  };
}

function normalizeLang(value: string | null): Lang {
  return value === 'en' ? 'en' : 'ja';
}

function parseCronLangs(raw?: string): Lang[] {
  const set = new Set<Lang>();
  for (const token of (raw ?? 'ja,en').split(',')) {
    const lang = normalizeLang(token.trim() || null);
    set.add(lang);
  }
  return Array.from(set);
}

function getItemsPerLang(env: Env): number {
  const parsed = Number(env.NEWS_ITEMS_PER_LANG ?? DEFAULT_ITEMS_PER_LANG);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_ITEMS_PER_LANG;
}

function getHistorySize(env: Env): number {
  const parsed = Number(env.PICK_HISTORY_SIZE ?? DEFAULT_HISTORY_SIZE);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_HISTORY_SIZE;
}

function kvKey(type: 'candidates' | 'current' | 'history', lang: Lang): string {
  return `${KEY_PREFIX}:${type}:${lang}`;
}

function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/$/, '');
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTitle(title: string): Set<string> {
  const tokens = title.split(' ').filter((token) => token.length > 1);
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return `n_${(hash >>> 0).toString(16)}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function buildCorsResponse(
  response: Response,
  request: Request,
  env: Env,
): Response {
  const origin = request.headers.get('Origin');
  const headers = new Headers(response.headers);
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');

  if (origin && origin === env.ALLOWED_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
