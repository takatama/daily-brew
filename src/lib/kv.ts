import { KEY_PREFIX } from '../config';
import type { CurrentPayload, Env, Lang, NewsItem } from '../types';

export function kvKey(
  type: 'candidates' | 'current' | 'history',
  lang: Lang,
): string {
  return `${KEY_PREFIX}:${type}:${lang}`;
}

export async function getCandidates(
  lang: Lang,
  kv: KVNamespace,
): Promise<NewsItem[]> {
  return (
    (await kv.get<NewsItem[]>(kvKey('candidates', lang), 'json')) ?? []
  );
}

export async function getHistory(
  lang: Lang,
  kv: KVNamespace,
): Promise<NewsItem[]> {
  return (
    (await kv.get<NewsItem[]>(kvKey('history', lang), 'json')) ?? []
  );
}

export async function putCandidates(
  lang: Lang,
  items: NewsItem[],
  kv: KVNamespace,
): Promise<void> {
  await kv.put(kvKey('candidates', lang), JSON.stringify(items));
}

export async function putCurrent(
  lang: Lang,
  payload: CurrentPayload,
  kv: KVNamespace,
): Promise<void> {
  await kv.put(kvKey('current', lang), JSON.stringify(payload));
}

export async function putHistory(
  lang: Lang,
  items: NewsItem[],
  kv: KVNamespace,
): Promise<void> {
  await kv.put(kvKey('history', lang), JSON.stringify(items));
}
