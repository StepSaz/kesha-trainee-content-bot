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

    const result = await fetchHackerNewsContext();

    expect(result).toContain('Hacker News');
    expect(result).toContain('Grok 4.3 released');
    expect(result).toContain('Uber spent its AI budget on Claude Code');
    expect(result).not.toContain('sourdough');
  });

  it('orders items by agg_score descending', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => SAMPLE_FEED,
    }));

    const result = await fetchHackerNewsContext();
    const grokIdx = result.indexOf('Grok 4.3');
    const uberIdx = result.indexOf('Uber spent');

    expect(grokIdx).toBeGreaterThan(0);
    expect(uberIdx).toBeGreaterThan(grokIdx);
  });

  it('includes ai_summary tldr when present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => SAMPLE_FEED,
    }));

    const result = await fetchHackerNewsContext();

    expect(result).toContain('TL;DR: xAI launched Grok 4.3');
  });

  it('returns empty string on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const result = await fetchHackerNewsContext();

    expect(result).toBe('');
  });

  it('returns empty string when feed has no hackerNews items', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ generatedAt: 'now', sortMode: 'week' }),
    }));

    const result = await fetchHackerNewsContext();

    expect(result).toBe('');
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

    const result = await fetchHackerNewsContext();

    expect(result).toContain('New OpenAI feature');
    expect(result).not.toContain('TL;DR');
  });
});
