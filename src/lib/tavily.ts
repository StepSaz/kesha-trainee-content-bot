export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export async function tavilySearch(query: string, maxResults = 5): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: maxResults,
      }),
    });

    if (!res.ok) {
      console.error('[tavily] search failed:', res.status, await res.text());
      return [];
    }

    const data = await res.json() as { results?: TavilyResult[] };
    return data.results ?? [];
  } catch (err) {
    console.error('[tavily] search error:', err);
    return [];
  }
}
