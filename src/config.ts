import type { Env, Lang } from './types';

export const KEY_PREFIX = 'daily-brew';
export const DEFAULT_ITEMS_PER_LANG = 8;
export const DEFAULT_HISTORY_SIZE = 5;
export const MAX_CANDIDATE_MULTIPLIER = 3;
export const GEMINI_MODEL = 'gemini-3-flash-preview';

export function getItemsPerLang(env: Env): number {
  const parsed = Number(env.NEWS_ITEMS_PER_LANG ?? DEFAULT_ITEMS_PER_LANG);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_ITEMS_PER_LANG;
}

export function getHistorySize(env: Env): number {
  const parsed = Number(env.PICK_HISTORY_SIZE ?? DEFAULT_HISTORY_SIZE);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_HISTORY_SIZE;
}

export function parseCronLangs(raw?: string): Lang[] {
  const set = new Set<Lang>();
  for (const token of (raw ?? 'ja,en').split(',')) {
    const lang = normalizeLang(token.trim() || null);
    set.add(lang);
  }
  return Array.from(set);
}

export function normalizeLang(value: string | null): Lang {
  return value === 'en' ? 'en' : 'ja';
}
