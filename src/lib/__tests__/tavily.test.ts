import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tavilySearch } from '../tavily.js';

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
