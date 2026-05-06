import { describe, it, expect } from 'vitest';
import { extractCitations, findHallucinated } from '../url-checker.js';

const POST_WITH_URLS = `Кеша на проводе🐤

Anthropic выпустила Claude 4 — подробности на https://www.anthropic.com/news/claude-4
📎 источник: https://techcrunch.com/2026/05/01/anthropic-claude-4/

Cursor получил обновление. @cursor_ai анонсировал на https://cursor.sh/blog/update

Ваш стажер-Кеша @st_szs 🐤`;

describe('extractCitations', () => {
  it('extracts http and https URLs', () => {
    const { urls } = extractCitations(POST_WITH_URLS);
    expect(urls).toContain('https://www.anthropic.com/news/claude-4');
    expect(urls).toContain('https://techcrunch.com/2026/05/01/anthropic-claude-4/');
    expect(urls).toContain('https://cursor.sh/blog/update');
  });

  it('deduplicates URLs', () => {
    const text = 'See https://example.com and again https://example.com here.';
    const { urls } = extractCitations(text);
    expect(urls.filter(u => u === 'https://example.com').length).toBe(1);
  });

  it('extracts @handles', () => {
    const { handles } = extractCitations(POST_WITH_URLS);
    expect(handles).toContain('@cursor_ai');
    expect(handles).toContain('@st_szs');
  });

  it('returns empty arrays when nothing to extract', () => {
    const { urls, handles } = extractCitations('Просто текст без ссылок.');
    expect(urls).toEqual([]);
    expect(handles).toEqual([]);
  });

  it('does not capture trailing punctuation in URLs', () => {
    const text = 'Visit https://example.com, then do something.';
    const { urls } = extractCitations(text);
    expect(urls[0]).toBe('https://example.com');
  });
});

describe('findHallucinated', () => {
  it('returns empty when all URLs appear in context', () => {
    const post = 'Новость: https://example.com/real 📎';
    const context = 'Context with https://example.com/real mentioned here.';
    const result = findHallucinated(post, [context]);
    expect(result.urls).toEqual([]);
  });

  it('returns URLs absent from all contexts', () => {
    const post = 'Читай на https://example.com/hallucinated';
    const context = 'Context mentions https://other.com only.';
    const result = findHallucinated(post, [context]);
    expect(result.urls).toContain('https://example.com/hallucinated');
  });

  it('checks across multiple context strings', () => {
    const post = 'Ссылка: https://source1.com и https://source2.com';
    const ctx1 = 'https://source1.com is here';
    const ctx2 = 'https://source2.com is here';
    const result = findHallucinated(post, [ctx1, ctx2]);
    expect(result.urls).toEqual([]);
  });

  it('returns only the hallucinated subset', () => {
    const post = 'Good: https://real.com, bad: https://fake.com';
    const context = 'Context: https://real.com';
    const result = findHallucinated(post, [context]);
    expect(result.urls).toEqual(['https://fake.com']);
  });

  it('returns empty when post has no URLs', () => {
    const result = findHallucinated('Нет ссылок.', ['some context']);
    expect(result.urls).toEqual([]);
    expect(result.handles).toEqual([]);
  });
});
