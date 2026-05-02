import { readFileSync } from 'fs';
import { join } from 'path';

interface HackerNewsItem {
  id?: number;
  url?: string;
  title?: string;
  rank?: number;
  agg_score?: number;
  score?: number;
  descendants?: number;
  ai_summary?: { tldr?: string };
}

interface FeedResponse {
  generatedAt?: string;
  algoVersion?: string;
  sortMode?: string;
  hackerNews?: HackerNewsItem[];
}

interface SourcesConfig {
  hackernews_api: {
    url: string;
    max_items: number;
    keywords?: string[];
  };
}

function matchesKeywords(item: HackerNewsItem, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const haystack = `${item.title ?? ''} ${item.ai_summary?.tldr ?? ''}`.toLowerCase();
  return keywords.some(kw => haystack.includes(kw.toLowerCase()));
}

export async function fetchHackerNewsContext(): Promise<string> {
  const sourcesPath = join(process.cwd(), 'src/config/sources.json');
  const { hackernews_api: cfg } = JSON.parse(readFileSync(sourcesPath, 'utf-8')) as SourcesConfig;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(cfg.url, { signal: controller.signal });
    clearTimeout(timeout);

    const data = await response.json() as FeedResponse;
    const items = data.hackerNews ?? [];

    const keywords = cfg.keywords ?? [];
    const filtered = items
      .filter(item => matchesKeywords(item, keywords))
      .sort((a, b) => (b.agg_score ?? 0) - (a.agg_score ?? 0))
      .slice(0, cfg.max_items);

    if (filtered.length === 0) return '';

    const formatted = filtered.map((item, i) => {
      const tldr = item.ai_summary?.tldr?.trim();
      const meta = `score=${item.score ?? 0}, comments=${item.descendants ?? 0}, agg=${item.agg_score ?? 0}`;
      const summary = tldr ? `\n   TL;DR: ${tldr}` : '';
      return `${i + 1}. ${item.title ?? 'No title'} (${meta})\n   ${item.url ?? ''}${summary}`;
    }).join('\n\n');

    return `Тренды из Hacker News (shir-man feed, sort=${data.sortMode ?? 'week'}):\n${formatted}`;
  } catch (err) {
    console.log(`[hackernews] Fetch failed: ${err}`);
    return '';
  }
}
