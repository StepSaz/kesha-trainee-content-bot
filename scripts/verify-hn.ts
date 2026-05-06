/**
 * E2E dry-run for the gather step.
 *
 * Hits the real shir-man HN API + priority RSS feeds, parses, formats,
 * and simulates the fallback decision (would web search be triggered?).
 * Does NOT call Claude — safe to run repeatedly.
 *
 *   npm run verify:hn           # real network
 *   npm run verify:hn -- --mock # offline demo with sample data
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { fetchSourceContext } from '../src/lib/sources.js';

interface SourcesConfig {
  hackernews_api: { url: string; max_items: number; fallback_threshold?: number; keywords?: string[] };
  priority_sources?: string[];
}

const MOCK_HN_FEED = {
  sortMode: 'week',
  hackerNews: [
    { id: 1, url: 'https://www.anthropic.com/news/claude-4', title: 'Anthropic releases Claude 4', agg_score: 2100, ai_summary: { tldr: 'Anthropic launched Claude 4, claiming major reasoning and coding improvements over Claude 3.' } },
    { id: 2, url: 'https://openai.com/blog/gpt-5-preview', title: 'OpenAI previews GPT-5 multimodal capabilities', agg_score: 1850, ai_summary: { tldr: 'GPT-5 preview shows real-time video understanding and improved instruction following.' } },
    { id: 3, url: 'https://cursor.sh/blog/agent-mode', title: 'Cursor ships Agent Mode with background tasks', agg_score: 1200, ai_summary: { tldr: 'Cursor IDE can now run multi-step background tasks autonomously without user intervention.' } },
    { id: 4, url: 'https://techcrunch.com/2026/05/06/google-gemini-update', title: 'Google Gemini 2.0 Ultra benchmark results', agg_score: 980, ai_summary: { tldr: 'Gemini 2.0 Ultra tops several coding and math benchmarks, beats GPT-4o on MMLU.' } },
    { id: 5, url: 'https://example.com/sourdough', title: "My grandmother's sourdough recipe", agg_score: 200, ai_summary: { tldr: 'A weekend baking project.' } },
  ],
};

const MOCK_RSS_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Anthropic Blog</title>
  <item><title>Claude 4 system card</title><link>https://www.anthropic.com/news/claude-4-system-card</link></item>
  <item><title>Responsible scaling policy update</title><link>https://www.anthropic.com/news/rsp-update</link></item>
</channel></rss>`;

function installMockFetch() {
  let callCount = 0;
  (globalThis as Record<string, unknown>).fetch = async (url: string) => {
    callCount++;
    console.log(`  [mock fetch #${callCount}] ${url}`);
    if (String(url).includes('shir-man')) {
      return { json: async () => MOCK_HN_FEED, text: async () => '' };
    }
    return { json: async () => ({}), text: async () => MOCK_RSS_XML };
  };
}

async function main() {
  const mock = process.argv.includes('--mock');
  const sourcesPath = join(process.cwd(), 'src/config/sources.json');
  const cfg = JSON.parse(readFileSync(sourcesPath, 'utf-8')) as SourcesConfig;
  const hnCfg = cfg.hackernews_api;
  const rssFeedUrls = cfg.priority_sources ?? [];
  const threshold = hnCfg.fallback_threshold ?? 8;

  console.log(`HN URL: ${hnCfg.url}`);
  console.log(`max_items: ${hnCfg.max_items}, fallback_threshold: ${threshold}, keywords: ${(hnCfg.keywords ?? []).length}`);
  console.log(`RSS feeds (${rssFeedUrls.length}): ${rssFeedUrls.join(', ')}`);
  if (mock) console.log('\n[MOCK MODE — no real network requests]\n');
  else console.log('');

  if (mock) installMockFetch();

  const t0 = Date.now();
  let result: { context: string; itemCount: number };
  try {
    result = await fetchSourceContext();
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`FETCH FAILED in ${ms}ms: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  const ms = Date.now() - t0;
  const { context, itemCount } = result;

  console.log(`\ntotal items (HN + RSS): ${itemCount}`);
  console.log(`fetch + parse + format: ${ms}ms`);
  console.log(`context length: ${context.length} chars`);

  const lines = context.split('\n');
  const tldrCount = lines.filter(l => l.trim().startsWith('TL;DR:')).length;
  const hnSection = context.includes('Hacker News');
  const rssSection = context.includes('Первоисточники');
  console.log(`sections present: HN=${hnSection}, RSS=${rssSection}`);
  console.log(`items with TL;DR summary: ${tldrCount}\n`);

  console.log('--- formatted context (what selectTopics will see) ---');
  console.log(context.slice(0, 2500));
  if (context.length > 2500) console.log(`\n... [truncated, ${context.length - 2500} more chars]`);
  console.log('--- end ---\n');

  const verdict = itemCount < threshold ? 'WILL run' : 'will SKIP';
  console.log(`Fallback decision: itemCount=${itemCount} ${itemCount < threshold ? '<' : '>='} threshold=${threshold} → web search ${verdict}`);

  if (itemCount === 0) {
    console.log('\nWARN: zero items — feed may be empty or keywords too narrow.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('verify-hn unexpected failure:', err);
  process.exit(1);
});
