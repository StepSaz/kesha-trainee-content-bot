import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { generatePipelinePost } from '../../src/lib/pipeline.js';
import { generateManagedPost } from '../../src/lib/managed-agent.js';
import { sendToChannel } from '../../src/lib/telegram.js';

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

  // Channel selection: KESHA_CRON_CHANNEL=test → test channel, anything else → prod
  const cronChannel = process.env.KESHA_CRON_CHANNEL ?? 'main';
  const chatId = cronChannel === 'test'
    ? process.env.TELEGRAM_TEST_CHAT_ID
    : process.env.TELEGRAM_CHAT_ID;

  const mode = process.env.KESHA_MODE ?? 'pipeline';
  console.log(`[kesha-post] mode=${mode} channel=${cronChannel}`);

  const store = getStore('kesha');
  await store.setJSON('latest-result', {
    status: 'running',
    startedAt: new Date().toISOString(),
    trigger: 'cron',
    mode,
    channel: cronChannel,
  });

  try {
    async function run() {
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
      await store.setJSON('latest-result', {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        trigger: 'cron',
        mode,
        channel: cronChannel,
        errors: result.errors,
        timing: result.timing,
        draft: result.draft,
        review: result.review,
        selectedTopics: result.selectedTopics,
        webContext: result.webContext,
        rssContext: result.rssContext,
      });
      return new Response('failed', { status: 500 });
    }

    const sendResult = await sendToChannel(result.post!, chatId);

    if (!sendResult.success) {
      console.error('[kesha-post] telegram send failed:', sendResult.error);
      await store.setJSON('latest-result', {
        status: 'telegram-failed',
        finishedAt: new Date().toISOString(),
        trigger: 'cron',
        mode,
        channel: cronChannel,
        post: result.post,
        errors: [sendResult.error ?? 'telegram error'],
        timing: result.timing,
      });
      return new Response('telegram failed', { status: 500 });
    }

    await store.setJSON('latest-result', {
      status: 'ok',
      finishedAt: new Date().toISOString(),
      trigger: 'cron',
      mode,
      channel: cronChannel,
      rssContext: result.rssContext,
      webContext: result.webContext,
      selectedTopics: result.selectedTopics,
      draft: result.draft,
      review: result.review,
      rewrote: !result.review.toLowerCase().startsWith('хорошо') && !!result.post && result.post !== result.draft,
      post: result.post,
      timing: result.timing,
      sendResult,
    });

    console.log(`[kesha-post] posted! messageId=${sendResult.messageId}`);
    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('[kesha-post] unexpected error:', err);
    await store.setJSON('latest-result', {
      status: 'error',
      finishedAt: new Date().toISOString(),
      trigger: 'cron',
      mode,
      channel: cronChannel,
      errors: [String(err)],
    });
    return new Response('error', { status: 500 });
  }
};

export const config: Config = {
  // Every Wednesday at 16:00 UTC (18:00 Warsaw). Bi-weekly cadence is enforced
  // by the day-of-month gate above — cron OR-semantics make `1-7,15-21 * 3`
  // fire ~17x/month instead of the intended 2x.
  // TEMP TEST: 40 21 * * 3 — fires today 2026-04-15 at 21:40 UTC for staging validation.
  // Reset to `0 16 * * 3` after test passes.
  schedule: '40 21 * * 3',
};
