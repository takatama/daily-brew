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

const KEY_PREFIX = 'daily-brew';
const GEMINI_MODEL = 'gemini-2.5-flash-lite';

// PR・プレスリリース系など自己PRが主体のソースを除外
const BLOCKED_SOURCES = [
  'PR TIMES',
  'PRtimes',
  'prtimes',
  'Business Wire',
  'PR Newswire',
  'GlobeNewswire',
  'EIN Presswire',
  'atpress',
  'newscast',
];

const RSS_URLS: Record<Lang, string> = {
  ja: 'https://news.google.com/rss/search?q=%E3%83%8F%E3%83%B3%E3%83%89%E3%83%89%E3%83%AA%E3%83%83%E3%83%97+OR+%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%E6%8A%BD%E5%87%BA+OR+%E3%82%A8%E3%82%B9%E3%83%97%E3%83%AC%E3%83%83%E3%82%BD%E3%83%9E%E3%82%B7%E3%83%B3+OR+%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%E3%82%B0%E3%83%A9%E3%82%A4%E3%83%B3%E3%83%80%E3%83%BC+OR+%E3%83%9B%E3%83%BC%E3%83%A0%E3%83%AD%E3%83%BC%E3%82%B9%E3%83%86%E3%82%A3%E3%83%B3%E3%82%B0&hl=ja&gl=JP&ceid=JP:ja',
  en: 'https://news.google.com/rss/search?q=home+coffee+brewing+OR+pour+over+coffee+OR+espresso+machine+home+OR+coffee+grinder&hl=en&gl=US&ceid=US:en',
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
  if (current?.item) {
    return jsonResponse(current, 200);
  }
  return new Response(null, { status: 204 });
}

async function refreshLanguageNews(lang: Lang, env: Env): Promise<void> {
  const raw = await fetchRssItems(lang, 20);
  const deduped = deduplicateByTitle(raw).slice(0, 5);

  if (deduped.length === 0) {
    console.log(`[daily-brew] skipped ${lang}: no RSS items after dedup`);
    return;
  }

  const items = await generateSummaries(lang, deduped, env);

  if (items.length === 0) {
    console.log(`[daily-brew] skipped ${lang}: Gemini returned no items`);
    return;
  }

  const picked = items[0];
  await env.KV_DAILY_BREW.put(
    kvKey('current', lang),
    JSON.stringify({
      lang,
      generatedAt: new Date().toISOString(),
      item: picked,
    }),
  );

  console.log(`[daily-brew] updated ${lang}: ${picked.title}`);
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

  // Extract <item> blocks
  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(
    0,
    count,
  );

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

async function generateSummaries(
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
      ? `以下のコーヒーニュースのタイトル一覧を見て、各記事の short_title と summary を生成してください。

タイトル一覧:
${titlesJson}

条件:
- short_title: 20〜30文字の日本語タイトル（記事の核心を簡潔に）
- summary: 80〜120文字の日本語説明文（記事の内容を推測して自然な文章で）
- 厳格なJSONのみ返す（マークダウン・前後説明禁止）

JSON形式:
{
  "items": [
    { "index": 0, "short_title": "...", "summary": "..." }
  ]
}`
      : `Given the following coffee news titles, generate a short_title and summary for each article.

Titles:
${titlesJson}

Requirements:
- short_title: 40-60 character concise title capturing the article's essence
- summary: 80-120 character description of what the article likely covers
- Return strict JSON only (no markdown, no extra text)

JSON format:
{
  "items": [
    { "index": 0, "short_title": "...", "summary": "..." }
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
    items?: Array<{ index: number; short_title?: string; summary?: string }>;
  }>(text);

  if (!parsed?.items) return [];

  return parsed.items
    .map((result) => {
      const rss = items[result.index];
      if (!rss) return null;
      const short_title = result.short_title?.trim();
      const summary = result.summary?.trim();
      if (!short_title || !summary) return null;

      return {
        id: hashString(normalizeUrl(rss.url) || rss.title),
        title: rss.title,
        short_title,
        summary,
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
