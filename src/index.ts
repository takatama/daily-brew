interface Env {
  DB_KV: KVNamespace;
  GEMINI_API_KEY: string;
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

const KEY_PREFIX = 'daily-brew';
const DEFAULT_ITEMS_PER_LANG = 8;
const DEFAULT_HISTORY_SIZE = 5;
const MAX_CANDIDATE_MULTIPLIER = 3;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';

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
  const current = await env.DB_KV.get<CurrentPayload>(currentKey, 'json');
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

  await env.DB_KV.put(currentKey, JSON.stringify(payload));
  const updatedHistory = updateHistory(history, picked, getHistorySize(env));
  await env.DB_KV.put(kvKey('history', lang), JSON.stringify(updatedHistory));

  return jsonResponse(payload, 200);
}

async function refreshLanguageNews(lang: Lang, env: Env): Promise<void> {
  const generated = await generateCandidatesWithGemini(lang, env);

  if (!generated || generated.length === 0) {
    console.log(
      `[daily-brew] skipped updating ${lang}: Gemini returned no candidates`,
    );
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

  await env.DB_KV.put(kvKey('current', lang), JSON.stringify(currentPayload));
  const updatedHistory = updateHistory(history, picked, getHistorySize(env));
  await env.DB_KV.put(kvKey('history', lang), JSON.stringify(updatedHistory));
}

async function generateCandidatesWithGemini(
  lang: Lang,
  env: Env,
): Promise<NewsItem[] | null> {
  const itemCount = getItemsPerLang(env);
  const prompt = buildGeminiPrompt(lang, itemCount);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        tools: [{ google_search: {} }],
        generationConfig: {
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
    return null;
  }

  const data = await response.json<{
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        groundingChunks?: Array<{
          web?: { uri?: string; title?: string };
        }>;
        groundingSupports?: Array<{
          segment?: { text?: string };
          groundingChunkIndices?: number[];
        }>;
      };
    }>;
  }>();

  const candidate = data.candidates?.[0];
  if (!candidate) {
    return null;
  }

  const items = buildNewsItemsFromGrounding(candidate, lang);
  if (items.length === 0) {
    return null;
  }

  return items.slice(0, itemCount);
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
  await env.DB_KV.put(kvKey('candidates', lang), JSON.stringify(merged));
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
    (await env.DB_KV.get<NewsItem[]>(kvKey('candidates', lang), 'json')) ?? []
  );
}

async function getHistory(lang: Lang, env: Env): Promise<NewsItem[]> {
  return (
    (await env.DB_KV.get<NewsItem[]>(kvKey('history', lang), 'json')) ?? []
  );
}

function buildGeminiPrompt(lang: Lang, itemCount: number): string {
  if (lang === 'ja') {
    return `あなたは編集者です。google_search tool を使って、過去24〜48時間を優先した最新のコーヒー関連ニュースを収集してください。
条件:
- テーマ: コーヒー / カフェ / ロースター / 抽出器具 / イベント / 業界動向 / 新製品 / 大会
- スパム、アフィリエイト、転載まとめを避ける
- 公式サイト、メーカー、信頼できる媒体を優先
- 回答は通常の文章でよい（JSON不要）
件数: ${itemCount}`;
  }

  return `You are a news editor. Use the google_search tool to gather the latest coffee-related news, prioritizing articles from the last 24-48 hours.
Constraints:
- Topics: coffee, cafe, roasters, brewing tools, events, industry trends, product launches, competitions
- Avoid spam, affiliate pages, and repost aggregators
- Prefer official sources, manufacturers, and reputable media
- Write a concise English answer (JSON is not required)
Count: ${itemCount}`;
}

function buildNewsItemsFromGrounding(
  candidate: {
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: { uri?: string; title?: string };
      }>;
      groundingSupports?: Array<{
        segment?: { text?: string };
        groundingChunkIndices?: number[];
      }>;
    };
  },
  lang: Lang,
): NewsItem[] {
  const nowIso = new Date().toISOString();
  const answerText =
    candidate.content?.parts?.map((part) => part.text ?? '').join(' ').trim() ??
    '';
  const chunks = candidate.groundingMetadata?.groundingChunks ?? [];
  const supports = candidate.groundingMetadata?.groundingSupports ?? [];

  const supportedTexts = supports
    .map((support) => support.segment?.text?.trim() ?? '')
    .filter(Boolean);
  const summaryBase = supportedTexts.join(' ');
  const summary = (summaryBase || answerText).trim();

  const chunkIndices = new Set<number>();
  for (const support of supports) {
    for (const index of support.groundingChunkIndices ?? []) {
      if (Number.isInteger(index) && index >= 0 && index < chunks.length) {
        chunkIndices.add(index);
      }
    }
  }
  if (chunkIndices.size === 0 && chunks.length > 0) {
    chunkIndices.add(0);
  }

  const sources = Array.from(chunkIndices)
    .map((index) => chunks[index]?.web)
    .filter((web): web is { uri?: string; title?: string } => Boolean(web));

  const primaryUrl = sources.find((source) => source.uri)?.uri ?? '';
  const sourceNames = sources
    .map((source) => source.title?.trim() ?? '')
    .filter(Boolean)
    .slice(0, 3);

  const title =
    summary.split(/(?<=[.!?。！？])\s+/u)[0]?.trim() ||
    (lang === 'ja' ? '最新のコーヒーニュース' : 'Latest coffee news');

  const rawItem: Partial<NewsItem> = {
    id: hashString(`${lang}:${primaryUrl}:${summary || answerText}`),
    title,
    summary,
    url: primaryUrl,
    source: sourceNames.join(', ') || 'Google Search Grounding',
    publishedAt: null,
  };

  const sanitized = sanitizeNewsItem(rawItem, nowIso);
  return sanitized ? [sanitized] : [];
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
