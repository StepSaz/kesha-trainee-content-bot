import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { generatePipelinePost, type PipelineResult, type PipelineOptions } from '../../src/lib/pipeline.js';
import { loadMemory } from '../../src/lib/memory.js';
import { generateManagedPost } from '../../src/lib/managed-agent.js';
import { sendToChannel } from '../../src/lib/telegram.js';

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  const mode = url.searchParams.get('mode') ?? process.env.KESHA_MODE ?? 'pipeline';
  const channel = url.searchParams.get('channel') ?? 'test';

  if (!secret || secret !== process.env.TEST_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const chatId = channel === 'main'
    ? process.env.TELEGRAM_CHAT_ID
    : process.env.TELEGRAM_TEST_CHAT_ID;

  const store = getStore('kesha');
  await store.setJSON('latest-result', { status: 'running', startedAt: new Date().toISOString(), mode });

  console.log(`[kesha-test] started mode=${mode} channel=${channel}`);

  try {
    let sendResult = null;

    if (mode === 'managed') {
      const result = await generateManagedPost();
      if (result.success && chatId) {
        sendResult = await sendToChannel(result.post!, chatId);
      }
      await store.setJSON('latest-result', {
        status: result.success ? 'ok' : 'failed',
        finishedAt: new Date().toISOString(),
        mode,
        channel,
        post: result.post,
        errors: result.errors,
        sendResult,
      });
    } else {
      const memoryEntries = await loadMemory();
      const previousIntros = (await store.get('previous-intros', { type: 'json' }) as string[] | null) ?? [];
      const testOptions: PipelineOptions = { memoryEntries, previousIntros };
      const result: PipelineResult = await generatePipelinePost(testOptions);
      if (result.success && chatId) {
        sendResult = await sendToChannel(result.post!, chatId);
      }

      const rewrote = result.review.verdict !== 'ok' && !!result.post && result.post !== result.draft;

      await store.setJSON('latest-result', {
        status: result.success ? 'ok' : 'failed',
        finishedAt: new Date().toISOString(),
        mode,
        channel,
        // pipeline debug data
        hnContext: result.hnContext,
        webContext: result.webContext,
        selectedTopics: result.selectedTopics,
        draft: result.draft,
        review: result.review,
        reviewVerdict: result.review.verdict,
        rewrote,
        post: result.post,
        errors: result.errors,
        timing: result.timing,
        sendResult,
      });
    }

    console.log('[kesha-test] done');
  } catch (err) {
    await store.setJSON('latest-result', {
      status: 'error',
      finishedAt: new Date().toISOString(),
      mode,
      errors: [String(err)],
    });
    console.error('[kesha-test] error:', err);
  }

  return new Response(null, { status: 202 });
};

export const config: Config = {};
