import { getHistorySize } from '../config';
import { jsonResponse } from '../lib/json';
import { getCandidates, getHistory, putCurrent, putHistory } from '../lib/kv';
import {
  selectNextCandidate,
  updateHistory,
} from '../services/candidates';
import type { CurrentPayload, Env, Lang } from '../types';
import { kvKey } from '../lib/kv';

export async function handleGetNews(
  lang: Lang,
  env: Env,
): Promise<Response> {
  const currentKey = kvKey('current', lang);
  const current = await env.KV_DAILY_BREW.get<CurrentPayload>(
    currentKey,
    'json',
  );
  if (current?.item) {
    return jsonResponse(current, 200);
  }

  const candidates = await getCandidates(lang, env.KV_DAILY_BREW);
  if (candidates.length === 0) {
    return new Response(null, { status: 204 });
  }

  const history = await getHistory(lang, env.KV_DAILY_BREW);
  const picked = selectNextCandidate(
    candidates,
    history,
    getHistorySize(env),
  );
  if (!picked) {
    return new Response(null, { status: 204 });
  }

  const payload: CurrentPayload = {
    lang,
    generatedAt: new Date().toISOString(),
    item: picked,
  };

  await putCurrent(lang, payload, env.KV_DAILY_BREW);
  const updatedHistory = updateHistory(history, picked, getHistorySize(env));
  await putHistory(lang, updatedHistory, env.KV_DAILY_BREW);

  return jsonResponse(payload, 200);
}
