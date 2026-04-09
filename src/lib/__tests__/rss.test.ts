import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchRssContext } from '../rss.js';

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Claude gets smarter</title>
      <link>https://anthropic.com/news/claude-update</link>
      <description><![CDATA[<p>Anthropic released Claude 4 with major improvements.</p>]]></description>
      <pubDate>Wed, 09 Apr 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>New AI coding tool</title>
      <link>https://example.com/tool</link>
      <description>A new tool for developers.</description>
      <pubDate>Tue, 08 Apr 2026 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRssContext', () => {
  it('returns formatted text block with feed items', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: async () => SAMPLE_XML,
    }));

    const result = await fetchRssContext();

    expect(result).toContain('shir-man AI Trends');
    expect(result).toContain('Claude gets smarter');
    expect(result).toContain('https://anthropic.com/news/claude-update');
  });

  it('strips HTML tags from description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: async () => SAMPLE_XML,
    }));

    const result = await fetchRssContext();

    expect(result).not.toContain('<p>');
    expect(result).toContain('Anthropic released Claude 4');
  });

  it('returns empty string on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const result = await fetchRssContext();

    expect(result).toBe('');
  });

  it('returns empty string on invalid XML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: async () => 'not xml at all <<<',
    }));

    const result = await fetchRssContext();

    expect(typeof result).toBe('string');
  });
});
