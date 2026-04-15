import type { Config } from '@netlify/functions';
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
  // Every Wednesday at 16:00 UTC (18:00 Warsaw). Bi-weekly cadence is enforced
  // by the day-of-month gate above — cron OR-semantics make `1-7,15-21 * 3`
  // fire ~17x/month instead of the intended 2x.
  schedule: '0 16 * * 3',
};
