import { readFileSync } from 'fs';
import { join } from 'path';
import { getStore } from '@netlify/blobs';
import { XMLParser } from 'fast-xml-parser';
import { callClaude } from './claude.js';

// ── URL Normalization & Filtering helpers ──────────────────────────────────────

export function normalizeUrl(url: string): string {
  if (!url) return '';
  const raw = url.trim();
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
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
    return raw.toLowerCase();
  }
}

function isExcluded(url: string | undefined, excludeUrls?: Set<string>): boolean {
  if (!url || !excludeUrls) return false;
  return excludeUrls.has(normalizeUrl(url));
}

// ── Freshness helpers ─────────────────────────────────────────────────────────

/**
 * Returns now - days, normalized to start-of-day UTC.
 */
export function getCutoffDate(days = 7, now: Date = new Date()): Date {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Returns true iff date is valid and its UTC day is within [cutoff, upper].
 * When `upper` is omitted only the lower bound is enforced (back-compat).
 * null or invalid date => false (NOT fresh).
 */
export function isFreshDate(date: Date | null, cutoff: Date, upper?: Date): boolean {
  if (!date || Number.isNaN(date.getTime())) return false;
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (d.getTime() < cutoff.getTime()) return false;
  if (upper) {
    const u = new Date(Date.UTC(upper.getUTCFullYear(), upper.getUTCMonth(), upper.getUTCDate()));
    if (d.getTime() > u.getTime()) return false;
  }
  return true;
}

/**
 * Extracts publication date from a parsed RSS/Atom item.
 * Handles pubDate (RSS), published/updated (Atom), dc:date.
 * Coerces { '#text': '...' } objects to their text value.
 * Returns Date | null.
 */
export function extractPublishedDateFromRssItem(item: Record<string, unknown>): Date | null {
  const fields = ['pubDate', 'published', 'updated', 'dc:date'];
  for (const field of fields) {
    let raw = item[field];
    if (raw === undefined || raw === null) continue;
    // Coerce { '#text': '...' } to its string
    if (typeof raw === 'object' && raw !== null && '#text' in (raw as Record<string, unknown>)) {
      raw = (raw as Record<string, unknown>)['#text'];
    }
    if (typeof raw !== 'string') continue;
    const str = raw.trim();
    if (!str) continue;
    const d = new Date(str);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Extracts publication date from HTML.
 * Checks: JSON-LD datePublished (incl @graph; NOT dateModified — see note below),
 * meta property/name article:published_time | datePublished | date | pubdate,
 * <time datetime="...">.
 * Best-effort — any error returns null.
 */
export function extractPublishedDateFromHtml(html: string): Date | null {
  try {
    // 1. JSON-LD blocks
    const ldJsonRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = ldJsonRegex.exec(html)) !== null) {
      try {
        const parsed = JSON.parse(match[1]) as unknown;
        const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        // Also check @graph array
        for (const node of candidates) {
          if (typeof node !== 'object' || node === null) continue;
          const obj = node as Record<string, unknown>;
          // Check @graph
          if (Array.isArray(obj['@graph'])) {
            for (const graphNode of obj['@graph'] as unknown[]) {
              if (typeof graphNode !== 'object' || graphNode === null) continue;
              const gn = graphNode as Record<string, unknown>;
              // Only datePublished — NOT dateModified. A re-edited evergreen article gets a
              // fresh dateModified, which would wrongly certify old content as weekly news.
              for (const key of ['datePublished']) {
                if (typeof gn[key] === 'string') {
                  const d = new Date(gn[key] as string);
                  if (!Number.isNaN(d.getTime())) return d;
                }
              }
            }
          }
          // datePublished only (see note above re: dateModified false-fresh).
          for (const key of ['datePublished']) {
            if (typeof obj[key] === 'string') {
              const d = new Date(obj[key] as string);
              if (!Number.isNaN(d.getTime())) return d;
            }
          }
        }
      } catch {
        // skip invalid JSON-LD block
      }
    }

    // 2. Meta tags — property OR name, in either attribute order
    // Matches <meta property="..." content="..."> or <meta name="..." content="..."> or reversed
    const metaKeys = ['article:published_time', 'datePublished', 'date', 'pubdate'];
    // Regex: capture meta tag with content attribute
    const metaRegex = /<meta\s+(?:[^>]*?\s+)?(?:property|name)=["']([^"']+)["'][^>]*?content=["']([^"']+)["'][^>]*?>|<meta\s+(?:[^>]*?\s+)?content=["']([^"']+)["'][^>]*?(?:property|name)=["']([^"']+)["'][^>]*?>/gi;
    while ((match = metaRegex.exec(html)) !== null) {
      const keyA = match[1];
      const valueA = match[2];
      const valueB = match[3];
      const keyB = match[4];

      const key = (keyA ?? keyB ?? '').toLowerCase();
      const value = valueA ?? valueB ?? '';

      if (metaKeys.some(mk => mk.toLowerCase() === key) && value) {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }

    // 3. <time datetime="...">
    const timeRegex = /<time[^>]+datetime=["']([^"']+)["']/gi;
    while ((match = timeRegex.exec(html)) !== null) {
      const d = new Date(match[1]);
      if (!Number.isNaN(d.getTime())) return d;
    }

    return null;
  } catch {
    return null;
  }
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
  time?: number;
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

async function fetchArticleDate(url: string): Promise<Date | null> {
  try {
    const resp = await fetchWithTimeout(url, 6000);
    if (!resp.ok) return null;
    return extractPublishedDateFromHtml(await resp.text());
  } catch {
    return null;
  }
}

async function fetchHN(cfg: HNConfig, excludeUrls?: Set<string>, cutoff?: Date): Promise<{ lines: string[]; urls: string[] }> {
  const resp = await fetchWithTimeout(cfg.url);
  const data = await resp.json() as HNFeedResponse;

  const items = data.hackerNews ?? [];
  const keywords = cfg.keywords ?? [];

  // Stage 1: keyword filter + excludeUrls + HN date filter (time field)
  const stage1 = items
    .filter(item => matchesKeywords(item, keywords))
    .filter(item => {
      if (!cutoff) return true;
      if (typeof item.time !== 'number') return false;
      return isFreshDate(new Date(item.time * 1000), cutoff);
    })
    .sort((a, b) => (b.agg_score ?? 0) - (a.agg_score ?? 0))
    .filter(item => !isExcluded(item.url, excludeUrls))
    .slice(0, cfg.max_items);

  if (stage1.length === 0) return { lines: [], urls: [] };

  // NOTE: slice-to-max_items happens BEFORE article-date verification, so if many of the
  // top items turn out to be stale-dated articles, the result can be < max_items (and the
  // next-best fresh items below the slice are not pulled up). Accepted tradeoff: stage-1
  // HN-time filtering already removes most stale items, and RSS + light-web still supply topics.

  // Stage 2: fetch article dates in parallel for items that passed stage 1
  let articleDates: Array<Date | null> = stage1.map(() => null);
  if (cutoff) {
    articleDates = await Promise.all(
      stage1.map(item => item.url ? fetchArticleDate(item.url) : Promise.resolve(null))
    );
  }

  const lines: string[] = [];
  const urls: string[] = [];
  let lineNum = 0;

  for (let i = 0; i < stage1.length; i++) {
    const item = stage1[i];
    const articleDate = articleDates[i];

    // Drop if article date is known and stale
    if (cutoff && articleDate !== null && !isFreshDate(articleDate, cutoff)) {
      continue;
    }

    lineNum++;
    const tldr = item.ai_summary?.tldr?.trim();
    const summary = tldr ? `\n   TL;DR: ${tldr}` : '';

    let dateLine = '';
    if (cutoff && articleDate === null && typeof item.time === 'number') {
      // Unknown article date — annotate with HN date
      const hnDate = new Date(item.time * 1000);
      const hnDateStr = hnDate.toISOString().slice(0, 10);
      dateLine = `\n   Source date: unknown; HN date: ${hnDateStr}`;
    }

    lines.push(`${lineNum}. ${item.title ?? 'No title'}\n   ${item.url ?? ''}${summary}${dateLine}`);
    if (item.url) urls.push(item.url);
  }

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

async function fetchRss(feedUrl: string, excludeUrls?: Set<string>, cutoff?: Date): Promise<{ lines: string[]; urls: string[] }> {
  const resp = await fetchWithTimeout(feedUrl);
  const xml = await resp.text();
  const parsed = xmlParser.parse(xml);

  // RSS 2.0: parsed.rss.channel.item  // Atom: parsed.feed.entry
  const rawItems: unknown[] = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const lines: string[] = [];
  const urls: string[] = [];
  let droppedCount = 0;

  for (const item of items) {
    const it = item as Record<string, unknown>;
    const title = extractTitle(it.title);
    const link = extractLink(it.link);
    if (title && link) {
      if (isExcluded(link, excludeUrls)) {
        continue;
      }

      // Date freshness filter
      if (cutoff) {
        const pubDate = extractPublishedDateFromRssItem(it);
        if (!isFreshDate(pubDate, cutoff)) {
          droppedCount++;
          continue;
        }
      }

      lines.push(`- ${title}\n  ${link}`);
      urls.push(link);
      if (lines.length >= 5) break;
    }
  }

  if (droppedCount > 0) {
    console.log(`[sources] RSS ${feedUrl}: dropped ${droppedCount} stale/undated`);
  }

  return { lines, urls };
}

// ── Blob cache (1 h TTL, degrades gracefully outside Netlify context) ────────

const CACHE_KEY = 'source-cache';
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 1;

interface CacheEntry {
  result: SourceContext;
  fetchedAt: string;
  schemaVersion?: number;
  cutoffDate?: string;
}

async function readCache(excludeUrls?: Set<string>): Promise<SourceContext | null> {
  if (excludeUrls && excludeUrls.size > 0) return null;
  try {
    const store = getStore('kesha');
    const entry = await store.get(CACHE_KEY, { type: 'json' }) as CacheEntry | null;
    if (!entry) return null;
    if (Date.now() - new Date(entry.fetchedAt).getTime() > CACHE_TTL_MS) return null;
    // Schema version + cutoff date validation
    const cutoffStr = getCutoffDate().toISOString().slice(0, 10);
    if (entry.schemaVersion !== CACHE_SCHEMA_VERSION || entry.cutoffDate !== cutoffStr) return null;
    return entry.result;
  } catch {
    return null;
  }
}

async function writeCache(result: SourceContext, excludeUrls?: Set<string>): Promise<void> {
  if (excludeUrls && excludeUrls.size > 0) return;
  try {
    const store = getStore('kesha');
    const cutoffStr = getCutoffDate().toISOString().slice(0, 10);
    await store.setJSON(CACHE_KEY, {
      result,
      fetchedAt: new Date().toISOString(),
      schemaVersion: CACHE_SCHEMA_VERSION,
      cutoffDate: cutoffStr,
    } satisfies CacheEntry);
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

  const cutoff = getCutoffDate();

  const [hn, rssSettled] = await Promise.all([
    fetchHN(cfg.hackernews_api, excludeUrls, cutoff).catch((err) => {
      console.warn('[sources] HN fetch failed:', err);
      return { lines: [] as string[], urls: [] as string[] };
    }),
    Promise.allSettled(rssFeedUrls.map(url => fetchRss(url, excludeUrls, cutoff))),
  ]);

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
  // Single source of truth for the 7-day window (shared with HN/RSS paths).
  const cutoffDate = getCutoffDate(7, now);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

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
    const fresh = items.filter(item =>
      item &&
      item.date &&
      item.headline &&
      item.url &&
      isFreshDate(new Date(item.date), cutoffDate, now)
    );
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
