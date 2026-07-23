interface Env {
  DAILY_BREW: Fetcher;
}

type Lang = 'ja' | 'en';

const LANGS = ['ja', 'en'] as const satisfies readonly Lang[];

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    for (const lang of LANGS) {
      await warmupLanguage(env, lang);
    }
  },
};

async function warmupLanguage(env: Env, lang: Lang): Promise<void> {
  const response = await env.DAILY_BREW.fetch(
    new Request(`https://daily-brew.internal/news?lang=${lang}`, {
      headers: {
        'X-Daily-Brew-Warmup': 'blocking',
      },
    }),
  );

  const state = response.headers.get('X-Daily-Brew-State') ?? 'unknown';
  if (response.ok) {
    console.log(`[daily-brew-cron] warmed ${lang}: state=${state}`);
    return;
  }

  const body = normalizeBodySnippet(await response.text());
  throw new Error(
    `[daily-brew-cron] warmup failed for ${lang}: status=${response.status}, state=${state}, body="${body}"`,
  );
}

function normalizeBodySnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}
