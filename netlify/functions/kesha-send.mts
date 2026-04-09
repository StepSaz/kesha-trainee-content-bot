import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { sendToChannel } from '../../src/lib/telegram.js';

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  const channel = url.searchParams.get('channel') ?? 'main';

  if (!secret || secret !== process.env.TEST_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const store = getStore('kesha');
  const result = await store.get('latest-result', { type: 'json' }) as { post?: string } | null;

  if (!result?.post) {
    return new Response(JSON.stringify({ error: 'No post available' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const chatId = channel === 'main'
    ? process.env.TELEGRAM_CHAT_ID
    : process.env.TELEGRAM_TEST_CHAT_ID;

  const sendResult = await sendToChannel(result.post, chatId);

  return new Response(JSON.stringify(sendResult), {
    status: sendResult.success ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config: Config = {};
