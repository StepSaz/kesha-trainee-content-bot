import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { generatePipelinePost } from '../../src/lib/pipeline.js';
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
    let result;
    if (mode === 'managed') {
      result = await generateManagedPost();
    } else {
      result = await generatePipelinePost();
    }

    let sendResult = null;
    if (result.success && chatId) {
      sendResult = await sendToChannel(result.post!, chatId);
    }

    await store.setJSON('latest-result', {
      status: result.success ? 'ok' : 'failed',
      finishedAt: new Date().toISOString(),
      mode,
      post: result.post,
      errors: result.errors,
      timing: (result as { timing?: Record<string, number> }).timing,
      sendResult,
    });

    console.log('[kesha-test] done, success=', result.success);
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
