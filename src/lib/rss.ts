import { XMLParser } from 'fast-xml-parser';
import { readFileSync } from 'fs';
import { join } from 'path';

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

interface RssItem {
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
}

export async function fetchRssContext(): Promise<string> {
  const sourcesPath = join(process.cwd(), 'src/config/sources.json');
  const sources = JSON.parse(readFileSync(sourcesPath, 'utf-8')) as {
    rss_feeds: Array<{ name: string; url: string; max_items: number }>;
  };

  const results: string[] = [];

  for (const feed of sources.rss_feeds) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(feed.url, { signal: controller.signal });
      clearTimeout(timeout);

      const xml = await response.text();
      const parser = new XMLParser({ ignoreAttributes: false });
      const parsed = parser.parse(xml) as {
        rss?: { channel?: { item?: RssItem | RssItem[] } };
      };

      const rawItems = parsed?.rss?.channel?.item;
      const items: RssItem[] = rawItems
        ? Array.isArray(rawItems) ? rawItems : [rawItems]
        : [];

      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const sorted = [...items]
        .filter(item => item.pubDate && new Date(item.pubDate).getTime() >= cutoff)
        .sort((a, b) =>
          new Date(b.pubDate ?? 0).getTime() - new Date(a.pubDate ?? 0).getTime()
        )
        .slice(0, feed.max_items);

      const formatted = sorted.map((item, i) => {
        const desc = stripHtml(item.description ?? '');
        return `${i + 1}. ${item.title ?? 'No title'} - ${desc} (${item.link ?? ''})`;
      }).join('\n');

      results.push(`Тренды из RSS (${feed.name}):\n${formatted}`);
    } catch (err) {
      console.log(`[rss] Fetch failed for ${feed.name}: ${err}`);
    }
  }

  return results.join('\n\n');
}
