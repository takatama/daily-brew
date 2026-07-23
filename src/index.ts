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

type StoredNews = {
  refreshedAt: string;
  items: NewsItem[];
};

type CurrentPayload = StoredNews & {
  lang: Lang;
  generatedAt: string;
  recentPublished?: RecentPublishedItem[];
};

type RunResult =
  | 'updated'
  | 'skipped_no_fresh'
  | 'skipped_gemini_empty'
  | 'rss_failed'
  | 'error';

type RefreshStatus = {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
};

type RunStatus = RefreshStatus & {
  lang: Lang;
  runAt: string;
  result: RunResult;
  counts: {
    rssFetched: number;
    afterDedup: number;
    afterNoRepeat: number;
    geminiReturned: number;
    published: number;
  };
  errorMessage?: string;
};

type RssFetchResult = {
  ok: boolean;
  items: RssItem[];
  errorMessage?: string;
};

type NewsState = 'fresh' | 'stale' | 'refreshed' | 'refresh-failed';

type RefreshOptions = {
  now?: Date;
  blocking?: boolean;
  ignoreCooldown?: boolean;
};

type RefreshOutcome = {
  ok: boolean;
  current: CurrentPayload | null;
  status: RunStatus;
};

const KEY_PREFIX = 'daily-brew';
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const RSS_CANDIDATE_LIMIT = 100;
const GEMINI_CANDIDATE_LIMIT = 20;
const OUTPUT_ITEM_LIMIT = 5;
const NO_REPEAT_WINDOW_DAYS = 5;
const RSS_LOOKBACK_MONTHS = 3;
const REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
const RSS_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// RSS取得後に source 名で除外するキーワード（プレスリリース配信元や個別に確認した低関連媒体の安全網）
const BLOCKED_SOURCE_KEYWORDS = [
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
  '釧路新聞',
  '秋田魁新報',
  'あきたタウン情報',
  '肥後ジャーナル',
  'Yahoo!フリマ',
  'paypayfleamarket.yahoo.co.jp',
];

const PRIORITY_SOURCES = [
  'gigazine',
  '家電 watch',
  'kaden.watch.impress.co.jp',
];

// Google News query 側での除外対象（ドメインで明確に指定できるもの）
const QUERY_EXCLUDED_SITES: Record<Lang, string[]> = {
  ja: [
    'prtimes.jp',
    'atpress.ne.jp',
    'newscast.co.jp',
    'keizaishimbun.co.jp',
    'paypayfleamarket.yahoo.co.jp',
  ],
  en: [
    'businesswire.com',
    'prnewswire.com',
    'globenewswire.com',
  ],
};

const QUERY_TOPIC_TERMS: Record<Lang, string[]> = {
  ja: ['ハンドドリップ', 'コーヒー抽出', 'スペシャルティコーヒー', 'コーヒー焙煎', 'バリスタ'],
  en: ['pour over coffee', 'home espresso', 'specialty coffee', 'coffee roasting', 'barista'],
};

function buildGoogleNewsRssUrl(lang: Lang): string {
  const topicClause = `(${QUERY_TOPIC_TERMS[lang].join(' OR ')})`;
  const excludedSitesClause = QUERY_EXCLUDED_SITES[lang]
    .map((site) => `-site:${site}`)
    .join(' ');
  const query = `${topicClause} ${excludedSitesClause}`.trim();

  const params = new URLSearchParams({
    q: query,
    hl: lang,
    gl: lang === 'ja' ? 'JP' : 'US',
    ceid: lang === 'ja' ? 'JP:ja' : 'US:en',
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

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
      const response = await handleGetNews(lang, env, ctx, request);
      return buildCorsResponse(response, request, env);
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      const response = await handleGetStatus(env);
      return buildCorsResponse(response, request, env);
    }

    return buildCorsResponse(
      jsonResponse({ error: 'Not Found' }, 404),
      request,
      env,
    );
  },

};

async function handleGetNews(
  lang: Lang,
  env: Env,
  ctx: ExecutionContext,
  request: Request,
): Promise<Response> {
  const blocking = request.headers.get('X-Daily-Brew-Warmup') === 'blocking';
  return refreshIfStale(lang, env, ctx, { blocking });
}

async function handleGetStatus(env: Env): Promise<Response> {
  const [ja, en] = await Promise.all(
    (['ja', 'en'] as Lang[]).map((lang) =>
      env.KV_DAILY_BREW.get<RunStatus>(kvKey('status', lang), 'json'),
    ),
  );

  return jsonResponse({ ja, en }, 200);
}

async function readCurrentPayload(env: Env, lang: Lang): Promise<CurrentPayload | null> {
  const value = await env.KV_DAILY_BREW.get<CurrentPayload | NewsItem[]>(
    kvKey('current', lang),
    'json',
  );
  return normalizeStoredNews(lang, value);
}

function normalizeStoredNews(
  lang: Lang,
  value: CurrentPayload | NewsItem[] | null,
): CurrentPayload | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const generatedAt = value[0]?.generatedAt ?? new Date(0).toISOString();
    return { lang, generatedAt, refreshedAt: generatedAt, items: value };
  }
  const items = Array.isArray(value.items) ? value.items : [];
  const generatedAt =
    value.generatedAt ?? value.refreshedAt ?? items[0]?.generatedAt ?? new Date(0).toISOString();
  return {
    ...value,
    lang: value.lang ?? lang,
    generatedAt,
    refreshedAt: value.refreshedAt ?? generatedAt,
    items,
  };
}

export function getJstNewsDayStart(now: Date): Date {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  const d = jst.getUTCDate();
  const hour = jst.getUTCHours();
  const newsDayStartJst = Date.UTC(y, m, hour < 5 ? d - 1 : d, 5, 0, 0, 0);
  return new Date(newsDayStartJst - 9 * 60 * 60 * 1000);
}

export function isNewsFresh(news: StoredNews | CurrentPayload, now = new Date()): boolean {
  const refreshedAt = new Date(news.refreshedAt).getTime();
  return Number.isFinite(refreshedAt) && refreshedAt >= getJstNewsDayStart(now).getTime();
}

async function shouldAttemptRefresh(env: Env, lang: Lang, now: Date): Promise<boolean> {
  return !isRefreshCoolingDown(await readRefreshStatus(env, lang), now);
}

function isRefreshCoolingDown(status: RefreshStatus | null, now: Date): boolean {
  if (!status?.lastAttemptAt || !status.lastError) return false;
  const lastAttempt = new Date(status.lastAttemptAt).getTime();
  return Number.isFinite(lastAttempt) && now.getTime() - lastAttempt < REFRESH_COOLDOWN_MS;
}

async function readRefreshStatus(env: Env, lang: Lang): Promise<RunStatus | null> {
  return env.KV_DAILY_BREW.get<RunStatus>(kvKey('status', lang), 'json');
}

function createNewsResponse(
  current: CurrentPayload | null,
  status: number,
  state: NewsState,
  errorMessage?: string,
): Response {
  const response = current?.items?.length
    ? jsonResponse(current, status)
    : jsonResponse({ error: errorMessage ?? 'News unavailable' }, status);
  response.headers.set('X-Daily-Brew-State', state);
  if (current?.refreshedAt) {
    response.headers.set('X-Daily-Brew-Refreshed-At', current.refreshedAt);
  }
  return response;
}

async function refreshIfStale(
  lang: Lang,
  env: Env,
  ctx: ExecutionContext,
  options: RefreshOptions = {},
): Promise<Response> {
  const now = options.now ?? new Date();
  const current = await readCurrentPayload(env, lang);

  if (current?.items?.length && isNewsFresh(current, now)) {
    return createNewsResponse(current, 200, 'fresh');
  }

  if (options.blocking) {
    const outcome = await refreshLanguageNews(lang, env, {
      now,
      blocking: true,
    });
    if (outcome.ok && outcome.current) {
      return createNewsResponse(outcome.current, 200, 'refreshed');
    }
    return createNewsResponse(
      current,
      503,
      'refresh-failed',
      outcome.status.errorMessage,
    );
  }

  if (current?.items?.length) {
    if (await shouldAttemptRefresh(env, lang, now)) {
      ctx.waitUntil(refreshLanguageNews(lang, env, { now }));
    }
    return createNewsResponse(current, 200, 'stale');
  }

  const outcome = await refreshLanguageNews(lang, env, {
    now,
    ignoreCooldown: true,
  });
  if (outcome.ok && outcome.current) {
    return createNewsResponse(outcome.current, 200, 'refreshed');
  }
  return createNewsResponse(null, 503, 'refresh-failed', outcome.status.errorMessage);
}

export async function refreshLanguageNews(
  lang: Lang,
  env: Env,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const runAt = new Date().toISOString();
  const counts = emptyRunCounts();
  const previousStatus = await readRefreshStatus(env, lang);

  try {
    if (
      !options.ignoreCooldown &&
      !options.blocking &&
      isRefreshCoolingDown(previousStatus, options.now ?? new Date())
    ) {
      const status = {
        ...previousStatus,
        lang,
        runAt,
        result: 'error',
        counts,
        errorMessage: `Refresh suppressed by ${REFRESH_COOLDOWN_MS / 60000}-minute cooldown`,
      } satisfies RunStatus;
      await writeRunStatus(env, status);
      return { ok: false, current: await readCurrentPayload(env, lang), status };
    }

    const current = await readCurrentPayload(env, lang);
    const rssResult = await fetchRssItems(lang, RSS_CANDIDATE_LIMIT);
    counts.rssFetched = rssResult.items.length;

    if (!rssResult.ok) {
      const status = {
        ...previousStatus,
        lang,
        runAt,
        result: 'rss_failed',
        counts,
        errorMessage: rssResult.errorMessage,
        lastAttemptAt: runAt,
        lastError: rssResult.errorMessage,
      } satisfies RunStatus;
      console.error(`[daily-brew] skipped ${lang}: ${rssResult.errorMessage}`);
      await writeRunStatus(env, status);
      return { ok: false, current, status };
    }

    const deduped = deduplicateByTitle(rssResult.items);
    counts.afterDedup = deduped.length;
    const recentPublished = collectRecentPublishedItems(current);
    const freshItems = filterItemsAlreadyPublished(deduped, recentPublished);
    counts.afterNoRepeat = freshItems.length;

    if (freshItems.length === 0) {
      console.log(`[daily-brew] skipped ${lang}: no fresh RSS items in ${NO_REPEAT_WINDOW_DAYS} days`);
      await writeRunStatus(env, {
        ...previousStatus,
        lang,
        runAt,
        result: 'skipped_no_fresh',
        counts,
        lastAttemptAt: runAt,
        lastSuccessAt: runAt,
      });
      return { ok: true, current, status: { ...previousStatus, lang, runAt, result: 'skipped_no_fresh', counts, lastAttemptAt: runAt, lastSuccessAt: runAt } };
    }

    const generatedItems = await generateShortTitles(
      lang,
      freshItems.slice(0, GEMINI_CANDIDATE_LIMIT),
      env,
    );
    counts.geminiReturned = generatedItems.length;
    const items = deduplicateByShortTitle(generatedItems).slice(0, OUTPUT_ITEM_LIMIT);
    counts.published = items.length;

    if (items.length === 0) {
      console.log(`[daily-brew] skipped ${lang}: Gemini returned no items`);
      await writeRunStatus(env, {
        ...previousStatus,
        lang,
        runAt,
        result: 'skipped_gemini_empty',
        counts,
        lastAttemptAt: runAt,
        lastSuccessAt: runAt,
      });
      return { ok: true, current, status: { ...previousStatus, lang, runAt, result: 'skipped_gemini_empty', counts, lastAttemptAt: runAt, lastSuccessAt: runAt } };
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
        refreshedAt: generatedAt,
        items,
        recentPublished: updatedRecentPublished,
      }),
    );

    const status = {
      ...previousStatus,
      lang,
      runAt,
      result: 'updated',
      counts,
      lastAttemptAt: runAt,
      lastSuccessAt: generatedAt,
      lastError: undefined,
    } satisfies RunStatus;
    await writeRunStatus(env, status);

    console.log(`[daily-brew] updated ${lang}: ${items.length} items`);
    return {
      ok: true,
      current: { lang, generatedAt, refreshedAt: generatedAt, items, recentPublished: updatedRecentPublished },
      status,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error(`[daily-brew] refresh failed for ${lang}`, errorMessage);
    const status = {
      ...previousStatus,
      lang,
      runAt,
      result: 'error',
      counts,
      errorMessage,
      lastAttemptAt: runAt,
      lastError: errorMessage,
    } satisfies RunStatus;
    await writeRunStatus(env, status);
    return { ok: false, current: await readCurrentPayload(env, lang), status };
  }
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

async function fetchRssItems(lang: Lang, count: number): Promise<RssFetchResult> {
  const response = await fetchRssWithRetry(lang);

  if (!response.ok) {
    const errorMessage = await buildRssErrorMessage(lang, response);
    console.error(`[daily-brew] ${errorMessage} for ${lang}`);
    return { ok: false, items: [], errorMessage };
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

  const items = itemBlocks
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
        !BLOCKED_SOURCE_KEYWORDS.some((blocked) =>
          item.source.toLowerCase().includes(blocked.toLowerCase()),
        ),
    )
    .sort(
      (a, b) =>
        sourcePriorityScore(b.source) - sourcePriorityScore(a.source),
    )
    .slice(0, count * 2);

  return {
    ok: true,
    items: filterItemsByPublishedAtWindow(items, RSS_LOOKBACK_MONTHS).slice(0, count),
  };
}

async function fetchRssWithRetry(lang: Lang): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(buildGoogleNewsRssUrl(lang), {
      headers: buildRssHeaders(lang, attempt),
    });
    (response as Response & { rssAttempt?: number }).rssAttempt = attempt;
    if (response.ok || !RSS_RETRYABLE_STATUSES.has(response.status) || attempt === 3) {
      return response;
    }
    lastResponse = response;
    await sleep(getRetryDelayMs(response, attempt));
  }
  return lastResponse ?? new Response(null, { status: 503 });
}

function buildRssHeaders(lang: Lang, attempt: number): HeadersInit {
  return {
    'User-Agent': 'daily-brew/1.0 (+https://github.com/takatama/daily-brew)',
    Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    'Accept-Language': lang === 'ja' ? 'ja-JP,ja;q=0.9' : 'en-US,en;q=0.9',
    'X-Daily-Brew-Retry-Attempt': String(attempt),
  };
}

function getRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds * 1000, 0), 30_000);
    }
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) {
      return Math.min(Math.max(timestamp - Date.now(), 0), 30_000);
    }
  }
  return Math.min(2 ** (attempt - 1) * 1000 + Math.floor(Math.random() * 250), 30_000);
}

async function buildRssErrorMessage(lang: Lang, response: Response): Promise<string> {
  const attempt = (response as Response & { rssAttempt?: number }).rssAttempt ?? 1;
  const body = normalizeDiagnosticBody(await response.clone().text());
  const details = [
    `lang=${lang}`,
    `status=${response.status}`,
    `attempts=${attempt}`,
    `server=${response.headers.get('server') ?? 'unknown'}`,
    `content-type=${response.headers.get('content-type') ?? 'unknown'}`,
  ];
  if (body) details.push(`body="${body}"`);
  return `RSS fetch failed (${details.join(', ')})`;
}

function normalizeDiagnosticBody(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function filterItemsByPublishedAtWindow(items: RssItem[], months: number): RssItem[] {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  return items.filter((item) => {
    if (!item.publishedAt) return false;
    const publishedTime = new Date(item.publishedAt).getTime();
    return Number.isFinite(publishedTime) && publishedTime >= cutoff.getTime();
  });
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
    const isDuplicate = result.some((kept) =>
      areTitlesSimilar(item.title, kept.title),
    );
    if (!isDuplicate) {
      result.push(item);
    }
  }

  return result;
}

function deduplicateByShortTitle(items: NewsItem[]): NewsItem[] {
  const result: NewsItem[] = [];

  for (const item of items) {
    const normalizedShortTitle = normalizeTitle(item.short_title);
    const normalizedUrl = normalizeUrl(item.url);
    const isDuplicate = result.some(
      (kept) =>
        (normalizedUrl && normalizedUrl === normalizeUrl(kept.url)) ||
        areTitlesSimilar(item.title, kept.title) ||
        areTitlesSimilar(item.short_title, kept.short_title),
    );
    if (!normalizedShortTitle || isDuplicate) {
      continue;
    }
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

function kvKey(type: 'current' | 'status', lang: Lang): string {
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

function tokenizeJapaneseTitle(title: string): Set<string> {
  const compactTitle = title.replace(/\s+/g, '');
  const tokens = new Set<string>();
  for (let i = 0; i < compactTitle.length - 1; i += 1) {
    tokens.add(compactTitle.slice(i, i + 2));
  }
  return tokens;
}

function areTitlesSimilar(a: string, b: string): boolean {
  const normalizedA = normalizeTitle(a);
  const normalizedB = normalizeTitle(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;

  const containsJapanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const tokensA = containsJapanese.test(normalizedA)
    ? tokenizeJapaneseTitle(normalizedA)
    : tokenizeTitle(normalizedA);
  const tokensB = containsJapanese.test(normalizedB)
    ? tokenizeJapaneseTitle(normalizedB)
    : tokenizeTitle(normalizedB);

  return (
    jaccardSimilarity(tokensA, tokensB) > 0.6 ||
    overlapSimilarity(tokensA, tokensB) > 0.5
  );
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

function overlapSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / Math.min(a.size, b.size);
}

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return `n_${(hash >>> 0).toString(16)}`;
}

function emptyRunCounts(): RunStatus['counts'] {
  return {
    rssFetched: 0,
    afterDedup: 0,
    afterNoRepeat: 0,
    geminiReturned: 0,
    published: 0,
  };
}

async function writeRunStatus(env: Env, status: RunStatus): Promise<void> {
  try {
    await env.KV_DAILY_BREW.put(
      kvKey('status', status.lang),
      JSON.stringify(status),
    );
  } catch (error) {
    console.error(
      `[daily-brew] failed to write status for ${status.lang}`,
      getErrorMessage(error),
    );
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function isAllowedOrigin(origin: string, allowedOrigins: string): boolean {
  return allowedOrigins
    .split(',')
    .map((allowed) => allowed.trim())
    .filter(Boolean)
    .some((allowed) => isOriginMatch(origin, allowed));
}

function isOriginMatch(origin: string, allowed: string): boolean {
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
  headers.set(
    'Access-Control-Expose-Headers',
    'X-Daily-Brew-State, X-Daily-Brew-Refreshed-At',
  );

  if (origin && isAllowedOrigin(origin, env.ALLOWED_ORIGIN)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
