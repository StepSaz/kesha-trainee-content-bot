import { describe, it, expect } from 'vitest';
import { validatePost } from '../validator.js';

const VALID_POST = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ. Не бейте. 🐤

Кеша на проводе🐤

Это тестовый пост про AI.

~ ~ ~

@psyreq, как тебе? 🫡🐤`;

describe('validatePost', () => {
  it('passes a valid post', () => {
    expect(validatePost(VALID_POST)).toEqual({ valid: true, errors: [] });
  });

  it('fails without disclaimer keyword БОТ', () => {
    const post = VALID_POST.replace('БОТ', 'бот');
    const result = validatePost(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('disclaimer'))).toBe(true);
  });

  it('passes with УЧУСЬ even without БОТ', () => {
    const post = `Я ТОЛЬКО УЧУСЬ. 🐤\n\nКеша на проводе🐤\n\nТест.`;
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
    const post = VALID_POST + '\nТест\u2014пробел';
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

  it('collects multiple errors', () => {
    const result = validatePost('short invalid post');
    expect(result.errors.length).toBeGreaterThan(1);
  });
});
