import type { Config } from '@netlify/functions';
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

  console.log(`[kesha-test] started mode=${mode} channel=${channel} chatId=${chatId}`);

  try {
    let result;
    if (mode === 'managed') {
      result = await generateManagedPost();
    } else {
      result = await generatePipelinePost();
    }

    if (result.success) {
      const sendResult = await sendToChannel(result.post!, chatId);
      console.log('[kesha-test] sent:', JSON.stringify(sendResult));
    }

    console.log('[kesha-test] result:', JSON.stringify({
      success: result.success,
      errors: result.errors,
      timing: (result as { timing?: Record<string, number> }).timing,
      postPreview: result.post?.slice(0, 200),
    }));
  } catch (err) {
    console.error('[kesha-test] error:', err);
  }

  return new Response(null, { status: 202 });
};

export const config: Config = {};
