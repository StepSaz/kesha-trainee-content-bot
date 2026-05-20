import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tavilySearch, tavilyExtract } from '../tavily.js';

beforeEach(() => {
  process.env.TAVILY_API_KEY = 'test-key';
  vi.unstubAllGlobals();
});

describe('tavilySearch', () => {
  it('returns empty array when TAVILY_API_KEY is not set', async () => {
    delete process.env.TAVILY_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const results = await tavilySearch('anything');

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to Tavily endpoint with query and api_key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }));

    await tavilySearch('claude code', 3);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: 'test-key',
          query: 'claude code',
          search_depth: 'basic',
          max_results: 3,
        }),
      })
    );
  });

  it('returns parsed results', async () => {
    const mockResults = [
      { title: 'A', url: 'https://a.com', content: 'aaa', score: 0.9 },
      { title: 'B', url: 'https://b.com', content: 'bbb', score: 0.7 },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: mockResults }),
    }));

    const results = await tavilySearch('q');

    expect(results).toEqual(mockResults);
  });

  it('returns empty array on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }));

    const results = await tavilySearch('q');

    expect(results).toEqual([]);
  });

  it('returns empty array on fetch throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const results = await tavilySearch('q');

    expect(results).toEqual([]);
  });

  it('returns empty array when response has no results field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }));

    const results = await tavilySearch('q');

    expect(results).toEqual([]);
  });

  it('passes news topic, time_range, chunks_per_source, domains, and depth via options object', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await tavilySearch('gemini 3.5 io', {
      maxResults: 5,
      depth: 'advanced',
      topic: 'news',
      timeRange: 'week',
      chunksPerSource: 5,
      excludeDomains: ['reddit.com'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      query: 'gemini 3.5 io',
      search_depth: 'advanced',
      max_results: 5,
      topic: 'news',
      time_range: 'week',
      chunks_per_source: 5,
      exclude_domains: ['reddit.com'],
    });
  });

  it('skips chunks_per_source on basic depth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await tavilySearch('q', { depth: 'basic', chunksPerSource: 5 });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.chunks_per_source).toBeUndefined();
  });

  it('post-filters results below minScore', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [
        { title: 'good', url: 'https://a', content: 'x', score: 0.8 },
        { title: 'meh', url: 'https://b', content: 'y', score: 0.3 },
        { title: 'edge', url: 'https://c', content: 'z', score: 0.4 },
      ] }),
    }));

    const results = await tavilySearch('q', { minScore: 0.4 });
    expect(results.map(r => r.title)).toEqual(['good', 'edge']);
  });

  it('truncates queries over 400 chars', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const long = 'x'.repeat(500);
    await tavilySearch(long);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect((body.query as string).length).toBe(400);
  });

  it('uses default max_results of 5', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }));

    await tavilySearch('q');

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.max_results).toBe(5);
  });
});

describe('tavilyExtract', () => {
  it('returns empty string when TAVILY_API_KEY is not set', async () => {
    delete process.env.TAVILY_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await tavilyExtract('https://example.com');

    expect(result).toEqual('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to Tavily extract endpoint with url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ url: 'https://example.com', raw_content: 'hello' }] }),
    }));

    await tavilyExtract('https://example.com');

    expect(fetch).toHaveBeenCalledWith(
      'https://api.tavily.com/extract',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: 'test-key', urls: ['https://example.com'] }),
      })
    );
  });

  it('returns raw_content from first result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ url: 'https://a.com', raw_content: 'article body' }] }),
    }));

    const result = await tavilyExtract('https://a.com');

    expect(result).toEqual('article body');
  });

  it('trims content to 3000 chars', async () => {
    const longContent = 'x'.repeat(5000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ url: 'https://a.com', raw_content: longContent }] }),
    }));

    const result = await tavilyExtract('https://a.com');

    expect(result.length).toBe(3000);
  });

  it('returns empty string on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    }));

    const result = await tavilyExtract('https://a.com');

    expect(result).toEqual('');
  });

  it('returns empty string on fetch throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const result = await tavilyExtract('https://a.com');

    expect(result).toEqual('');
  });

  it('returns empty string when results array is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }));

    const result = await tavilyExtract('https://a.com');

    expect(result).toEqual('');
  });
});
