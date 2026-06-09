import { describe, it, expect } from 'vitest';
import { parseCommand, parseDigestVariant } from '../boss-command-parser.js';

describe('parseCommand', () => {
  it('extracts plain text', () => {
    expect(parseCommand('/boss Привет мир')).toEqual({ inputText: 'Привет мир' });
  });

  it('strips legacy --raw flag without leaking it into the text', () => {
    expect(parseCommand('/boss --raw Мой текст поста')).toEqual({ inputText: 'Мой текст поста' });
  });

  it('strips legacy --skip flag without leaking it into the text', () => {
    expect(parseCommand('/boss --skip Готовый пост')).toEqual({ inputText: 'Готовый пост' });
  });

  it('handles /boss@botname format (Telegram group syntax)', () => {
    expect(parseCommand('/boss@keshbot Текст поста')).toEqual({ inputText: 'Текст поста' });
  });

  it('handles /boss@botname --raw format', () => {
    expect(parseCommand('/boss@keshbot --raw Сырой текст')).toEqual({ inputText: 'Сырой текст' });
  });

  it('trims extra whitespace from inputText', () => {
    expect(parseCommand('/boss   много пробелов   ').inputText).toBe('много пробелов');
  });

  it('handles legacy --raw with no following text', () => {
    expect(parseCommand('/boss --raw')).toEqual({ inputText: '' });
  });

  it('handles legacy --skip with no following text', () => {
    expect(parseCommand('/boss --skip')).toEqual({ inputText: '' });
  });

  it('returns empty inputText for bare /boss command', () => {
    expect(parseCommand('/boss')).toEqual({ inputText: '' });
  });
});

describe('parseDigestVariant', () => {
  it('returns full for bare /digest', () => {
    expect(parseDigestVariant('/digest')).toBe('full');
  });
  it('returns short for /digest short', () => {
    expect(parseDigestVariant('/digest short')).toBe('short');
  });
  it('returns short ignoring extra args after short', () => {
    expect(parseDigestVariant('/digest short extra')).toBe('short');
  });
  it('tolerates extra spaces before short', () => {
    expect(parseDigestVariant('/digest   short')).toBe('short');
  });
  it('is case-insensitive on the variant arg', () => {
    expect(parseDigestVariant('/digest SHORT')).toBe('short');
  });
  it('returns full for unknown args', () => {
    expect(parseDigestVariant('/digest foo')).toBe('full');
  });
  it('handles /digest@bot short (Telegram group syntax)', () => {
    expect(parseDigestVariant('/digest@psyreqbot short')).toBe('short');
  });
  it('returns full when args are on a second line (first line only)', () => {
    expect(parseDigestVariant('/digest\nshort')).toBe('full');
  });
  it('returns null for non-digest commands (no command boundary)', () => {
    expect(parseDigestVariant('/digestshort')).toBeNull();
    expect(parseDigestVariant('/digest_short')).toBeNull();
    expect(parseDigestVariant('/boss text')).toBeNull();
    expect(parseDigestVariant('просто текст')).toBeNull();
  });
});
