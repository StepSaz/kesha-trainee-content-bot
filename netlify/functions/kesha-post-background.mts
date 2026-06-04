import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { generatePipelinePost, extractIntro, type PipelineOptions, type PipelineResult } from '../../src/lib/pipeline.js';
import { loadMemory, appendMemory, type MemoryEntry } from '../../src/lib/memory.js';
import { appendPublishedPost } from '../../src/lib/recent-posts.js';
import { generateManagedPost } from '../../src/lib/managed-agent.js';
import { sendToChannel } from '../../src/lib/telegram.js';
import { shouldSuppressCron } from '../../src/lib/cron-guard.js';
import { generateShortDigest, extractShortIntro } from '../../src/lib/short-digest.js';

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
  const digestFormat = process.env.KESHA_DIGEST_FORMAT ?? 'full';
  console.log(`[kesha-post] mode=${mode} format=${digestFormat} channel=${cronChannel}`);

  const store = getStore('kesha');

  try {
    const lastManual = await store.get('digest-last-manual-at', { type: 'json' }) as { publishedAt: string } | null;
    if (shouldSuppressCron(lastManual?.publishedAt ?? null, Date.now())) {
      const ageH = Math.round((Date.now() - new Date(lastManual!.publishedAt).getTime()) / 3600000);
      console.log(`[kesha-post] skipping cron - manual digest published ${ageH}h ago`);
      return new Response('skipped (manual digest)', { status: 200 });
    }
  } catch (err) {
    console.error('[kesha-post] failed to read suppression blob, continuing:', err);
  }

  await store.setJSON('latest-result', {
    status: 'running',
    startedAt: new Date().toISOString(),
    trigger: 'cron',
    mode,
    format: digestFormat,
    channel: cronChannel,
  });

  const memoryEntries = await loadMemory();
  const previousIntros = (await store.get('previous-intros', { type: 'json' }) as string[] | null) ?? [];
  const previousShortIntros = (await store.get('previous-short-intros', { type: 'json' }) as string[] | null) ?? [];
  const pipelineOptions: PipelineOptions = { memoryEntries, previousIntros };

  try {
    async function run() {
      if (mode === 'managed') return generateManagedPost();
      if (digestFormat === 'short') return generateShortDigest({ memoryEntries, previousIntros: previousShortIntros });
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
      rewrote: result.review.verdict !== 'ok' && !!result.post && result.post !== result.draft,
      post: result.post,
      timing: result.timing,
      sendResult,
    });

    console.log(`[kesha-post] posted! messageId=${sendResult.messageId}`);

    await appendPublishedPost(result.post!, sendResult.messageId ?? null);

    if (mode !== 'managed') {
      const pipelineResult = result as PipelineResult;
      const newEntries: MemoryEntry[] = pipelineResult.selectedTopics.topics.map(t => ({
        url: t.sourceUrl,
        title: t.title,
        publishedAt: new Date().toISOString(),
        postId: sendResult.messageId ?? null,
      }));
      await appendMemory(newEntries);

      // Each format keeps its OWN intro anti-repetition list (different greeting shape).
      if (digestFormat === 'short') {
        const newShortIntros = [...previousShortIntros, extractShortIntro(result.post!)].slice(-10);
        await store.setJSON('previous-short-intros', newShortIntros);
      } else {
        const newIntro = extractIntro(result.post!);
        const newIntros = [...previousIntros, newIntro].slice(-10);
        await store.setJSON('previous-intros', newIntros);
      }
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
