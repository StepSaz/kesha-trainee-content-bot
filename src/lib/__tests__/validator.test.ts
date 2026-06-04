import { describe, it, expect } from 'vitest';
import { validatePost, validateBossPost, validateShort, countLinkedSources } from '../validator.js';

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

const VALID_SHORT = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ.

Кеша на проводе🐤 Главное за неделю одной строкой:

📎 Anthropic выпустила Claude Opus 4.8 - новый флагман https://example.com/1
📎 OpenAI снизила цены на API вдвое https://example.com/2
📎 Google показал Gemini 3 на конференции https://example.com/3

Вывод: неделя жирная на релизы, выбирай инструмент под задачу.

Ваш стажер-Кеша @st_szs 🐤`;

describe('countLinkedSources', () => {
  it('counts lines that start with 📎 and contain a URL', () => {
    expect(countLinkedSources(VALID_SHORT)).toBe(3);
  });
  it('does not count a 📎 line without a URL', () => {
    expect(countLinkedSources('📎 новость без ссылки\n📎 есть https://u/1')).toBe(1);
  });
  it('does not count 📎 that is not the first character', () => {
    expect(countLinkedSources('текст 📎 https://u/1')).toBe(0);
  });
  it('does not count a 📎 line with leading spaces (📎 must be first char)', () => {
    expect(countLinkedSources('   📎 новость https://u/1')).toBe(0);
  });
});

describe('validateShort', () => {
  it('passes a valid short digest', () => {
    expect(validateShort(VALID_SHORT)).toEqual({ valid: true, errors: [] });
  });
  it('fails when fewer than 3 linked sources', () => {
    const post = VALID_SHORT.replace('📎 Google показал Gemini 3 на конференции https://example.com/3\n', '');
    const result = validateShort(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('linked sources'))).toBe(true);
  });
  it('fails when conclusion is missing after the last source line', () => {
    const post = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ.

Кеша на проводе🐤

📎 a https://example.com/1
📎 b https://example.com/2
📎 c https://example.com/3`;
    const result = validateShort(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('conclusion'))).toBe(true);
  });
  it('fails on em-dash', () => {
    expect(validateShort(VALID_SHORT.replace(' - ', ' — ')).valid).toBe(false);
  });
  it('fails on list bullets (-, * or •)', () => {
    const post = VALID_SHORT.replace('📎 Anthropic', '- Anthropic');
    const result = validateShort(post);
    expect(result.errors.some(e => e.includes('list bullets'))).toBe(true);
  });
  it('fails when too long', () => {
    const post = VALID_SHORT + '\n' + 'x'.repeat(1600);
    expect(validateShort(post).errors.some(e => e.includes('too long'))).toBe(true);
  });
  it('fails without disclaimer / Кеша / 🐤', () => {
    expect(validateShort('просто текст со ссылкой https://u/1').valid).toBe(false);
  });

  it('passes when the conclusion line embeds a URL', () => {
    const post = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ.

Кеша на проводе🐤 Главное за неделю одной строкой:

📎 Anthropic выпустила Claude Opus 4.8 https://example.com/1
📎 OpenAI снизила цены на API https://example.com/2
📎 Google показал Gemini 3 https://example.com/3

Вывод: ставлю на Opus, детали тут https://example.com/recap`;
    const result = validateShort(post);
    expect(result.errors.some((e) => e.includes('conclusion'))).toBe(false);
    expect(result.valid).toBe(true);
  });

  it('still fails when only a bare URL line follows the sources', () => {
    const post = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ.

Кеша на проводе🐤

📎 a https://example.com/1
📎 b https://example.com/2
📎 c https://example.com/3
https://example.com/extra`;
    const result = validateShort(post);
    expect(result.errors.some((e) => e.includes('conclusion'))).toBe(true);
  });
});
