export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export type TavilySearchDepth = 'basic' | 'advanced';
export type TavilyTopic = 'general' | 'news' | 'finance';
export type TavilyTimeRange = 'day' | 'week' | 'month' | 'year';

export interface TavilySearchOptions {
  maxResults?: number;
  depth?: TavilySearchDepth;
  // 'news' is recommended for time-sensitive AI/tech announcement queries
  // (Tavily best practices, references/search.md).
  topic?: TavilyTopic;
  // Drop results older than this. Cuts noise when readers ask about
  // recent announcements / things "shown yesterday".
  timeRange?: TavilyTimeRange;
  // Only effective on 'advanced'/'fast' depths. Default Tavily=3, max=5.
  // We default to 5 to maximise content per credit when running 'advanced'.
  chunksPerSource?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  // Post-filter: drop results with semantic relevance score below this.
  // 0.4 strips obvious off-topic hits without being too aggressive.
  minScore?: number;
}

const QUERY_MAX_CHARS = 400;

export async function tavilySearch(
  query: string,
  optionsOrMaxResults: number | TavilySearchOptions = 5,
): Promise<TavilyResult[]> {
  const opts: TavilySearchOptions =
    typeof optionsOrMaxResults === 'number'
      ? { maxResults: optionsOrMaxResults }
      : optionsOrMaxResults;
  const maxResults = opts.maxResults ?? 5;
  const depth: TavilySearchDepth = opts.depth ?? 'basic';
  const minScore = opts.minScore;

  // Tavily best-practice cap; longer queries degrade relevance.
  const safeQuery = query.length > QUERY_MAX_CHARS ? query.slice(0, QUERY_MAX_CHARS) : query;
  if (query.length > QUERY_MAX_CHARS) {
    console.warn(`[tavily] query truncated ${query.length}→${QUERY_MAX_CHARS} chars`);
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('[tavily] TAVILY_API_KEY not set — skipping search');
    return [];
  }

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query: safeQuery,
    search_depth: depth,
    max_results: maxResults,
  };
  if (opts.topic) body.topic = opts.topic;
  if (opts.timeRange) body.time_range = opts.timeRange;
  if (opts.chunksPerSource && (depth === 'advanced' || depth === 'fast' as TavilySearchDepth)) {
    body.chunks_per_source = opts.chunksPerSource;
  }
  if (opts.includeDomains && opts.includeDomains.length > 0) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains && opts.excludeDomains.length > 0) body.exclude_domains = opts.excludeDomains;

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error('[tavily] search failed:', res.status, await res.text());
      return [];
    }

    const data = await res.json() as { results?: TavilyResult[] };
    let results = data.results ?? [];
    const beforeFilter = results.length;
    if (minScore !== undefined) {
      results = results.filter(r => (r.score ?? 0) >= minScore);
    }
    console.log(
      `[tavily] query="${safeQuery}" depth=${depth} topic=${opts.topic ?? 'general'} ` +
      `time=${opts.timeRange ?? 'all'} results=${results.length}` +
      (minScore !== undefined ? ` (filtered from ${beforeFilter} by score>=${minScore})` : '')
    );
    return results;
  } catch (err) {
    console.error('[tavily] search error:', err);
    return [];
  }
}

const EXTRACT_MAX_CHARS = 3000;
const EXTRACT_TIMEOUT_MS = 10_000;

export async function tavilyExtract(url: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('[tavily] TAVILY_API_KEY not set — skipping extract');
    return '';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, urls: [url] }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error('[tavily] extract failed:', res.status, await res.text());
      return '';
    }

    const data = await res.json() as { results?: { url: string; raw_content?: string }[] };
    const raw = data.results?.[0]?.raw_content ?? '';
    const trimmed = raw.slice(0, EXTRACT_MAX_CHARS);
    console.log(`[tavily] extract url=${url} chars=${trimmed.length}`);
    return trimmed;
  } catch (err) {
    console.error('[tavily] extract error:', err);
    return '';
  } finally {
    clearTimeout(timeout);
  }
}
