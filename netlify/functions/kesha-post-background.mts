import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { generatePipelinePost, extractIntro, type PipelineOptions, type PipelineResult } from '../../src/lib/pipeline.js';
import { generateManagedPost } from '../../src/lib/managed-agent.js';
import { sendToChannel } from '../../src/lib/telegram.js';

export default async (): Promise<Response> => {
  if (process.env.KESHA_ENABLED !== 'true') {
    console.log('[kesha-post] KESHA_ENABLED != true — skipping');
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

  const publishedTopics = (await store.get('published-topics', { type: 'json' }) as string[] | null) ?? [];
  const previousIntros = (await store.get('previous-intros', { type: 'json' }) as string[] | null) ?? [];
  const pipelineOptions: PipelineOptions = { publishedTopics, previousIntros };

  try {
    async function run() {
      if (mode === 'managed') return generateManagedPost();
      return generatePipelinePost(pipelineOptions);
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
        hnContext: result.hnContext,
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
      hnContext: result.hnContext,
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

    if (mode !== 'managed') {
      const pipelineResult = result as PipelineResult;
      const newTopics = [...publishedTopics, pipelineResult.selectedTopics].slice(-4);
      await store.setJSON('published-topics', newTopics);

      const newIntro = extractIntro(result.post!);
      const newIntros = [...previousIntros, newIntro].slice(-10);
      await store.setJSON('previous-intros', newIntros);
    }

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
  // Every Thursday at 14:00 UTC (16:00 Warsaw / CEST).
  schedule: '0 14 * * 4',
};
