import { getHistorySize, normalizeLang, parseCronLangs } from './config';
import { handleGetNews } from './handlers/news';
import { buildCorsResponse } from './lib/cors';
import { jsonResponse } from './lib/json';
import { getHistory, putCurrent, putHistory } from './lib/kv';
import { selectNextCandidate, updateHistory } from './services/candidates';
import { generateCandidatesWithGemini } from './services/gemini';
import { mergeAndStoreCandidates } from './services/candidates';
import type { CurrentPayload, Env, Lang } from './types';

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return buildCorsResponse(
        new Response(null, { status: 204 }),
        request,
        env,
      );
    }

    if (request.method === 'GET' && url.pathname === '/news') {
      const lang = normalizeLang(url.searchParams.get('lang'));
      const response = await handleGetNews(lang, env);
      return buildCorsResponse(response, request, env);
    }

    return buildCorsResponse(
      jsonResponse({ error: 'Not Found' }, 404),
      request,
      env,
    );
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const langs = parseCronLangs(env.CRON_LANGS);
    for (const lang of langs) {
      try {
        await refreshLanguageNews(lang, env);
      } catch (error) {
        console.error(
          `[daily-brew] scheduled refresh failed for ${lang}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  },
};

async function refreshLanguageNews(lang: Lang, env: Env): Promise<void> {
  const generated = await generateCandidatesWithGemini(lang, env);

  if (!generated || generated.length === 0) {
    console.log(
      `[daily-brew] skipped updating ${lang}: Gemini returned no candidates`,
    );
    return;
  }

  const merged = await mergeAndStoreCandidates(lang, generated, env);
  const history = await getHistory(lang, env.KV_DAILY_BREW);
  const picked = selectNextCandidate(merged, history, getHistorySize(env));

  if (!picked) {
    console.log(
      `[daily-brew] skipped updating ${lang}: no selectable candidate`,
    );
    return;
  }

  const currentPayload: CurrentPayload = {
    lang,
    generatedAt: new Date().toISOString(),
    item: picked,
  };

  await putCurrent(lang, currentPayload, env.KV_DAILY_BREW);
  const updatedHistory = updateHistory(history, picked, getHistorySize(env));
  await putHistory(lang, updatedHistory, env.KV_DAILY_BREW);
}
