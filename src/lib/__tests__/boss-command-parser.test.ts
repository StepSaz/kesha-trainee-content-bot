import { describe, it, expect } from 'vitest';
import { parseCommand } from '../boss-command-parser.js';

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
});
