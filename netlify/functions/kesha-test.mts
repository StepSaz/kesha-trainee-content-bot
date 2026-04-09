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

  console.log(`[kesha-test] mode=${mode} channel=${channel} chatId=${chatId}`);

  let result;
  try {
    if (mode === 'managed') {
      result = await generateManagedPost();
    } else {
      result = await generatePipelinePost();
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: String(err) }, null, 2),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let sendResult = null;
  if (result.success) {
    sendResult = await sendToChannel(result.post!, chatId);
  }

  return new Response(
    JSON.stringify({ ...result, sendResult }, null, 2),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export const config: Config = {};
