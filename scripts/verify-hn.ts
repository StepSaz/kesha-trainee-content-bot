/**
 * E2E dry-run for the gather step.
 *
 * Hits the real shir-man HN API, parses, formats, and simulates the
 * fallback decision (would web search be triggered?). Does NOT call
 * Claude — safe to run repeatedly.
 *
 *   npm run verify:hn
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { fetchHackerNewsContext } from '../src/lib/hackernews.js';

interface SourcesConfig {
  hackernews_api: { url: string; max_items: number; fallback_threshold?: number; keywords?: string[] };
}

async function main() {
  const sourcesPath = join(process.cwd(), 'src/config/sources.json');
  const { hackernews_api: cfg } = JSON.parse(readFileSync(sourcesPath, 'utf-8')) as SourcesConfig;
  const threshold = cfg.fallback_threshold ?? 8;

  console.log(`URL: ${cfg.url}`);
  console.log(`max_items: ${cfg.max_items}, fallback_threshold: ${threshold}, keywords: ${(cfg.keywords ?? []).length}\n`);

  const t0 = Date.now();
  let result: { context: string; itemCount: number };
  try {
    result = await fetchHackerNewsContext();
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`HN FETCH FAILED in ${ms}ms: ${err instanceof Error ? err.message : err}`);
    console.log('→ pipeline would FALL BACK to web search');
    process.exit(2);
  }

  const ms = Date.now() - t0;
  const { context, itemCount } = result;

  console.log(`itemCount after AI-keyword filter: ${itemCount}`);
  console.log(`fetch + parse + format: ${ms}ms`);
  console.log(`context length: ${context.length} chars`);

  const lines = context.split('\n');
  const tldrCount = lines.filter(l => l.trim().startsWith('TL;DR:')).length;
  console.log(`items with TL;DR summary: ${tldrCount} / ${itemCount}\n`);

  console.log('--- formatted context (head, what selectTopics will see) ---');
  console.log(context.slice(0, 1500));
  if (context.length > 1500) console.log(`... [truncated, ${context.length - 1500} more chars]`);
  console.log('--- end ---\n');

  const verdict = itemCount < threshold ? 'WILL run' : 'will SKIP';
  console.log(`Fallback decision: itemCount=${itemCount} ${itemCount < threshold ? '<' : '>='} threshold=${threshold} → web search ${verdict}`);

  if (itemCount === 0) {
    console.log('\nWARN: zero items after filter — keywords may be too narrow or feed is empty.');
    process.exit(1);
  }
  if (tldrCount === 0) {
    console.log('\nWARN: no TL;DR summaries found — feed schema may have changed.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('verify-hn unexpected failure:', err);
  process.exit(1);
});
