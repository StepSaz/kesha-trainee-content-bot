export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export type TavilySearchDepth = 'basic' | 'advanced';

export interface TavilySearchOptions {
  maxResults?: number;
  depth?: TavilySearchDepth;
}

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

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('[tavily] TAVILY_API_KEY not set — skipping search');
    return [];
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: depth,
        max_results: maxResults,
      }),
    });

    if (!res.ok) {
      console.error('[tavily] search failed:', res.status, await res.text());
      return [];
    }

    const data = await res.json() as { results?: TavilyResult[] };
    const results = data.results ?? [];
    console.log(`[tavily] query="${query}" depth=${depth} results=${results.length}`);
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
