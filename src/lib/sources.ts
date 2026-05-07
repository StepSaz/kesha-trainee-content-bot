import { readFileSync } from 'fs';
import { join } from 'path';
import { getStore } from '@netlify/blobs';
import { XMLParser } from 'fast-xml-parser';
import { callClaude } from './claude.js';

// ── Config types ─────────────────────────────────────────────────────────────

interface HNConfig {
  url: string;
  max_items: number;
  keywords?: string[];
}

interface SourcesConfig {
  hackernews_api: HNConfig;
  priority_sources?: string[];
}

// ── Public result type ────────────────────────────────────────────────────────

export interface SourceContext {
  context: string;
  itemCount: number;
}

// Backward-compat alias used by pipeline.ts and its tests.
export type HackerNewsResult = SourceContext;

// ── HN feed ──────────────────────────────────────────────────────────────────

interface HNItem {
  url?: string;
  title?: string;
  agg_score?: number;
  ai_summary?: { tldr?: string };
}

interface HNFeedResponse {
  sortMode?: string;
  hackerNews?: HNItem[];
}

function matchesKeywords(item: HNItem, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const haystack = `${item.title ?? ''} ${item.ai_summary?.tldr ?? ''}`.toLowerCase();
  return keywords.some(kw => haystack.includes(kw.toLowerCase()));
}

async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchHN(cfg: HNConfig): Promise<{ lines: string[]; urls: string[] }> {
  const resp = await fetchWithTimeout(cfg.url);
  const data = await resp.json() as HNFeedResponse;

  const items = data.hackerNews ?? [];
  const keywords = cfg.keywords ?? [];
  const filtered = items
    .filter(item => matchesKeywords(item, keywords))
    .sort((a, b) => (b.agg_score ?? 0) - (a.agg_score ?? 0))
    .slice(0, cfg.max_items);

  if (filtered.length === 0) return { lines: [], urls: [] };

  const lines = filtered.map((item, i) => {
    const tldr = item.ai_summary?.tldr?.trim();
    const summary = tldr ? `\n   TL;DR: ${tldr}` : '';
    return `${i + 1}. ${item.title ?? 'No title'}\n   ${item.url ?? ''}${summary}`;
  });

  const urls = filtered.map(item => item.url).filter((u): u is string => !!u);

  return { lines, urls };
}

// ── RSS / Atom fetcher ───────────────────────────────────────────────────────

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function extractLink(linkField: unknown): string {
  if (typeof linkField === 'string') return linkField;
  if (typeof linkField === 'object' && linkField !== null) {
    // Atom: <link href="..." rel="alternate"/>
    const obj = linkField as Record<string, unknown>;
    if (typeof obj['@_href'] === 'string') return obj['@_href'];
    // Array of link elements — take the first alternate
    if (Array.isArray(obj)) {
      for (const l of obj) {
        const link = extractLink(l);
        if (link) return link;
      }
    }
  }
  return '';
}

function extractTitle(titleField: unknown): string {
  if (typeof titleField === 'string') return titleField;
  if (typeof titleField === 'object' && titleField !== null) {
    const obj = titleField as Record<string, unknown>;
    if (typeof obj['#text'] === 'string') return obj['#text'];
  }
  return '';
}

async function fetchRss(feedUrl: string): Promise<{ lines: string[]; urls: string[] }> {
  const resp = await fetchWithTimeout(feedUrl);
  const xml = await resp.text();
  const parsed = xmlParser.parse(xml);

  // RSS 2.0: parsed.rss.channel.item  // Atom: parsed.feed.entry
  const rawItems: unknown[] = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const lines: string[] = [];
  const urls: string[] = [];

  for (const item of items.slice(0, 5)) {
    const it = item as Record<string, unknown>;
    const title = extractTitle(it.title);
    const link = extractLink(it.link);
    if (title && link) {
      lines.push(`- ${title}\n  ${link}`);
      urls.push(link);
    }
  }

  return { lines, urls };
}

// ── Blob cache (1 h TTL, degrades gracefully outside Netlify context) ────────

const CACHE_KEY = 'source-cache';
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  result: SourceContext;
  fetchedAt: string;
}

async function readCache(): Promise<SourceContext | null> {
  try {
    const store = getStore('kesha');
    const entry = await store.get(CACHE_KEY, { type: 'json' }) as CacheEntry | null;
    if (!entry) return null;
    if (Date.now() - new Date(entry.fetchedAt).getTime() > CACHE_TTL_MS) return null;
    return entry.result;
  } catch {
    return null;
  }
}

async function writeCache(result: SourceContext): Promise<void> {
  try {
    const store = getStore('kesha');
    await store.setJSON(CACHE_KEY, { result, fetchedAt: new Date().toISOString() } satisfies CacheEntry);
  } catch {
    // cache write is non-fatal
  }
}

// ── Public fetch function ────────────────────────────────────────────────────

export async function fetchSourceContext(): Promise<SourceContext> {
  const cached = await readCache();
  if (cached) {
    console.log('[sources] cache hit');
    return cached;
  }

  const sourcesPath = join(process.cwd(), 'src/config/sources.json');
  const cfg = JSON.parse(readFileSync(sourcesPath, 'utf-8')) as SourcesConfig;
  const rssFeedUrls = (cfg.priority_sources ?? []).filter(s => s.startsWith('http'));

  const hn = await fetchHN(cfg.hackernews_api);

  const rssSettled = await Promise.allSettled(rssFeedUrls.map(url => fetchRss(url)));

  const rssSections: string[] = [];
  for (let i = 0; i < rssSettled.length; i++) {
    const r = rssSettled[i];
    if (r.status === 'fulfilled' && r.value.lines.length > 0) {
      rssSections.push(`${rssFeedUrls[i]}:\n${r.value.lines.join('\n')}`);
    } else if (r.status === 'rejected') {
      console.warn(`[sources] RSS fetch failed (${rssFeedUrls[i]}):`, r.reason);
    }
  }

  const parts: string[] = [];
  if (hn.lines.length > 0) {
    parts.push(`Тренды из Hacker News (shir-man feed):\n${hn.lines.join('\n\n')}`);
  }
  if (rssSections.length > 0) {
    parts.push(`Первоисточники:\n${rssSections.join('\n\n')}`);
  }

  const rssItemCount = rssSettled
    .filter((r): r is PromiseFulfilledResult<{ lines: string[]; urls: string[] }> => r.status === 'fulfilled')
    .reduce((sum, r) => sum + r.value.lines.length, 0);

  const result: SourceContext = {
    context: parts.join('\n\n---\n\n'),
    itemCount: hn.lines.length + rssItemCount,
  };

  await writeCache(result);
  return result;
}

// Backward-compat alias — pipeline.ts currently imports this name.
export const fetchHackerNewsContext = fetchSourceContext;

// ── Light web search ──────────────────────────────────────────────────────────

export async function fetchLightWebSearch(): Promise<string> {
  const sourcesPath = join(process.cwd(), 'src/config/sources.json');
  const pipelinePath = join(process.cwd(), 'src/config/pipeline.json');
  const sources = JSON.parse(readFileSync(sourcesPath, 'utf-8')) as {
    light_web_queries?: string[];
  };
  const pipeline = JSON.parse(readFileSync(pipelinePath, 'utf-8')) as {
    steps: {
      gatherLightWeb: { model: string; temperature: number; max_tokens: number; tools: string[] };
    };
  };

  const queries = sources.light_web_queries ?? [];
  if (queries.length === 0) return '';

  const cfg = pipeline.steps.gatherLightWeb;
  const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // Sequential to avoid hitting the Haiku 50k input tokens/minute rate limit.
  // These still run in parallel with HN fetch (the real latency win).
  const results: string[] = [];
  for (let i = 0; i < queries.length; i++) {
    const expanded = queries[i].replace('{MONTH} {YEAR}', monthYear);
    const result = await callClaude({
      systemPrompt:
        'Find 5 recent AI news items matching this query. For each item return: headline (one sentence), source URL, publication date. Return plain text, no markdown. Focus on items from the last 7 days.',
      userMessage: expanded,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.max_tokens,
      tools: cfg.tools,
    }).catch(err => {
      console.warn(`[sources] light web query ${i + 1} failed:`, err);
      return '';
    });
    results.push(result);
  }

  return results.filter(Boolean).join('\n\n');
}
