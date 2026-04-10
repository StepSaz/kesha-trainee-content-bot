import type { Config } from '@netlify/functions';
import { generatePipelinePost } from '../../src/lib/pipeline.js';
import { generateManagedPost } from '../../src/lib/managed-agent.js';
import { sendToChannel } from '../../src/lib/telegram.js';

export default async (): Promise<Response> => {
  if (process.env.KESHA_ENABLED !== 'true') {
    console.log('[kesha-post] KESHA_ENABLED != true — skipping');
    return new Response('skipped', { status: 200 });
  }

  const mode = process.env.KESHA_MODE ?? 'pipeline';
  console.log(`[kesha-post] mode=${mode}`);

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
    return new Response('failed', { status: 500 });
  }

  const sendResult = await sendToChannel(result.post!);

  if (!sendResult.success) {
    console.error('[kesha-post] telegram send failed:', sendResult.error);
    return new Response('telegram failed', { status: 500 });
  }

  console.log(`[kesha-post] posted! messageId=${sendResult.messageId}`);
  return new Response('ok', { status: 200 });
};

export const config: Config = {
  schedule: '0 16 1-7,15-21 * 3',
};
