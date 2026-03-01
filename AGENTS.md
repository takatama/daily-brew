# AGENTS.md

Guidelines for AI agents (Claude Code, Codex, etc.) working on this repository.

## Project Overview

`daily-brew` is a Cloudflare Worker that fetches coffee-related news from Google News RSS, deduplicates articles by title similarity, and generates `short_title` / `summary` via Gemini 2.5-flash-lite. One item per language (`ja`, `en`) is stored in Workers KV and served via `GET /news?lang=ja|en`.

## Architecture

- **Runtime**: Cloudflare Workers (single file: `src/index.ts`)
- **KV binding**: `KV_DAILY_BREW` — key pattern: `daily-brew:current:{lang}`
- **Cron**: `0 22 * * *` UTC (07:00 JST), runs for both `ja` and `en`
- **Gemini model**: `gemini-2.5-flash-lite` — no `google_search` tool (causes URL hallucination)

## Scheduled Flow

```
for lang in ['ja', 'en']:
  1. fetchRssItems(lang, 20)       — Google News RSS, regex XML parse
  2. deduplicateByTitle(items)     — Jaccard similarity > 0.6 → remove duplicate
  3. .slice(0, 5)
  4. generateSummaries(lang, items) — Gemini: short_title + summary as JSON
  5. KV.put('daily-brew:current:{lang}', items[0])
```

## Key Constraints

- **No DOMParser**: Cloudflare Workers does not support `DOMParser`. Parse XML with regex.
- **No `google_search` tool in Gemini**: Use `responseMimeType: 'application/json'` only; adding `tools: [{ google_search: {} }]` prevents JSON mode and causes URL fabrication.
- **Blocked sources**: Press-release distributors are filtered in `BLOCKED_SOURCES` (PR TIMES, atpress, newscast, Business Wire, PR Newswire, GlobeNewswire, EIN Presswire). Add to the array as needed.
- **Type check**: Always run `npx tsc --noEmit` before committing.

## Local Development

```bash
# .dev.vars
GEMINI_API_KEY=your_key_here

npx wrangler dev

# Trigger scheduled handler
curl "http://localhost:8787/cdn-cgi/handler/scheduled"

# Verify response
curl -i "http://localhost:8787/news?lang=ja" -H "Origin: https://coco-timer.pages.dev"
```

## PR Guidelines

- Write PR titles and bodies in **English**
- Keep `src/index.ts` as a single file (no splitting)
- Do not re-introduce candidate pool, history KV keys, or multi-cron schedules
