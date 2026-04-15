import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { generatePipelinePost, type PipelineResult } from '../../src/lib/pipeline.js';
import { generateManagedPost, type ManagedResult } from '../../src/lib/managed-agent.js';
import { sendToChannel, type SendResult } from '../../src/lib/telegram.js';

export default async (): Promise<Response> => {
  if (process.env.KESHA_ENABLED !== 'true') {
    console.log('[kesha-post] KESHA_ENABLED != true — skipping');
    return new Response('skipped', { status: 200 });
  }

  // Cron fires every Wednesday, but we only want 1st and 3rd Wednesday of the
  // month (bi-weekly). Pure cron can't express "AND" between day-of-month and
  // day-of-week, so we gate in code: day-of-month must be in 1-7 (1st Wed) or
  // 15-21 (3rd Wed). Uses UTC to match the cron schedule timezone.
  const dayOfMonth = new Date().getUTCDate();
  const isFirstOrThirdWeek =
    (dayOfMonth >= 1 && dayOfMonth <= 7) ||
    (dayOfMonth >= 15 && dayOfMonth <= 21);
  if (!isFirstOrThirdWeek) {
    console.log(
      `[kesha-post] day-of-month=${dayOfMonth} not in 1-7 or 15-21 — skipping (bi-weekly gate)`,
    );
    return new Response('skipped', { status: 200 });
  }

  const mode = process.env.KESHA_MODE ?? 'pipeline';
  // KESHA_CRON_CHANNEL routes the scheduled run to:
  //   'test' (default)  → TELEGRAM_TEST_CHAT_ID (@CtrlAltTherapy_test)
  //   'main'            → TELEGRAM_CHAT_ID (production @psyreq)
  // During stabilization we stay on 'test'; flip to 'main' via Netlify env
  // when confident — no redeploy needed.
  const channel = process.env.KESHA_CRON_CHANNEL ?? 'test';
  const chatId = channel === 'main'
    ? process.env.TELEGRAM_CHAT_ID
    : process.env.TELEGRAM_TEST_CHAT_ID;

  console.log(`[kesha-post] mode=${mode} channel=${channel}`);

  const store = getStore('kesha');
  const startedAt = new Date().toISOString();
  await store.setJSON('latest-result', {
    status: 'running',
    startedAt,
    mode,
    trigger: 'cron',
    channel,
  });

  try {
    async function run(): Promise<PipelineResult | ManagedResult> {
      if (mode === 'managed') return generateManagedPost();
      return generatePipelinePost();
    }

    let result = await run();

    if (!result.success) {
      console.log('[kesha-post] attempt 1 failed, retrying...');
      console.log('[kesha-post] errors:', result.errors);
      result = await run();
    }

    if (!result.success) {
      console.error('[kesha-post] both attempts failed — not posting');
      console.error('[kesha-post] final errors:', result.errors);
      await persistResult(store, { status: 'failed', startedAt, mode, channel, result, sendResult: null });
      return new Response('failed', { status: 500 });
    }

    const sendResult = await sendToChannel(result.post!, chatId);

    if (!sendResult.success) {
      console.error('[kesha-post] telegram send failed:', sendResult.error);
      await persistResult(store, { status: 'failed', startedAt, mode, channel, result, sendResult });
      return new Response('telegram failed', { status: 500 });
    }

    console.log(`[kesha-post] posted! messageId=${sendResult.messageId}`);
    await persistResult(store, { status: 'ok', startedAt, mode, channel, result, sendResult });
    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('[kesha-post] unexpected error:', err);
    await store.setJSON('latest-result', {
      status: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      mode,
      trigger: 'cron',
      channel,
      errors: [err instanceof Error ? err.message : String(err)],
    });
    return new Response('error', { status: 500 });
  }
};

interface PersistInput {
  status: 'ok' | 'failed';
  startedAt: string;
  mode: string;
  channel: string;
  result: PipelineResult | ManagedResult;
  sendResult: SendResult | null;
}

// Mirrors the StoredResult shape written by kesha-test-background so
// /kesha-result can render cron runs the same way as manual test runs.
async function persistResult(
  store: ReturnType<typeof getStore>,
  { status, startedAt, mode, channel, result, sendResult }: PersistInput,
): Promise<void> {
  const base: Record<string, unknown> = {
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    trigger: 'cron',
    channel,
    post: result.post,
    errors: result.errors,
    sendResult,
  };

  if (mode !== 'managed' && 'draft' in result) {
    const pipelineResult = result as PipelineResult;
    const rewrote =
      !pipelineResult.review.toLowerCase().startsWith('хорошо') &&
      !!pipelineResult.post &&
      pipelineResult.post !== pipelineResult.draft;
    Object.assign(base, {
      rssContext: pipelineResult.rssContext,
      webContext: pipelineResult.webContext,
      selectedTopics: pipelineResult.selectedTopics,
      draft: pipelineResult.draft,
      review: pipelineResult.review,
      reviewVerdict: pipelineResult.review.split('\n')[0].trim(),
      rewrote,
      timing: pipelineResult.timing,
    });
  }

  await store.setJSON('latest-result', base);
}

export const config: Config = {
  // Every Wednesday at 16:00 UTC (18:00 Warsaw). Bi-weekly cadence is enforced
  // by the day-of-month gate above — cron OR-semantics make `1-7,15-21 * 3`
  // fire ~17x/month instead of the intended 2x.
  schedule: '0 16 * * 3',
};
