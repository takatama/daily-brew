# daily-brew

`daily-brew` is a Cloudflare Worker API that delivers coffee-related news. It uses Gemini with `google_search` grounding to gather fresh candidates, caches them in Workers KV, and serves one current item from `/news`.

## Key Features

- AI-powered news collection -> KV-cached delivery
- `ja` and `en` are generated from **independent source discovery** (not translation)
- Consecutive duplicate avoidance using URL match + normalized title similarity checks
- Gemini API key is kept server-side as a Worker secret (`GEMINI_API_KEY`) and never exposed to clients

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

1. Collect language-specific candidates via Gemini (`google_search` tool)
2. Merge with existing candidates and deduplicate by URL
3. Select `current` while avoiding repeated content based on `history`
4. Save `current` and prepend to `history` (trimmed to configured size)

## Setup

```bash
npm install -D wrangler typescript @cloudflare/workers-types
npx wrangler kv namespace create DB_KV
npx wrangler secret put GEMINI_API_KEY
```

Replace KV namespace IDs in `wrangler.toml`.

## Local Development

create a `.dev.vars` file with:

```
GEMINI_API_KEY=your_gemini_api_key_here
```

Then run:

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
