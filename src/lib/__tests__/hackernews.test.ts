import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchHackerNewsContext } from '../hackernews.js';

const SAMPLE_FEED = {
  generatedAt: '2026-05-02T10:00:00Z',
  algoVersion: 'v1',
  sortMode: 'week',
  hackerNews: [
    {
      id: 1,
      url: 'https://example.com/grok',
      title: 'Grok 4.3 released',
      rank: 1,
      agg_score: 950,
      score: 800,
      descendants: 420,
      ai_summary: { tldr: 'xAI launched Grok 4.3 with longer context.' },
    },
    {
      id: 2,
      url: 'https://example.com/uber',
      title: 'Uber spent its AI budget on Claude Code',
      rank: 27,
      agg_score: 600,
      score: 500,
      descendants: 200,
      ai_summary: { tldr: 'Internal memo reveals heavy Claude Code usage.' },
    },
    {
      id: 3,
      url: 'https://example.com/recipe',
      title: 'My grandmother\'s sourdough recipe',
      rank: 50,
      agg_score: 300,
      score: 250,
      descendants: 80,
      ai_summary: { tldr: 'A long-form post about baking bread.' },
    },
  ],
  midjourney: [],
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchHackerNewsContext', () => {
  it('returns formatted text block with filtered AI items sorted by agg_score', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => SAMPLE_FEED,
    }));

    const { context, itemCount } = await fetchHackerNewsContext();

    expect(context).toContain('Hacker News');
    expect(context).toContain('Grok 4.3 released');
    expect(context).toContain('Uber spent its AI budget on Claude Code');
    expect(context).not.toContain('sourdough');
    expect(itemCount).toBe(2);
  });

  it('orders items by agg_score descending', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => SAMPLE_FEED,
    }));

    const { context } = await fetchHackerNewsContext();
    const grokIdx = context.indexOf('Grok 4.3');
    const uberIdx = context.indexOf('Uber spent');

    expect(grokIdx).toBeGreaterThan(0);
    expect(uberIdx).toBeGreaterThan(grokIdx);
  });

  it('includes ai_summary tldr when present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => SAMPLE_FEED,
    }));

    const { context } = await fetchHackerNewsContext();

    expect(context).toContain('TL;DR: xAI launched Grok 4.3');
  });

  it('throws on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    await expect(fetchHackerNewsContext()).rejects.toThrow('network error');
  });

  it('returns empty result when feed has no hackerNews items', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ generatedAt: 'now', sortMode: 'week' }),
    }));

    const result = await fetchHackerNewsContext();

    expect(result.context).toBe('');
    expect(result.itemCount).toBe(0);
  });

  it('handles items without ai_summary gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        sortMode: 'week',
        hackerNews: [
          { id: 1, url: 'https://x.com', title: 'New OpenAI feature', agg_score: 100, score: 50, descendants: 10 },
        ],
      }),
    }));

    const { context } = await fetchHackerNewsContext();

    expect(context).toContain('New OpenAI feature');
    expect(context).not.toContain('TL;DR');
  });
});
