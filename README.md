# daily-brew

`daily-brew` is a Cloudflare Worker API that delivers one coffee-related news item per language per day. It fetches articles from Google News RSS, deduplicates by title similarity, and uses Gemini 2.5-flash-lite to generate a `short_title` and `summary`. The result is cached in Workers KV and served from `GET /news`.

## Key Features

- Google News RSS → Jaccard-based deduplication → Gemini summary generation
- `ja` and `en` use independent RSS queries (not translation)
- Press-release sources (PR TIMES, atpress, newscast, etc.) are filtered out
- Gemini API key is kept server-side as a Worker secret and never exposed to clients

## API

### `GET /news?lang=ja|en`

- `lang` defaults to `ja` when omitted
- Returns `200` with `{ lang, generatedAt, item }` when content is available
- Returns `204 No Content` if no item has been generated yet

#### Response shape

```json
{
  "lang": "ja",
  "generatedAt": "2026-03-01T22:00:00.000Z",
  "item": {
    "id": "n_1a2b3c4d",
    "title": "...",
    "short_title": "...",
    "summary": "...",
    "url": "https://...",
    "source": "...",
    "publishedAt": "2026-03-01T10:00:00.000Z"
  }
}
```

### CORS

- `Access-Control-Allow-Origin` is set only when the request `Origin` exactly matches `ALLOWED_ORIGIN`
- `OPTIONS` preflight is supported

## KV Keys

- `daily-brew:current:ja`
- `daily-brew:current:en`

## Scheduled Flow (Cron: `0 22 * * *` UTC = 07:00 JST)

For each language (`ja`, `en`):

1. Fetch up to 20 items from Google News RSS
2. Remove near-duplicates (Jaccard similarity > 0.6) and take top 5
3. Pass titles to Gemini 2.5-flash-lite → receive `short_title` + `summary` as JSON
4. Store the first item as `daily-brew:current:{lang}` in KV

## Setup

```bash
npm install
npx wrangler kv namespace create KV_DAILY_BREW
npx wrangler secret put GEMINI_API_KEY
```

Replace KV namespace IDs in `wrangler.toml`.

## Local Development

Create a `.dev.vars` file:

```
GEMINI_API_KEY=your_gemini_api_key_here
```

Then run:

```bash
npx wrangler dev
```

Trigger the scheduled handler manually:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

Verify the response:

```bash
curl -i "http://localhost:8787/news?lang=ja" -H "Origin: https://coco-timer.pages.dev"
curl -i "http://localhost:8787/news?lang=en" -H "Origin: https://coco-timer.pages.dev"
```

## Usage from Pages

```ts
const res = await fetch(`${NEWS_API_BASE}/news?lang=ja`);
if (res.status === 204) {
  // hide news card
}
```
