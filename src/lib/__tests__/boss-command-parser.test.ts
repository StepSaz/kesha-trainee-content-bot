import { describe, it, expect } from 'vitest';
import { parseCommand, parseDigestVariant } from '../boss-command-parser.js';

describe('parseCommand', () => {
  it('extracts plain text without flags', () => {
    expect(parseCommand('/boss Привет мир')).toEqual({ forceRaw: false, forceSkip: false, inputText: 'Привет мир' });
  });

  it('extracts text with --raw flag', () => {
    expect(parseCommand('/boss --raw Мой текст поста')).toEqual({ forceRaw: true, forceSkip: false, inputText: 'Мой текст поста' });
  });

  it('extracts text with --skip flag', () => {
    expect(parseCommand('/boss --skip Готовый пост')).toEqual({ forceRaw: false, forceSkip: true, inputText: 'Готовый пост' });
  });

  it('handles /boss@botname format (Telegram group syntax)', () => {
    expect(parseCommand('/boss@keshbot Текст поста')).toEqual({ forceRaw: false, forceSkip: false, inputText: 'Текст поста' });
  });

  it('handles /boss@botname --raw format', () => {
    expect(parseCommand('/boss@keshbot --raw Сырой текст')).toEqual({ forceRaw: true, forceSkip: false, inputText: 'Сырой текст' });
  });

  it('trims extra whitespace from inputText', () => {
    expect(parseCommand('/boss   много пробелов   ').inputText).toBe('много пробелов');
  });

  it('handles --raw with no following text', () => {
    expect(parseCommand('/boss --raw')).toEqual({ forceRaw: true, forceSkip: false, inputText: '' });
  });

  it('handles --skip with no following text', () => {
    expect(parseCommand('/boss --skip')).toEqual({ forceRaw: false, forceSkip: true, inputText: '' });
  });

  it('returns empty inputText for bare /boss command', () => {
    expect(parseCommand('/boss')).toEqual({ forceRaw: false, forceSkip: false, inputText: '' });
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
