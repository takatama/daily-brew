# daily-brew

`daily-brew` is a Cloudflare Worker API that delivers coffee-related news. It gathers fresh candidates from RSS feeds, creates short summaries with Workers AI, caches them in Workers KV, and serves one current item from `/news`.

## Key Features

- RSS-based news ingestion -> Workers AI summarization -> KV-cached delivery
- `ja` and `en` are generated from **independent feed sets** (not translation)
- Consecutive duplicate avoidance using URL match + normalized title similarity checks
- All AI calls are handled inside Workers via the `AI` binding (no client exposure)

## API

### `GET /news?lang=ja|en`

- `lang` defaults to `ja` when omitted
- Response contains `lang`, `generatedAt`, and `item` (`title`, `summary`, `url`, `source`, `publishedAt`)
- If `current` is missing, the Worker picks one from `candidates`
- If no item can be picked, returns `204 No Content`

### CORS

- `Access-Control-Allow-Origin` is set only when request `Origin` exactly matches `ALLOWED_ORIGIN`
- `OPTIONS` is implemented

## KV Keys

- `daily-brew:candidates:ja|en`
- `daily-brew:current:ja|en`
- `daily-brew:history:ja|en`

## Scheduled Flow (Cron)

1. Fetch language-specific RSS feeds
2. Parse + deduplicate candidate articles by normalized URL
3. Generate summaries with Workers AI
4. Merge with existing candidates, then select `current` while avoiding repeated content from `history`
5. Save `current` and prepend to `history` (trimmed to configured size)

## Setup

```bash
npm install -D wrangler typescript @cloudflare/workers-types
npx wrangler kv namespace create KV_DAILY_BREW
```

Replace KV namespace IDs in `wrangler.toml`.

## Local Development

No API key is needed for summarization when using Workers AI binding in your Cloudflare account.

```bash
npx wrangler dev
```

To manually trigger a scheduled event, run:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## Verification with curl

```bash
curl -i "http://localhost:8787/news?lang=ja" -H "Origin: https://coco-timer.pages.dev"
curl -i "http://localhost:8787/news?lang=en" -H "Origin: https://coco-timer.pages.dev"
```

## Expected Usage from Pages

On Pages (`coco-timer.pages.dev`), keep the Worker base URL in something like `NEWS_API_BASE` and call:

```ts
fetch(`${NEWS_API_BASE}/news?lang=ja`);
```

If the API returns `204`, the UI should hide the news card.
