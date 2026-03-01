export type Lang = 'ja' | 'en';

export type NewsItem = {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: string | null;
  generatedAt: string;
};

export type CurrentPayload = {
  lang: Lang;
  generatedAt: string;
  item: NewsItem;
};

export interface Env {
  KV_DAILY_BREW: KVNamespace;
  GEMINI_API_KEY: string;
  ALLOWED_ORIGIN: string;
  NEWS_ITEMS_PER_LANG?: string;
  PICK_HISTORY_SIZE?: string;
  CRON_LANGS?: string;
}
