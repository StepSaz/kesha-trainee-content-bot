import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchSourceContext, fetchLightWebSearch, normalizeUrl } from '../sources.js';
import { callClaude } from '../claude.js';

// Mocking @netlify/blobs so cache always misses in tests (non-Netlify env).
vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    get: vi.fn().mockResolvedValue(null),
    setJSON: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../claude.js', () => ({ callClaude: vi.fn() }));

const mockCallClaude = vi.mocked(callClaude);

const SAMPLE_FEED = {
  sortMode: 'week',
  hackerNews: [
    {
      id: 1,
      url: 'https://example.com/grok',
      title: 'Grok 4.3 released',
      agg_score: 950,
      ai_summary: { tldr: 'xAI launched Grok 4.3 with longer context.' },
    },
    {
      id: 2,
      url: 'https://example.com/uber',
      title: 'Uber spent its AI budget on Claude Code',
      agg_score: 600,
      ai_summary: { tldr: 'Internal memo reveals heavy Claude Code usage.' },
    },
    {
      id: 3,
      url: 'https://example.com/recipe',
      title: "My grandmother's sourdough recipe",
      agg_score: 300,
      ai_summary: { tldr: 'A long-form post about baking bread.' },
    },
  ],
};

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Anthropic Blog</title>
  <item>
    <title>Claude 4 is here</title>
    <link>https://www.anthropic.com/news/claude-4</link>
  </item>
  <item>
    <title>Safety update</title>
    <link>https://www.anthropic.com/news/safety</link>
  </item>
</channel></rss>`;

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSourceContext — HN feed', () => {
  it('returns filtered AI items sorted by agg_score', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => SAMPLE_FEED,
      text: async () => '',
    }));

    const { context, itemCount } = await fetchSourceContext();

    expect(context).toContain('Hacker News');
    expect(context).toContain('Grok 4.3 released');
    expect(context).toContain('Uber spent its AI budget on Claude Code');
    expect(context).not.toContain('sourdough');
    expect(itemCount).toBeGreaterThanOrEqual(2);
  });

  it('orders HN items by agg_score descending', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => SAMPLE_FEED,
      text: async () => '',
    }));

    const { context } = await fetchSourceContext();
    expect(context.indexOf('Grok 4.3')).toBeLessThan(context.indexOf('Uber spent'));
  });

  it('includes ai_summary tldr when present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => SAMPLE_FEED,
      text: async () => '',
    }));

    const { context } = await fetchSourceContext();
    expect(context).toContain('TL;DR: xAI launched Grok 4.3');
  });

  it('throws on HN network error when no RSS feeds configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    await expect(fetchSourceContext()).rejects.toThrow('network error');
  });

  it('returns empty context when feed has no items', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ sortMode: 'week' }),
      text: async () => '',
    }));

    const result = await fetchSourceContext();
    expect(result.context).toBe('');
    expect(result.itemCount).toBe(0);
  });

  it('does not expose raw engagement numbers in context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => SAMPLE_FEED,
      text: async () => '',
    }));

    const { context } = await fetchSourceContext();
    expect(context).not.toMatch(/score=/);
    expect(context).not.toMatch(/agg=/);
  });

  it('handles items without ai_summary gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        sortMode: 'week',
        hackerNews: [{ id: 1, url: 'https://x.com', title: 'New OpenAI feature', agg_score: 100 }],
      }),
      text: async () => '',
    }));

    const { context } = await fetchSourceContext();
    expect(context).toContain('New OpenAI feature');
    expect(context).not.toContain('TL;DR');
  });

  it('excludes HN items present in excludeUrls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => SAMPLE_FEED,
      text: async () => '',
    }));

    const exclude = new Set([normalizeUrl('https://www.example.com/uber/')]);
    const { context, itemCount } = await fetchSourceContext(exclude);

    expect(context).toContain('Grok 4.3 released');
    expect(context).not.toContain('Uber spent its AI budget');
    expect(itemCount).toBe(1);
  });
});

describe('fetchSourceContext — RSS feeds', () => {
  it('appends RSS items to context when priority_sources has URLs', async () => {
    // First call: HN JSON, subsequent calls: RSS XML
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ json: async () => SAMPLE_FEED, text: async () => '' })
      .mockResolvedValueOnce({ json: async () => ({}), text: async () => SAMPLE_RSS }),
    );

    const { context } = await fetchSourceContext();

    expect(context).toContain('Claude 4 is here');
    expect(context).toContain('https://www.anthropic.com/news/claude-4');
  });

  it('continues gracefully when an RSS feed fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ json: async () => SAMPLE_FEED, text: async () => '' })
      .mockRejectedValueOnce(new Error('RSS timeout')),
    );

    // Should not throw — RSS failure is non-fatal
    const { context } = await fetchSourceContext();
    expect(context).toContain('Hacker News');
  });
});

describe('fetchLightWebSearch', () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const freshItem = (headline: string) =>
    JSON.stringify([{ headline, url: `https://example.com/${headline}`, date: yesterday }]);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns headlines from both queries when all succeed', async () => {
    mockCallClaude
      .mockResolvedValueOnce(freshItem('News A'))
      .mockResolvedValueOnce(freshItem('News B'));

    const result = await fetchLightWebSearch();

    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(result).toContain('News A');
    expect(result).toContain('News B');
  });

  it('returns empty string when all queries fail', async () => {
    mockCallClaude
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'));

    const result = await fetchLightWebSearch();

    expect(result).toBe('');
  });

  it('returns partial results when one query fails', async () => {
    mockCallClaude
      .mockResolvedValueOnce(freshItem('News A'))
      .mockRejectedValueOnce(new Error('fail'));

    const result = await fetchLightWebSearch();

    expect(result).toContain('News A');
  });

  it('drops stale items older than 7 days even when model returns them', async () => {
    const mixed = JSON.stringify([
      { headline: 'Fresh news', url: 'https://example.com/fresh', date: yesterday },
      { headline: 'Old news', url: 'https://example.com/old', date: oldDate },
    ]);
    mockCallClaude
      .mockResolvedValueOnce(mixed)
      .mockResolvedValueOnce('[]');

    const result = await fetchLightWebSearch();

    expect(result).toContain('Fresh news');
    expect(result).not.toContain('Old news');
  });

  it('returns empty string when model returns only stale items', async () => {
    const staleOnly = JSON.stringify([
      { headline: 'Old news', url: 'https://example.com/old', date: oldDate },
    ]);
    mockCallClaude
      .mockResolvedValueOnce(staleOnly)
      .mockResolvedValueOnce(staleOnly);

    const result = await fetchLightWebSearch();

    expect(result).toBe('');
  });

  it('handles malformed JSON gracefully by skipping that query', async () => {
    mockCallClaude
      .mockResolvedValueOnce('not json at all')
      .mockResolvedValueOnce(freshItem('News B'));

    const result = await fetchLightWebSearch();

    expect(result).not.toContain('not json');
    expect(result).toContain('News B');
  });

  it('strips markdown code fences before parsing JSON', async () => {
    const withFences = '```json\n' + freshItem('News with fences') + '\n```';
    mockCallClaude
      .mockResolvedValueOnce(withFences)
      .mockResolvedValueOnce('[]');

    const result = await fetchLightWebSearch();

    expect(result).toContain('News with fences');
  });

  it('injects cutoff and today dates into queries', async () => {
    mockCallClaude.mockResolvedValue('[]');

    await fetchLightWebSearch();

    const year = new Date().getFullYear().toString();
    const calls = mockCallClaude.mock.calls;
    expect(calls.length).toBe(2);
    calls.forEach(([args]) => {
      expect(args.userMessage).toContain(year);
    });
  });

  it('excludes search items present in excludeUrls', async () => {
    const mixed = JSON.stringify([
      { headline: 'Fresh news A', url: 'https://example.com/fresh-a', date: yesterday },
      { headline: 'Fresh news B', url: 'https://example.com/fresh-b', date: yesterday },
    ]);
    mockCallClaude
      .mockResolvedValueOnce(mixed)
      .mockResolvedValueOnce('[]');

    const exclude = new Set([normalizeUrl('https://example.com/fresh-b')]);
    const result = await fetchLightWebSearch(exclude);

    expect(result).toContain('Fresh news A');
    expect(result).not.toContain('Fresh news B');
  });
});

describe('normalizeUrl', () => {
  it('strips protocols, www, hash, trailing slash, and UTM parameters', () => {
    expect(normalizeUrl('https://www.example.com/some/path/?utm_source=feed&ref=123#hash')).toBe('example.com/some/path');
    expect(normalizeUrl('http://example.com/path/')).toBe('example.com/path');
    expect(normalizeUrl('https://example.com?v=123&utm_medium=email')).toBe('example.com?v=123');
    expect(normalizeUrl('example.com/')).toBe('example.com');
  });

  it('keeps important query parameters intact', () => {
    expect(normalizeUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube.com/watch?v=dQw4w9WgXcQ');
  });
});
