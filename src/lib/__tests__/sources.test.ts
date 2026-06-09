import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchSourceContext,
  fetchLightWebSearch,
  normalizeUrl,
  getCutoffDate,
  isFreshDate,
  extractPublishedDateFromRssItem,
  extractPublishedDateFromHtml,
} from '../sources.js';
import { callClaude } from '../claude.js';

// Shared, controllable blob-get mock (hoisted so the vi.mock factory can reference it).
// Defaults to a cache miss; individual tests can override per-case via mockBlobGet.
const { mockBlobGet } = vi.hoisted(() => ({ mockBlobGet: vi.fn() }));
vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    get: mockBlobGet,
    setJSON: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../claude.js', () => ({ callClaude: vi.fn() }));

const mockCallClaude = vi.mocked(callClaude);

// Fresh time: 2 days ago in Unix seconds
const freshTime = Math.floor((Date.now() - 2 * 24 * 3600 * 1000) / 1000);
// Fresh pubDate for RSS: 2 days ago
const freshPubDate = new Date(Date.now() - 2 * 86400000).toUTCString();

const SAMPLE_FEED = {
  sortMode: 'week',
  hackerNews: [
    {
      id: 1,
      url: 'https://example.com/grok',
      title: 'Grok 4.3 released',
      agg_score: 950,
      ai_summary: { tldr: 'xAI launched Grok 4.3 with longer context.' },
      time: freshTime,
    },
    {
      id: 2,
      url: 'https://example.com/uber',
      title: 'Uber spent its AI budget on Claude Code',
      agg_score: 600,
      ai_summary: { tldr: 'Internal memo reveals heavy Claude Code usage.' },
      time: freshTime,
    },
    {
      id: 3,
      url: 'https://example.com/recipe',
      title: "My grandmother's sourdough recipe",
      agg_score: 300,
      ai_summary: { tldr: 'A long-form post about baking bread.' },
      time: freshTime,
    },
  ],
};

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Anthropic Blog</title>
  <item>
    <title>Claude 4 is here</title>
    <link>https://www.anthropic.com/news/claude-4</link>
    <pubDate>${freshPubDate}</pubDate>
  </item>
  <item>
    <title>Safety update</title>
    <link>https://www.anthropic.com/news/safety</link>
    <pubDate>${freshPubDate}</pubDate>
  </item>
</channel></rss>`;

// URL-routed fetch mock: routes based on URL
function makeRoutedFetch(options: {
  hnFeed?: object;
  rssFeed?: string;
  articleHtml?: string;
} = {}) {
  const hnFeed = options.hnFeed ?? SAMPLE_FEED;
  const rssFeed = options.rssFeed ?? SAMPLE_RSS;
  const articleHtml = options.articleHtml ?? '';

  return vi.fn(async (url: string) => {
    const urlStr = typeof url === 'string' ? url : String(url);
    if (urlStr.includes('shir-man.com')) {
      return { ok: true, json: async () => hnFeed, text: async () => '' };
    }
    if (urlStr.includes('rss') || urlStr.includes('/feed') || urlStr.endsWith('.xml')) {
      return { ok: true, json: async () => ({}), text: async () => rssFeed };
    }
    // Article URLs
    return { ok: true, json: async () => ({}), text: async () => articleHtml };
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mockBlobGet.mockReset();
  mockBlobGet.mockResolvedValue(null); // default: cache miss
});

// ── getCutoffDate / isFreshDate ───────────────────────────────────────────────

describe('getCutoffDate', () => {
  it('returns a date exactly 7 days ago at start-of-day UTC', () => {
    const now = new Date('2026-06-04T15:30:00Z');
    const cutoff = getCutoffDate(7, now);
    expect(cutoff.toISOString()).toBe('2026-05-28T00:00:00.000Z');
  });

  it('defaults to 7 days', () => {
    const before = getCutoffDate(7);
    const after = getCutoffDate();
    // Same day
    expect(before.toISOString().slice(0, 10)).toBe(after.toISOString().slice(0, 10));
  });
});

describe('isFreshDate', () => {
  const cutoff = new Date('2026-05-28T00:00:00.000Z');

  it('returns true for date exactly at cutoff (7 days ago)', () => {
    expect(isFreshDate(new Date('2026-05-28T12:00:00Z'), cutoff)).toBe(true);
  });

  it('returns true for today', () => {
    expect(isFreshDate(new Date('2026-06-04T00:00:00Z'), cutoff)).toBe(true);
  });

  it('returns false for 8 days ago (1 day before cutoff)', () => {
    expect(isFreshDate(new Date('2026-05-27T23:59:59Z'), cutoff)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isFreshDate(null, cutoff)).toBe(false);
  });

  it('returns false for invalid date', () => {
    expect(isFreshDate(new Date('not-a-date'), cutoff)).toBe(false);
  });
});

// ── extractPublishedDateFromRssItem ───────────────────────────────────────────

describe('extractPublishedDateFromRssItem', () => {
  it('extracts pubDate (RSS 2.0)', () => {
    const result = extractPublishedDateFromRssItem({ pubDate: 'Wed, 04 Jun 2026 10:00:00 GMT' });
    expect(result).not.toBeNull();
    expect(result!.getUTCFullYear()).toBe(2026);
    expect(result!.getUTCMonth()).toBe(5); // June
    expect(result!.getUTCDate()).toBe(4);
  });

  it('extracts published (Atom)', () => {
    const result = extractPublishedDateFromRssItem({ published: '2026-06-03T08:00:00Z' });
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(3);
  });

  it('extracts updated (Atom fallback)', () => {
    const result = extractPublishedDateFromRssItem({ updated: '2026-06-02T00:00:00Z' });
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(2);
  });

  it('extracts dc:date', () => {
    const result = extractPublishedDateFromRssItem({ 'dc:date': '2026-06-01T00:00:00Z' });
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(1);
  });

  it('coerces { #text: "..." } to string', () => {
    const result = extractPublishedDateFromRssItem({ pubDate: { '#text': '2026-05-31T00:00:00Z' } });
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(31);
  });

  it('returns null when no date field is present', () => {
    expect(extractPublishedDateFromRssItem({ title: 'No date here' })).toBeNull();
  });
});

// ── extractPublishedDateFromHtml ──────────────────────────────────────────────

describe('extractPublishedDateFromHtml', () => {
  it('extracts datePublished from JSON-LD', () => {
    const html = `<script type="application/ld+json">{"@type":"Article","datePublished":"2026-06-01T10:00:00Z"}</script>`;
    const result = extractPublishedDateFromHtml(html);
    expect(result).not.toBeNull();
    expect(result!.getUTCFullYear()).toBe(2026);
    expect(result!.getUTCDate()).toBe(1);
  });

  it('extracts datePublished from JSON-LD @graph', () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article","datePublished":"2026-05-30T09:00:00Z"}]}</script>`;
    const result = extractPublishedDateFromHtml(html);
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(30);
  });

  it('extracts article:published_time from meta property', () => {
    const html = `<meta property="article:published_time" content="2026-06-02T00:00:00Z" />`;
    const result = extractPublishedDateFromHtml(html);
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(2);
  });

  it('extracts article:published_time when content comes before property', () => {
    const html = `<meta content="2026-06-03T00:00:00Z" property="article:published_time" />`;
    const result = extractPublishedDateFromHtml(html);
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(3);
  });

  it('extracts datetime from <time> element', () => {
    const html = `<time datetime="2026-05-29T12:00:00Z">May 29</time>`;
    const result = extractPublishedDateFromHtml(html);
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(29);
  });

  it('returns null when no date found', () => {
    const html = `<html><head><title>No date here</title></head><body></body></html>`;
    expect(extractPublishedDateFromHtml(html)).toBeNull();
  });
});

// ── fetchSourceContext — HN feed ──────────────────────────────────────────────

describe('fetchSourceContext — HN feed', () => {
  it('returns filtered AI items sorted by agg_score', async () => {
    vi.stubGlobal('fetch', makeRoutedFetch());

    const { context, itemCount } = await fetchSourceContext();

    expect(context).toContain('Hacker News');
    expect(context).toContain('Grok 4.3 released');
    expect(context).toContain('Uber spent its AI budget on Claude Code');
    expect(context).not.toContain('sourdough');
    expect(itemCount).toBeGreaterThanOrEqual(2);
  });

  it('orders HN items by agg_score descending', async () => {
    vi.stubGlobal('fetch', makeRoutedFetch());

    const { context } = await fetchSourceContext();
    expect(context.indexOf('Grok 4.3')).toBeLessThan(context.indexOf('Uber spent'));
  });

  it('includes ai_summary tldr when present', async () => {
    vi.stubGlobal('fetch', makeRoutedFetch());

    const { context } = await fetchSourceContext();
    expect(context).toContain('TL;DR: xAI launched Grok 4.3');
  });

  it('returns empty context on HN network error when no RSS feeds configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const result = await fetchSourceContext();
    expect(result.context).toBe('');
    expect(result.itemCount).toBe(0);
  });

  it('returns empty context when feed has no items and RSS is also empty', async () => {
    const emptyRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;
    vi.stubGlobal('fetch', makeRoutedFetch({ hnFeed: { sortMode: 'week' }, rssFeed: emptyRss }));

    const result = await fetchSourceContext();
    expect(result.context).toBe('');
    expect(result.itemCount).toBe(0);
  });

  it('does not expose raw engagement numbers in context', async () => {
    vi.stubGlobal('fetch', makeRoutedFetch());

    const { context } = await fetchSourceContext();
    expect(context).not.toMatch(/score=/);
    expect(context).not.toMatch(/agg=/);
  });

  it('handles items without ai_summary gracefully', async () => {
    const hnFeed = {
      sortMode: 'week',
      hackerNews: [{ id: 1, url: 'https://x.com', title: 'New OpenAI feature', agg_score: 100, time: freshTime }],
    };
    vi.stubGlobal('fetch', makeRoutedFetch({ hnFeed }));

    const { context } = await fetchSourceContext();
    expect(context).toContain('New OpenAI feature');
    expect(context).not.toContain('TL;DR');
  });

  it('excludes HN items present in excludeUrls', async () => {
    vi.stubGlobal('fetch', makeRoutedFetch());

    const exclude = new Set([normalizeUrl('https://www.example.com/uber/')]);
    const { context, itemCount } = await fetchSourceContext(exclude);

    expect(context).toContain('Grok 4.3 released');
    expect(context).not.toContain('Uber spent its AI budget');
  });
});

// ── fetchSourceContext — RSS feeds ────────────────────────────────────────────

describe('fetchSourceContext — RSS feeds', () => {
  it('appends RSS items to context when priority_sources has URLs', async () => {
    vi.stubGlobal('fetch', makeRoutedFetch());

    const { context } = await fetchSourceContext();

    expect(context).toContain('Claude 4 is here');
    expect(context).toContain('https://www.anthropic.com/news/claude-4');
  });

  it('continues gracefully when an RSS feed fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('shir-man.com')) {
        return { ok: true, json: async () => SAMPLE_FEED, text: async () => '' };
      }
      throw new Error('RSS timeout');
    }));

    // Should not throw — RSS failure is non-fatal
    const { context } = await fetchSourceContext();
    expect(context).toContain('Hacker News');
  });

  it('drops RSS items with stale pubDate', async () => {
    const staleDate = new Date(Date.now() - 30 * 86400000).toUTCString();
    const staleRss = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test</title>
  <item>
    <title>Old article</title>
    <link>https://example.com/old</link>
    <pubDate>${staleDate}</pubDate>
  </item>
</channel></rss>`;

    vi.stubGlobal('fetch', makeRoutedFetch({ rssFeed: staleRss }));
    const { context } = await fetchSourceContext();
    expect(context).not.toContain('Old article');
  });

  it('keeps RSS items with fresh pubDate', async () => {
    vi.stubGlobal('fetch', makeRoutedFetch());
    const { context } = await fetchSourceContext();
    expect(context).toContain('Claude 4 is here');
  });

  it('drops RSS items with no pubDate', async () => {
    const nodateRss = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test</title>
  <item>
    <title>Undated article</title>
    <link>https://example.com/undated</link>
  </item>
</channel></rss>`;

    vi.stubGlobal('fetch', makeRoutedFetch({ rssFeed: nodateRss }));
    const { context } = await fetchSourceContext();
    expect(context).not.toContain('Undated article');
  });
});

// ── HN freshness filter tests ─────────────────────────────────────────────────

describe('fetchSourceContext — HN freshness filter', () => {
  it('drops HN items with stale time (no article fetch)', async () => {
    const staleTime = Math.floor((Date.now() - 30 * 24 * 3600 * 1000) / 1000);
    const hnFeed = {
      sortMode: 'week',
      hackerNews: [
        { id: 1, url: 'https://example.com/old', title: 'Old article', agg_score: 900, time: staleTime },
      ],
    };

    const fetchMock = vi.fn(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('shir-man.com')) {
        return { ok: true, json: async () => hnFeed, text: async () => '' };
      }
      // RSS feeds
      return { ok: true, json: async () => ({}), text: async () => SAMPLE_RSS };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { context } = await fetchSourceContext();
    expect(context).not.toContain('Old article');
    // Should NOT have fetched article URL
    const articleFetches = fetchMock.mock.calls.filter(([url]) => String(url).includes('example.com/old'));
    expect(articleFetches).toHaveLength(0);
  });

  it('drops HN items where article meta datePublished is stale', async () => {
    const staleArticleHtml = `<script type="application/ld+json">{"@type":"Article","datePublished":"2025-01-01T00:00:00Z"}</script>`;
    const hnFeed = {
      sortMode: 'week',
      hackerNews: [
        { id: 1, url: 'https://example.com/old-article', title: 'Evergreen article', agg_score: 900, time: freshTime },
      ],
    };

    vi.stubGlobal('fetch', makeRoutedFetch({ hnFeed, articleHtml: staleArticleHtml }));
    const { context } = await fetchSourceContext();
    expect(context).not.toContain('Evergreen article');
  });

  it('keeps HN items with fresh time and unknown article date, with Source date annotation', async () => {
    // Article returns no date info; title must match keyword filter (contains "AI")
    const hnFeed = {
      sortMode: 'week',
      hackerNews: [
        { id: 1, url: 'https://example.com/nodateArticle', title: 'AI article with unknown date', agg_score: 900, time: freshTime },
      ],
    };

    vi.stubGlobal('fetch', makeRoutedFetch({ hnFeed, articleHtml: '<html><body>No date</body></html>' }));
    const { context } = await fetchSourceContext();
    expect(context).toContain('AI article with unknown date');
    expect(context).toContain('Source date: unknown');
    expect(context).toContain('HN date:');
  });
});

// ── cache schema version tests ────────────────────────────────────────────────

describe('cache schema version', () => {
  it('treats a cache entry without schemaVersion/cutoffDate as a miss (refetches)', async () => {
    // Versionless legacy cache entry — must be ignored.
    mockBlobGet.mockResolvedValue({
      result: { context: 'stale cached context', itemCount: 1 },
      fetchedAt: new Date().toISOString(),
      // No schemaVersion, no cutoffDate
    });

    vi.stubGlobal('fetch', makeRoutedFetch());

    const { context } = await fetchSourceContext();
    // Should NOT serve the stale cache — should fetch fresh (HN content present).
    expect(context).not.toContain('stale cached context');
    expect(context).toContain('Hacker News');
  });
});

// ── fetchLightWebSearch ───────────────────────────────────────────────────────

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

  it('drops items with invalid dates even when date strings compare as fresh', async () => {
    const mixed = JSON.stringify([
      { headline: 'Fresh news', url: 'https://example.com/fresh', date: yesterday },
      { headline: 'Invalid date news', url: 'https://example.com/invalid', date: 'zzzz-not-a-date' },
    ]);
    mockCallClaude
      .mockResolvedValueOnce(mixed)
      .mockResolvedValueOnce('[]');

    const result = await fetchLightWebSearch();

    expect(result).toContain('Fresh news');
    expect(result).not.toContain('Invalid date news');
  });

  it('drops items dated in the future (only [cutoff, today] is fresh)', async () => {
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const mixed = JSON.stringify([
      { headline: 'Fresh news', url: 'https://example.com/fresh', date: yesterday },
      { headline: 'Future news', url: 'https://example.com/future', date: future },
    ]);
    mockCallClaude
      .mockResolvedValueOnce(mixed)
      .mockResolvedValueOnce('[]');

    const result = await fetchLightWebSearch();

    expect(result).toContain('Fresh news');
    expect(result).not.toContain('Future news');
  });

  it('does not crash on null or non-object array elements', async () => {
    const withJunk = JSON.stringify([
      null,
      42,
      { headline: 'Fresh news', url: 'https://example.com/fresh', date: yesterday },
    ]);
    mockCallClaude
      .mockResolvedValueOnce(withJunk)
      .mockResolvedValueOnce('[]');

    const result = await fetchLightWebSearch();

    expect(result).toContain('Fresh news');
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
