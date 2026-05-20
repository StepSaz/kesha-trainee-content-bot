import { readFileSync } from 'fs';
import { join } from 'path';
import { getStore } from '@netlify/blobs';
import { XMLParser } from 'fast-xml-parser';
import { callClaude } from './claude.js';

// ── URL Normalization & Filtering helpers ──────────────────────────────────────

export function normalizeUrl(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url.trim());
    const paramsToKeep = new URLSearchParams();
    for (const [key, value] of parsed.searchParams.entries()) {
      const lowerKey = key.toLowerCase();
      if (
        !lowerKey.startsWith('utm_') &&
        lowerKey !== 'ref' &&
        lowerKey !== 'source' &&
        lowerKey !== 'ref_src' &&
        lowerKey !== 'referrer' &&
        lowerKey !== 'feature'
      ) {
        paramsToKeep.append(key, value);
      }
    }
    
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) {
      host = host.substring(4);
    }
    
    let pathname = parsed.pathname;
    if (pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    
    const search = paramsToKeep.toString();
    const searchString = search ? `?${search}` : '';
    
    return `${host}${pathname}${searchString}`;
  } catch {
    let normalized = url.trim().toLowerCase();
    normalized = normalized.replace(/^https?:\/\//, '');
    normalized = normalized.replace(/^www\./, '');
    const hashIdx = normalized.indexOf('#');
    if (hashIdx !== -1) {
      normalized = normalized.substring(0, hashIdx);
    }
    const queryIdx = normalized.indexOf('?');
    if (queryIdx !== -1) {
      const path = normalized.substring(0, queryIdx);
      const search = normalized.substring(queryIdx + 1);
      const params = search.split('&').filter(p => {
        const key = p.split('=')[0];
        return !key.startsWith('utm_') && key !== 'ref' && key !== 'source';
      }).join('&');
      normalized = path + (params ? `?${params}` : '');
    }
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }
}

function isExcluded(url: string | undefined, excludeUrls?: Set<string>): boolean {
  if (!url || !excludeUrls) return false;
  return excludeUrls.has(normalizeUrl(url));
}

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

async function fetchHN(cfg: HNConfig, excludeUrls?: Set<string>): Promise<{ lines: string[]; urls: string[] }> {
  const resp = await fetchWithTimeout(cfg.url);
  const data = await resp.json() as HNFeedResponse;

  const items = data.hackerNews ?? [];
  const keywords = cfg.keywords ?? [];
  const filtered = items
    .filter(item => matchesKeywords(item, keywords))
    .sort((a, b) => (b.agg_score ?? 0) - (a.agg_score ?? 0));

  const unique = filtered.filter(item => !isExcluded(item.url, excludeUrls));
  const sliced = unique.slice(0, cfg.max_items);

  if (sliced.length === 0) return { lines: [], urls: [] };

  const lines = sliced.map((item, i) => {
    const tldr = item.ai_summary?.tldr?.trim();
    const summary = tldr ? `\n   TL;DR: ${tldr}` : '';
    return `${i + 1}. ${item.title ?? 'No title'}\n   ${item.url ?? ''}${summary}`;
  });

  const urls = sliced.map(item => item.url).filter((u): u is string => !!u);

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

async function fetchRss(feedUrl: string, excludeUrls?: Set<string>): Promise<{ lines: string[]; urls: string[] }> {
  const resp = await fetchWithTimeout(feedUrl);
  const xml = await resp.text();
  const parsed = xmlParser.parse(xml);

  // RSS 2.0: parsed.rss.channel.item  // Atom: parsed.feed.entry
  const rawItems: unknown[] = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const lines: string[] = [];
  const urls: string[] = [];

  for (const item of items) {
    const it = item as Record<string, unknown>;
    const title = extractTitle(it.title);
    const link = extractLink(it.link);
    if (title && link) {
      if (isExcluded(link, excludeUrls)) {
        continue;
      }
      lines.push(`- ${title}\n  ${link}`);
      urls.push(link);
      if (lines.length >= 5) break;
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

function getCacheKey(excludeUrls?: Set<string>): string {
  if (!excludeUrls || excludeUrls.size === 0) return CACHE_KEY;
  const sorted = Array.from(excludeUrls).sort();
  const serialized = sorted.join(',');
  let hash = 0;
  for (let i = 0; i < serialized.length; i++) {
    hash = (hash << 5) - hash + serialized.charCodeAt(i);
    hash |= 0;
  }
  return `${CACHE_KEY}-${hash}`;
}

async function readCache(excludeUrls?: Set<string>): Promise<SourceContext | null> {
  try {
    const store = getStore('kesha');
    const key = getCacheKey(excludeUrls);
    const entry = await store.get(key, { type: 'json' }) as CacheEntry | null;
    if (!entry) return null;
    if (Date.now() - new Date(entry.fetchedAt).getTime() > CACHE_TTL_MS) return null;
    return entry.result;
  } catch {
    return null;
  }
}

async function writeCache(result: SourceContext, excludeUrls?: Set<string>): Promise<void> {
  try {
    const store = getStore('kesha');
    const key = getCacheKey(excludeUrls);
    await store.setJSON(key, { result, fetchedAt: new Date().toISOString() } satisfies CacheEntry);
  } catch {
    // cache write is non-fatal
  }
}

// ── Public fetch function ────────────────────────────────────────────────────

export async function fetchSourceContext(excludeUrls?: Set<string>): Promise<SourceContext> {
  const cached = await readCache(excludeUrls);
  if (cached) {
    console.log('[sources] cache hit');
    return cached;
  }

  const sourcesPath = join(process.cwd(), 'src/config/sources.json');
  const cfg = JSON.parse(readFileSync(sourcesPath, 'utf-8')) as SourcesConfig;
  const rssFeedUrls = (cfg.priority_sources ?? []).filter(s => s.startsWith('http'));

  const hn = await fetchHN(cfg.hackernews_api, excludeUrls);

  const rssSettled = await Promise.allSettled(rssFeedUrls.map(url => fetchRss(url, excludeUrls)));

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

  await writeCache(result, excludeUrls);
  return result;
}

// Backward-compat alias — pipeline.ts currently imports this name.
export const fetchHackerNewsContext = fetchSourceContext;

// ── Light web search ──────────────────────────────────────────────────────────

interface WebNewsItem {
  headline: string;
  url: string;
  date: string; // YYYY-MM-DD
}

export async function fetchLightWebSearch(excludeUrls?: Set<string>): Promise<string> {
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
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const systemPrompt =
    `Today is ${today}. Search for AI news published between ${cutoff} and ${today}.\n` +
    'Return a JSON array only — no other text, no markdown fences. Each element:\n' +
    '  {"headline": "one sentence", "url": "exact URL from search results", "date": "YYYY-MM-DD"}\n' +
    'Rules:\n' +
    `- Only include items with date >= ${cutoff}. Exclude anything older — even if it is relevant.\n` +
    '- Use only URLs that appear in your web search results. Never invent or guess URLs.\n' +
    '- Return an empty array [] if nothing recent enough is found.';

  const allItems: string[] = [];

  // Sequential to avoid hitting the Haiku 50k input tokens/minute rate limit.
  // These still run in parallel with HN fetch (the real latency win).
  for (let i = 0; i < queries.length; i++) {
    const expanded = queries[i]
      .replace('{FROM_DATE}', cutoff)
      .replace('{TO_DATE}', today)
      .replace('{MONTH} {YEAR}', now.toLocaleString('en-US', { month: 'long', year: 'numeric' }));

    const raw = await callClaude({
      systemPrompt,
      userMessage: expanded,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.max_tokens,
      tools: cfg.tools,
    }).catch(err => {
      console.warn(`[sources] light web query ${i + 1} failed:`, err);
      return '';
    });

    if (!raw) continue;

    // Strip markdown fences — Haiku sometimes wraps JSON in code blocks
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();

    let items: WebNewsItem[];
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) {
        console.warn(`[sources] light web query ${i + 1}: response is not an array, skipping`);
        continue;
      }
      items = parsed as WebNewsItem[];
    } catch {
      console.warn(`[sources] light web query ${i + 1}: JSON parse failed, skipping`);
      continue;
    }

    // Programmatic date filter — do not trust the model to self-filter
    const fresh = items.filter(item => item.date && item.headline && item.url && item.date >= cutoff);
    const unique = fresh.filter(item => !isExcluded(item.url, excludeUrls));

    const stale = items.length - fresh.length;
    if (stale > 0) {
      console.log(`[sources] light web query ${i + 1}: dropped ${stale} stale item(s) (before ${cutoff})`);
    }

    const excludedCount = fresh.length - unique.length;
    if (excludedCount > 0) {
      console.log(`[sources] light web query ${i + 1}: programmatically excluded ${excludedCount} duplicate URL(s)`);
    }

    for (const item of unique) {
      allItems.push(`${item.headline}\n${item.url}\n${item.date}`);
    }
  }

  return allItems.join('\n\n');
}
