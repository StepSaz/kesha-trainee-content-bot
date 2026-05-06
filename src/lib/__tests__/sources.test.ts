import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchSourceContext } from '../sources.js';

// Mocking @netlify/blobs so cache always misses in tests (non-Netlify env).
vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    get: vi.fn().mockResolvedValue(null),
    setJSON: vi.fn().mockResolvedValue(undefined),
  }),
}));

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
