interface Env {
  KV_DAILY_BREW: KVNamespace;
  GEMINI_API_KEY: string;
  ALLOWED_ORIGIN: string;
}

type Lang = 'ja' | 'en';

type RssItem = {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
};

type NewsItem = {
  id: string;
  title: string;
  short_title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  generatedAt: string;
};

type RecentPublishedItem = {
  url: string;
  title: string;
  generatedAt: string;
};

type CurrentPayload = {
  lang: Lang;
  generatedAt: string;
  items: NewsItem[];
  recentPublished?: RecentPublishedItem[];
};

const KEY_PREFIX = 'daily-brew';
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const RSS_CANDIDATE_LIMIT = 100;
const GEMINI_CANDIDATE_LIMIT = 20;
const OUTPUT_ITEM_LIMIT = 5;
const NO_REPEAT_WINDOW_DAYS = 5;

// PR・プレスリリース系・新聞・タウン情報など編集記事でないソースを除外（クエリの -site: で弾けなかった場合の二重安全網）
const BLOCKED_SOURCES = [
  'PR TIMES',
  'PRtimes',
  'prtimes',
  'アットプレス',
  'atpress',
  'newscast',
  'Business Wire',
  'PR Newswire',
  'GlobeNewswire',
  'EIN Presswire',
  '新聞',       // 釧路新聞電子版 等の地域紙
  'タウン情報',  // あきたタウン情報 等
  'ジャーナル',  // 肥後ジャーナル 等の地域ジャーナル
  'Yahoo!フリマ',
  'paypayfleamarket.yahoo.co.jp',
];

const PRIORITY_SOURCES = [
  'note',
  'note.com',
  'gigazine',
  '家電 watch',
  'kaden.watch.impress.co.jp',
];

// クエリにコーヒー文化・技術系ワードを使い、プレスリリース・地域紙サイトを -site: で除外
const RSS_URLS: Record<Lang, string> = {
  ja: 'https://news.google.com/rss/search?q=(%E3%83%8F%E3%83%B3%E3%83%89%E3%83%89%E3%83%AA%E3%83%83%E3%83%97%20OR%20%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%E6%8A%BD%E5%87%BA%20OR%20%E3%82%B9%E3%83%9A%E3%82%B7%E3%83%A3%E3%83%AB%E3%83%86%E3%82%A3%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%20OR%20%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%E7%84%99%E7%85%8E%20OR%20%E3%83%90%E3%83%AA%E3%82%B9%E3%82%BF)%20-site%3Aprtimes.jp%20-site%3Aatpress.ne.jp%20-site%3Anewscast.co.jp%20-site%3Akeizaishimbun.co.jp%20-site%3Apaypayfleamarket.yahoo.co.jp&hl=ja&gl=JP&ceid=JP:ja',
  en: 'https://news.google.com/rss/search?q=(pour%20over%20coffee%20OR%20home%20espresso%20OR%20specialty%20coffee%20OR%20coffee%20roasting%20OR%20barista)%20-site%3Abusinesswire.com%20-site%3Aprnewswire.com%20-site%3Aglobenewswire.com&hl=en&gl=US&ceid=US:en',
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
    for (const lang of ['ja', 'en'] as Lang[]) {
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
  const current = await env.KV_DAILY_BREW.get<CurrentPayload>(
    kvKey('current', lang),
    'json',
  );
  if (current?.items?.length) {
    return jsonResponse(current, 200);
  }
  return new Response(null, { status: 204 });
}

async function refreshLanguageNews(lang: Lang, env: Env): Promise<void> {
  const current = await env.KV_DAILY_BREW.get<CurrentPayload>(
    kvKey('current', lang),
    'json',
  );
  const raw = await fetchRssItems(lang, RSS_CANDIDATE_LIMIT);
  const deduped = deduplicateByTitle(raw);
  const recentPublished = collectRecentPublishedItems(current);
  const freshItems = filterItemsAlreadyPublished(deduped, recentPublished);

  if (freshItems.length === 0) {
    console.log(`[daily-brew] skipped ${lang}: no fresh RSS items in ${NO_REPEAT_WINDOW_DAYS} days`);
    return;
  }

  const generatedItems = await generateShortTitles(
    lang,
    freshItems.slice(0, GEMINI_CANDIDATE_LIMIT),
    env,
  );
  const items = deduplicateByShortTitle(generatedItems).slice(0, OUTPUT_ITEM_LIMIT);

  if (items.length === 0) {
    console.log(`[daily-brew] skipped ${lang}: Gemini returned no items`);
    return;
  }

  const generatedAt = new Date().toISOString();
  const updatedRecentPublished = buildRecentPublishedItems(
    recentPublished,
    items,
    generatedAt,
  );

  await env.KV_DAILY_BREW.put(
    kvKey('current', lang),
    JSON.stringify({
      lang,
      generatedAt,
      items,
      recentPublished: updatedRecentPublished,
    }),
  );

  console.log(`[daily-brew] updated ${lang}: ${items.length} items`);
}

function collectRecentPublishedItems(
  current: CurrentPayload | null,
): RecentPublishedItem[] {
  if (!current) return [];

  const seeded = current.items.map((item) => ({
    url: item.url,
    title: item.title,
    generatedAt: item.generatedAt || current.generatedAt,
  }));

  return pruneRecentPublishedItems([...(current.recentPublished ?? []), ...seeded]);
}

function filterItemsAlreadyPublished(
  items: RssItem[],
  recentPublished: RecentPublishedItem[],
): RssItem[] {
  if (recentPublished.length === 0) return items;

  const previousUrls = new Set(
    recentPublished.map((item) => normalizeUrl(item.url)).filter(Boolean),
  );
  const previousTitles = new Set(
    recentPublished.map((item) => normalizeTitle(item.title)).filter(Boolean),
  );

  return items.filter((item) => {
    const normalizedUrl = normalizeUrl(item.url);
    const normalizedTitle = normalizeTitle(item.title);
    return (
      !previousUrls.has(normalizedUrl) && !previousTitles.has(normalizedTitle)
    );
  });
}

function buildRecentPublishedItems(
  previousItems: RecentPublishedItem[],
  latestItems: NewsItem[],
  generatedAt: string,
): RecentPublishedItem[] {
  const combined = [
    ...previousItems,
    ...latestItems.map((item) => ({
      url: item.url,
      title: item.title,
      generatedAt,
    })),
  ];

  return pruneRecentPublishedItems(combined);
}

function pruneRecentPublishedItems(
  items: RecentPublishedItem[],
): RecentPublishedItem[] {
  const cutoffTime = Date.now() - NO_REPEAT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();

  return items
    .filter((item) => {
      const timestamp = new Date(item.generatedAt).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoffTime;
    })
    .sort(
      (a, b) =>
        new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime(),
    )
    .filter((item) => {
      const normalizedUrl = normalizeUrl(item.url);
      const normalizedTitle = normalizeTitle(item.title);
      const fingerprint = `${normalizedUrl}::${normalizedTitle}`;
      if (!normalizedUrl && !normalizedTitle) return false;
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
}

async function fetchRssItems(lang: Lang, count: number): Promise<RssItem[]> {
  const response = await fetch(RSS_URLS[lang], {
    headers: { 'User-Agent': 'daily-brew/1.0' },
  });

  if (!response.ok) {
    console.error(
      `[daily-brew] RSS fetch failed for ${lang}: ${response.status}`,
    );
    return [];
  }

  const xml = await response.text();

  // Extract all <item> blocks; apply count cap after source filtering
  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

  function extractTag(block: string, tag: string): string {
    // Handle CDATA: <tag><![CDATA[...]]></tag>
    const cdata = block.match(
      new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`),
    );
    if (cdata) return cdata[1].trim();
    const plain = block.match(
      new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`),
    );
    return plain ? plain[1].trim() : '';
  }

  function extractAttr(block: string, tag: string, attr: string): string {
    const m = block.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"[^>]*>`));
    return m ? m[1].trim() : '';
  }

  return itemBlocks
    .map(([, block]) => {
      const title = extractTag(block, 'title');
      const link = extractTag(block, 'link');
      const source =
        extractTag(block, 'source') || extractAttr(block, 'source', 'url');
      const pubDate = extractTag(block, 'pubDate');

      let publishedAt: string | null = null;
      if (pubDate) {
        const d = new Date(pubDate);
        publishedAt = isNaN(d.getTime()) ? null : d.toISOString();
      }

      return { title, url: link, source, publishedAt };
    })
    .filter(
      (item) =>
        item.title &&
        item.url &&
        !BLOCKED_SOURCES.some((blocked) =>
          item.source.toLowerCase().includes(blocked.toLowerCase()),
        ),
    )
    .sort(
      (a, b) =>
        sourcePriorityScore(b.source) - sourcePriorityScore(a.source),
    )
    .slice(0, count);
}

function sourcePriorityScore(source: string): number {
  const normalized = source.toLowerCase();
  return PRIORITY_SOURCES.reduce(
    (score, keyword) =>
      normalized.includes(keyword.toLowerCase()) ? score + 1 : score,
    0,
  );
}

function deduplicateByTitle(items: RssItem[]): RssItem[] {
  const result: RssItem[] = [];

  for (const item of items) {
    const tokens = tokenizeTitle(normalizeTitle(item.title));
    const isDuplicate = result.some(
      (kept) =>
        jaccardSimilarity(tokens, tokenizeTitle(normalizeTitle(kept.title))) >
        0.6,
    );
    if (!isDuplicate) {
      result.push(item);
    }
  }

  return result;
}

function deduplicateByShortTitle(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const result: NewsItem[] = [];

  for (const item of items) {
    const normalizedShortTitle = normalizeTitle(item.short_title);
    if (!normalizedShortTitle || seen.has(normalizedShortTitle)) {
      continue;
    }
    seen.add(normalizedShortTitle);
    result.push(item);
  }

  return result;
}

async function generateShortTitles(
  lang: Lang,
  items: RssItem[],
  env: Env,
): Promise<NewsItem[]> {
  const nowIso = new Date().toISOString();
  const titlesJson = JSON.stringify(
    items.map((item, i) => ({ index: i, title: item.title })),
  );

  const prompt =
    lang === 'ja'
      ? `以下のコーヒーニュースのタイトル一覧を見て、各記事の short_title を生成してください。

タイトル一覧:
${titlesJson}

条件:
- short_title: 20〜30文字の日本語タイトル（記事の核心を簡潔に）
- 厳格なJSONのみ返す（マークダウン・前後説明禁止）

JSON形式:
{
  "items": [
    { "index": 0, "short_title": "..." }
  ]
}`
      : `Given the following coffee news titles, generate a short_title for each article.

Titles:
${titlesJson}

Requirements:
- short_title: 40-60 character concise title capturing the article's essence
- Return strict JSON only (no markdown, no extra text)

JSON format:
{
  "items": [
    { "index": 0, "short_title": "..." }
  ]
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.4,
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
    },
  );

  if (!response.ok) {
    console.error(
      `[daily-brew] Gemini API failed for ${lang}: ${response.status}`,
    );
    return [];
  }

  const data = await response.json<{
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  }>();

  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ??
    '';
  if (!text) return [];

  const parsed = safeParseJson<{
    items?: Array<{ index: number; short_title?: string }>;
  }>(text);

  if (!parsed?.items) return [];

  return parsed.items
    .map((result) => {
      const rss = items[result.index];
      if (!rss) return null;
      const short_title = result.short_title?.trim();
      if (!short_title) return null;

      return {
        id: hashString(normalizeUrl(rss.url) || rss.title),
        title: rss.title,
        short_title,
        url: rss.url,
        source: rss.source,
        publishedAt: rss.publishedAt,
        generatedAt: nowIso,
      } satisfies NewsItem;
    })
    .filter((item): item is NewsItem => item !== null);
}

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

function normalizeLang(value: string | null): Lang {
  return value === 'en' ? 'en' : 'ja';
}

function kvKey(type: 'current', lang: Lang): string {
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

function isAllowedOrigin(origin: string, allowed: string): boolean {
  if (origin === allowed) return true;
  try {
    const o = new URL(origin);
    const a = new URL(allowed);
    return (
      o.protocol === a.protocol &&
      (o.hostname === a.hostname || o.hostname.endsWith(`.${a.hostname}`))
    );
  } catch {
    return false;
  }
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

  if (origin && isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
