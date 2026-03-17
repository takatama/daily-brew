# daily-brew

`daily-brew` is a Cloudflare Worker API that delivers up to 5 coffee-related news items per language per day. It fetches articles from Google News RSS, deduplicates by title similarity, and uses Gemini 2.5-flash-lite to generate a `short_title` for each item. Results are cached in Workers KV and served from `GET /news`.

## Key Features

- Google News RSS (up to 100 candidates) → Jaccard-based deduplication → 5-day no-repeat filtering → Gemini `short_title` generation
- `ja` and `en` use independent RSS queries (not translation)
- Press-release sources (PR TIMES, atpress, newscast, 経済新聞, etc.) are filtered out at the query and source level
- Gemini API key is kept server-side as a Worker secret and never exposed to clients

## API

### `GET /news?lang=ja|en`

- `lang` defaults to `ja` when omitted
- Returns `200` with `{ lang, generatedAt, items }` when content is available
- Returns `204 No Content` if no items have been generated yet

#### Response shape

```json
{
  "lang": "ja",
  "generatedAt": "2026-03-01T19:00:00.000Z",
  "items": [
    {
      "id": "n_1a2b3c4d",
      "title": "...",
      "short_title": "...",
      "url": "https://...",
      "source": "...",
      "publishedAt": "2026-03-01T10:00:00.000Z",
      "generatedAt": "2026-03-01T19:00:00.000Z"
    }
  ]
}
```

### CORS

- `Access-Control-Allow-Origin` is set when the request `Origin` matches `ALLOWED_ORIGIN` exactly or is a subdomain of it (e.g. `*.coco-timer.pages.dev`)
- `OPTIONS` preflight is supported

## KV Keys

- `daily-brew:current:ja`
- `daily-brew:current:en`

## Scheduled Flow (Cron: `0 20 * * *` UTC = 05:00 JST)

For each language (`ja`, `en`):

1. Fetch up to 100 items from Google News RSS
2. Remove near-duplicates (Jaccard similarity > 0.6)
3. Exclude items that were already published in the last 5 days (URL/title normalized match)
4. Take up to 5 fresh items and pass titles to Gemini 2.5-flash-lite → receive `short_title` as JSON
5. Store `{ lang, generatedAt, items, recentPublished }` in `daily-brew:current:{lang}`

## Freshness / No-Repeat Rule

- The Worker keeps a rolling 5-day publication history per language in the same KV payload (`recentPublished`).
- A candidate is excluded if its normalized URL or normalized title matches a previously published entry within that 5-day window.
- If no fresh items remain after filtering, the scheduled run skips updating KV and keeps the previous payload.

## Setup

```bash
npm install
npx wrangler kv namespace create KV_DAILY_BREW
npx wrangler secret put GEMINI_API_KEY
```

Replace the KV namespace ID in `wrangler.toml`.


## Placement Hints (Tokyo-latency oriented)

`wrangler.toml` sets the following Placement Hint:

```toml
[placement]
region = "gcp:asia-northeast1"
```

- This does **not** run your Worker inside GCP. It asks Cloudflare to place execution at Cloudflare locations with low latency to GCP Tokyo.
- This is mainly effective for `fetch` handler traffic (request-time execution).
- Verify behavior by checking the `cf-placement` response header.
- Optional minimal debug endpoint idea (only when needed): return `request.cf?.placement` and the `cf-placement` header so you can compare runtime observations without changing main logic.
- If this Worker continues to handle both edge auth/routing and backend-near API logic, you can later consider splitting into an edge Worker and a backend-near Worker.

## Local Development

Create a `.dev.vars` file:

```
GEMINI_API_KEY=your_gemini_api_key_here
```

Start the local dev server:

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

## Manual News Refresh

To update KV immediately without waiting for the cron (requires `.dev.vars` with `GEMINI_API_KEY` and `wrangler login` credentials):

```bash
npm run refresh-news        # both ja and en
npm run refresh-news ja     # ja only
npm run refresh-news en     # en only
```

## RSS Feed Inspection

To check which articles the RSS query returns and how the source filter applies:

```bash
npm run check-rss           # ja
node scripts/check-rss.mjs en
```

## Usage from Pages

```ts
const res = await fetch(`${NEWS_API_BASE}/news?lang=ja`);
if (res.status === 204) {
  // hide news card
}
const { items } = await res.json();
```
