import { getItemsPerLang, MAX_CANDIDATE_MULTIPLIER } from '../config';
import { getCandidates, putCandidates } from '../lib/kv';
import {
  jaccardSimilarity,
  normalizeTitle,
  normalizeUrl,
  tokenizeTitle,
} from '../lib/text';
import type { Env, Lang, NewsItem } from '../types';

export async function mergeAndStoreCandidates(
  lang: Lang,
  newItems: NewsItem[],
  env: Env,
): Promise<NewsItem[]> {
  const existing = await getCandidates(lang, env.KV_DAILY_BREW);
  const mergedMap = new Map<string, NewsItem>();

  for (const item of [...newItems, ...existing]) {
    const key = normalizeUrl(item.url) || item.id;
    if (!mergedMap.has(key)) {
      mergedMap.set(key, item);
    }
  }

  const maxCandidates = getItemsPerLang(env) * MAX_CANDIDATE_MULTIPLIER;
  const merged = Array.from(mergedMap.values()).slice(0, maxCandidates);
  await putCandidates(lang, merged, env.KV_DAILY_BREW);
  return merged;
}

export function selectNextCandidate(
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

export function isBlockedByHistory(
  candidate: NewsItem,
  history: NewsItem[],
): boolean {
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

export function updateHistory(
  history: NewsItem[],
  picked: NewsItem,
  historySize: number,
): NewsItem[] {
  const filtered = history.filter(
    (item) => normalizeUrl(item.url) !== normalizeUrl(picked.url),
  );
  return [picked, ...filtered].slice(0, historySize);
}
