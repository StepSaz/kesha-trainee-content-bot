import { describe, it, expect } from 'vitest';
import { validatePost, validateBossPost } from '../validator.js';

// 🐤 only on greeting and signature lines; body is long enough so they are ≥500 chars apart.
const VALID_POST = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ. Не бейте.

Кеша на проводе🐤

Новость первая: Anthropic обновила Claude - новая версия с улучшенными возможностями рассуждения и более точным следованием инструкциям. Разработчики отметили рост точности на сложных задачах.
📎 источник: https://example.com/1

~ ~ ~

Новость вторая: Anthropic выпустила API-обновление с поддержкой tool use в режиме streaming. Для разработчиков это открывает новые сценарии использования в real-time приложениях.
📎 источник: https://example.com/2

~ ~ ~

Новость третья: Cursor добавил Claude как основного AI-ассистента в свой редактор. Инструмент показывает стабильный рост и набрал более миллиона активных пользователей за квартал.
📎 источник: https://example.com/3

~ ~ ~

Ваш стажер-Кеша @st_szs 🐤`;

describe('validatePost', () => {
  it('passes a valid post', () => {
    expect(validatePost(VALID_POST)).toEqual({ valid: true, errors: [] });
  });

  it('fails without both БОТ and УЧУСЬ', () => {
    const post = VALID_POST.replace('БОТ', 'бот').replace('УЧУСЬ', 'учусь');
    const result = validatePost(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('disclaimer'))).toBe(true);
  });

  it('passes with УЧУСЬ even without БОТ', () => {
    const post = `Я ТОЛЬКО УЧУСЬ. 🐤\n\nКеша на проводе🐤\n\nТест.`;
    expect(validatePost(post).errors.some(e => e.includes('disclaimer'))).toBe(false);
  });

  it('passes with УЧУСЬ beyond first 20 chars', () => {
    const post = `Ваш стажер на связи, Я ТОЛЬКО УЧУСЬ. 🐤\n\nКеша на проводе🐤\n\nТест.`;
    expect(validatePost(post).errors.some(e => e.includes('disclaimer'))).toBe(false);
  });

  it('fails without Кеша', () => {
    const post = VALID_POST.replace(/Кеша/g, 'Иннокентий');
    const result = validatePost(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Кеша'))).toBe(true);
  });

  it('fails without 🐤', () => {
    const post = VALID_POST.replace(/🐤/g, '');
    const result = validatePost(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('🐤'))).toBe(true);
  });

  it('fails with em-dash', () => {
    const post = VALID_POST + '\nТест—пробел';
    const result = validatePost(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('em-dash'))).toBe(true);
  });

  it('fails with markdown bold', () => {
    const post = VALID_POST + '\n**bold text**';
    const result = validatePost(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('markdown'))).toBe(true);
  });

  it('fails with markdown heading', () => {
    const post = VALID_POST + '\n## Заголовок';
    const result = validatePost(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('markdown'))).toBe(true);
  });

  it('fails with code block', () => {
    const post = VALID_POST + '\n```code```';
    const result = validatePost(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('markdown'))).toBe(true);
  });

  it('fails when over 4000 chars', () => {
    const post = VALID_POST + 'x'.repeat(4001);
    const result = validatePost(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('long'))).toBe(true);
  });

  it('fails with fewer than 3 news items', () => {
    const post = VALID_POST.replace(/📎 источник: https:\/\/example\.com\/3\n\n~ ~ ~\n\n/, '');
    const result = validatePost(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Too few news items'))).toBe(true);
  });

  it('passes with exactly 3 news items', () => {
    expect(validatePost(VALID_POST).errors.some(e => e.includes('Too few news items'))).toBe(false);
  });

  it('collects multiple errors', () => {
    const result = validatePost('short invalid post');
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe('chickenDistance rule', () => {
  it('fails when two 🐤 are less than 500 chars apart', () => {
    const post = 'Я ТОЛЬКО УЧУСЬ.\n\nКеша🐤\n\nShort body.\n📎📎📎\n\nПодпись🐤';
    expect(validatePost(post).errors.some(e => e.includes('too close'))).toBe(true);
  });

  it('does not error when only one 🐤 is present', () => {
    const post = 'Я ТОЛЬКО УЧУСЬ.\n\nКеша🐤\n\nsome body';
    expect(validatePost(post).errors.some(e => e.includes('too close'))).toBe(false);
  });

  it('does not error when two 🐤 are 600+ chars apart', () => {
    const filler = 'x'.repeat(600);
    const post = `Я ТОЛЬКО УЧУСЬ.\n\nКеша🐤\n\n${filler}\n\nПодпись🐤`;
    expect(validatePost(post).errors.some(e => e.includes('too close'))).toBe(false);
  });
});

describe('validateBossPost', () => {
  it('passes a clean post', () => {
    const text = 'Это обычный пост без проблем. Вполне нормальный текст. 🐤';
    expect(validateBossPost(text)).toEqual({ valid: true, errors: [] });
  });

  it('fails when post exceeds 4096 characters', () => {
    const text = 'a'.repeat(4097);
    const result = validateBossPost(text);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('4097') && e.includes('4096'))).toBe(true);
  });

  it('passes a post of exactly 4096 characters', () => {
    const text = 'a'.repeat(4096);
    expect(validateBossPost(text).valid).toBe(true);
  });

  it('fails with em-dash', () => {
    const text = 'Текст—с длинным тире';
    const result = validateBossPost(text);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('em-dash'))).toBe(true);
  });

  it('fails with markdown bold', () => {
    const text = 'Текст с **bold** словом';
    const result = validateBossPost(text);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('markdown'))).toBe(true);
  });

  it('fails with markdown heading', () => {
    const text = 'Текст\n## Заголовок\nТекст';
    const result = validateBossPost(text);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('markdown'))).toBe(true);
  });

  it('fails with code block', () => {
    const text = 'Текст\n```код```\nТекст';
    const result = validateBossPost(text);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('markdown'))).toBe(true);
  });

  it('collects multiple errors', () => {
    const text = 'x—y **bold**';
    const result = validateBossPost(text);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
