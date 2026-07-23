# daily-brew

`daily-brew` is a Cloudflare Worker API that delivers up to 5 coffee-related news items per language per day. It fetches articles from Google News RSS, deduplicates by title similarity, and uses Gemini 2.5-flash-lite to generate a `short_title` for each item. Results are cached in Workers KV and served from `GET /news`. Scheduled run results are exposed from `GET /status`.

## Key Features

- Google News RSS (up to 100 candidates) → Jaccard-based deduplication → 5-day no-repeat filtering → Gemini `short_title` generation
- `ja` and `en` use independent RSS queries (not translation)
- Press-release sources (PR TIMES, atpress, newscast, Business Wire, etc.), Yahoo!フリマ, and individually listed low-relevance sources are filtered out at the query and source level
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


### `GET /status`

Returns the latest scheduled-run status for both languages. This endpoint does not require authentication and intentionally contains only result metadata and counts.

```json
{
  "ja": {
    "lang": "ja",
    "runAt": "2026-03-01T20:00:00.000Z",
    "result": "updated",
    "counts": {
      "rssFetched": 42,
      "afterDedup": 37,
      "afterNoRepeat": 35,
      "geminiReturned": 20,
      "published": 5
    }
  },
  "en": null
}
```

`result` is one of `updated`, `skipped_no_fresh`, `skipped_gemini_empty`, `rss_failed`, or `error`.

### CORS

- `Access-Control-Allow-Origin` is set when the request `Origin` matches one of the comma-separated `ALLOWED_ORIGIN` entries exactly or is a subdomain of one of them (e.g. `*.coco-timer.pages.dev`, `*.neo-brew-timer.pages.dev`)
- `OPTIONS` preflight is supported

## KV Keys

- `daily-brew:current:ja`
- `daily-brew:current:en`
- `daily-brew:status:ja`
- `daily-brew:status:en`

## Scheduled Flow (Cron: `0 20 * * *` UTC = 05:00 JST)

For each language (`ja`, `en`):

1. Fetch up to 100 items from Google News RSS
2. Remove near-duplicates (Jaccard similarity > 0.6)
3. Exclude items that were already published in the last 5 days (URL/title normalized match)
4. Take up to 20 fresh items and pass titles to Gemini 2.5-flash-lite → receive `short_title` as JSON
5. Store up to 5 generated items in `daily-brew:current:{lang}`
6. Store the run result and per-stage counts in `daily-brew:status:{lang}`

## Freshness / No-Repeat Rule

- The Worker keeps a rolling 5-day publication history per language in the same KV payload (`recentPublished`).
- A candidate is excluded if its normalized URL or normalized title matches a previously published entry within that 5-day window.
- If no fresh items remain after filtering, the scheduled run skips updating current news KV, keeps the previous payload, and records `skipped_no_fresh` in status KV.

## Setup

```bash
npm install
npx wrangler kv namespace create KV_DAILY_BREW
npx wrangler secret put GEMINI_API_KEY
```

Replace the KV namespace ID in `wrangler.toml`. Workers Logs are enabled through `[observability] enabled = true`, so scheduled-run logs are retained in Cloudflare.

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
curl -i "http://localhost:8787/news?lang=ja" -H "Origin: https://neo-brew-timer.pages.dev"
curl -i "http://localhost:8787/status"
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

## Cron Split / Placement Architecture

`daily-brew` no longer owns a Cron Trigger. The runtime architecture is now:

```text
daily-brew-cron
  scheduled() at 0 20 * * * UTC (05:00 JST)
    -> HTTP Service Binding DAILY_BREW
      -> daily-brew GET /news?lang=ja
      -> daily-brew GET /news?lang=en
        -> refreshes from Google News RSS only when stale
```

### Worker roles

- `daily-brew`
  - Serves the public `GET /news?lang=ja|en` and `GET /status` endpoints.
  - Uses `[placement] region = "gcp:asia-northeast1"` so HTTP `fetch()` requests run near Tokyo.
  - Stores current news as `{ refreshedAt, items }` plus the existing compatibility fields (`lang`, `generatedAt`, `recentPublished`).
  - Treats a news day as fresh from 05:00 JST, calculated explicitly and independently of the Worker runtime timezone.
  - On normal user traffic, returns stale data immediately and refreshes in `ctx.waitUntil()` when possible.
  - If no data exists, waits for refresh and returns `503` if refresh fails.
  - Applies a per-language 15-minute cooldown after failed refresh attempts to avoid retrying Google News RSS on every user request.

- `daily-brew-cron`
  - Owns the Cloudflare Cron Trigger `0 20 * * *` (UTC, which is 05:00 JST).
  - Calls `daily-brew` via HTTP Service Binding, sequentially for `ja` then `en`.
  - Sends `X-Daily-Brew-Warmup: blocking`, which makes stale refreshes wait for RSS/Gemini/KV completion.
  - Fails the Cron run when `daily-brew` returns a non-2xx response, including language, HTTP status, refresh state, and a short response-body snippet in the thrown error.

### Refresh response headers

`GET /news` preserves the existing JSON body shape as much as possible and reports refresh state through headers:

- `X-Daily-Brew-State: fresh` — cached news is valid for the current JST news day.
- `X-Daily-Brew-State: stale` — stale news was returned immediately; a normal request may have scheduled a background refresh.
- `X-Daily-Brew-State: refreshed` — the request waited for a successful refresh.
- `X-Daily-Brew-State: refresh-failed` — refresh failed; stale data may be returned to users, while blocking warmup returns `503`.
- `X-Daily-Brew-Refreshed-At: <ISO timestamp>` — timestamp of the stored news payload when available.

The CORS response exposes these headers with `Access-Control-Expose-Headers`.

### RSS retry and diagnostics

Google News RSS requests include an explicit `User-Agent`, XML-oriented `Accept`, and per-language `Accept-Language`. Transient statuses (`429`, `500`, `502`, `503`, `504`) are retried up to three times with exponential backoff, jitter, and bounded `Retry-After` support. RSS failures recorded in `/status` include language, HTTP status, selected response headers, attempt count, and a normalized short body snippet.

### Deployment order

Deploy in this order so the Service Binding can resolve the target Worker:

1. Deploy `daily-brew` first:
   ```bash
   npx wrangler deploy
   ```
2. Deploy the Cron Worker from its directory:
   ```bash
   cd cron-worker
   npx wrangler deploy
   ```
3. Confirm in Cloudflare that the `daily-brew-cron` Service Binding points to service `daily-brew` with binding name `DAILY_BREW`. The repository contains this in `cron-worker/wrangler.toml`, but account-level deployment permissions still need to allow binding resolution.

Do not add a Cron Trigger back to `daily-brew`; only `daily-brew-cron` should have `[triggers]`.

### Manual verification

Run `daily-brew` locally:

```bash
npx wrangler dev
```

Verify normal access and state headers:

```bash
curl -i "http://localhost:8787/news?lang=ja" -H "Origin: https://coco-timer.pages.dev"
curl -i "http://localhost:8787/news?lang=en" -H "Origin: https://coco-timer.pages.dev"
curl -i "http://localhost:8787/status"
```

Verify the blocking warmup behavior against a deployed `daily-brew` Worker or local equivalent:

```bash
curl -i "https://<daily-brew-host>/news?lang=ja" -H "X-Daily-Brew-Warmup: blocking"
curl -i "https://<daily-brew-host>/news?lang=en" -H "X-Daily-Brew-Warmup: blocking"
```

If `daily-brew-cron` fails, normal user access to `/news` can still self-recover: fresh cached data is served directly, stale cached data is served while a background refresh is attempted, and an empty cache waits for refresh before returning data or `503`.
