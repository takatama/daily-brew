import { getItemsPerLang, GEMINI_MODEL } from '../config';
import { safeParseJson } from '../lib/json';
import { hashString, normalizeUrl } from '../lib/text';
import type { Env, Lang, NewsItem } from '../types';

export async function generateCandidatesWithGemini(
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
    return null;
  }

  const data = await response.json<{
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  }>();

  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ??
    '';
  if (!text) {
    return null;
  }

  const parsed = safeParseJson<{ items?: Partial<NewsItem>[] }>(text);
  const items = parsed?.items ?? [];

  const nowIso = new Date().toISOString();
  return items
    .map((item) => sanitizeNewsItem(item, nowIso))
    .filter((item): item is NewsItem => item !== null)
    .slice(0, itemCount);
}

export function buildGeminiPrompt(lang: Lang, itemCount: number): string {
  if (lang === 'ja') {
    return `あなたは編集者です。google_search tool を使って、過去24〜48時間を優先した最新のコーヒー関連ニュースを収集してください。
条件:
- テーマ: コーヒー / カフェ / ロースター / 抽出器具 / イベント / 業界動向 / 新製品 / 大会
- スパム、アフィリエイト、転載まとめを避ける
- 公式サイト、メーカー、信頼できる媒体を優先
- summary は日本語で120〜180文字、本文転載はしない
- publishedAt は不明なら null
- 必ず厳格JSONのみを返す（前後の説明やMarkdown禁止）
JSON形式:
{
  "items": [
    {
      "id": "urlを元に安定したID",
      "title": "...",
      "summary": "...",
      "url": "https://...",
      "source": "媒体名",
      "publishedAt": "ISO-8601 or null"
    }
  ]
}
件数: ${itemCount}`;
  }

  return `You are a news editor. Use the google_search tool to gather the latest coffee-related news, prioritizing articles from the last 24-48 hours.
Constraints:
- Topics: coffee, cafe, roasters, brewing tools, events, industry trends, product launches, competitions
- Avoid spam, affiliate pages, and repost aggregators
- Prefer official sources, manufacturers, and reputable media
- Write summary in English, 120-180 characters, no article copy
- Use null when publishedAt is unknown
- Return strict JSON only (no markdown, no extra text)
JSON format:
{
  "items": [
    {
      "id": "stable id based on url",
      "title": "...",
      "summary": "...",
      "url": "https://...",
      "source": "...",
      "publishedAt": "ISO-8601 or null"
    }
  ]
}
Count: ${itemCount}`;
}

export function sanitizeNewsItem(
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
