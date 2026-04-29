import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../claude.js', () => ({ callClaude: vi.fn() }));
vi.mock('../validator.js', () => ({
  validatePost: vi.fn(),
  validateBossPost: vi.fn(),
}));

import { runBossPipeline } from '../boss-pipeline.js';
import { callClaude } from '../claude.js';
import { validateBossPost } from '../validator.js';

const mockCallClaude = vi.mocked(callClaude);
const mockValidateBossPost = vi.mocked(validateBossPost);

function makeReviewJson(verdict: 'READY' | 'RAW', correctedText = 'Corrected text.'): string {
  return JSON.stringify({
    verdict,
    verdict_reason: verdict === 'READY' ? 'Текст живой и разговорный.' : 'Текст сухой.',
    corrected_text: correctedText,
    grammar_notes: 'без замечаний',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateBossPost.mockReturnValue({ valid: true, errors: [] });
});

describe('runBossPipeline — READY branch', () => {
  it('returns READY branch with corrected_text when verdict is READY', async () => {
    mockCallClaude.mockResolvedValueOnce(makeReviewJson('READY', 'Исправленный текст.'));

    const result = await runBossPipeline('Некоторый текст поста.', {});

    expect(result.success).toBe(true);
    expect(result.branch).toBe('READY');
    expect(result.finalText).toBe('Исправленный текст.');
    expect(result.rewriteOutput).toBeNull();
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });

  it('does not call rewrite when verdict is READY', async () => {
    mockCallClaude.mockResolvedValueOnce(makeReviewJson('READY'));

    await runBossPipeline('Некоторый текст.', {});

    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });

  it('returns READY branch when forceSkip=true even if verdict is RAW', async () => {
    mockCallClaude.mockResolvedValueOnce(makeReviewJson('RAW', 'Сырой текст.'));

    const result = await runBossPipeline('Некоторый текст.', { forceSkip: true });

    expect(result.branch).toBe('READY');
    expect(result.finalText).toBe('Сырой текст.');
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });
});

describe('runBossPipeline — RAW branch', () => {
  it('calls rewrite and returns RAW branch when verdict is RAW', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('RAW', 'Сырой текст.'))
      .mockResolvedValueOnce('Переписанный текст в голосе Кеши.');

    const result = await runBossPipeline('Сырой черновик.', {});

    expect(result.success).toBe(true);
    expect(result.branch).toBe('RAW');
    expect(result.finalText).toBe('Переписанный текст в голосе Кеши.');
    expect(result.rewriteOutput).toBe('Переписанный текст в голосе Кеши.');
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it('returns RAW branch when forceRaw=true even if verdict is READY', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('READY', 'Готовый текст.'))
      .mockResolvedValueOnce('Принудительно переписанный текст.');

    const result = await runBossPipeline('Готовый текст.', { forceRaw: true });

    expect(result.branch).toBe('RAW');
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it('calls onProgress with rewrite status before calling rewrite', async () => {
    const callOrder: string[] = [];
    mockCallClaude
      .mockImplementationOnce(async () => { callOrder.push('review'); return makeReviewJson('RAW'); })
      .mockImplementationOnce(async () => { callOrder.push('rewrite'); return 'Rewritten.'; });

    const onProgress = vi.fn().mockImplementation(async () => { callOrder.push('progress'); });
    await runBossPipeline('Сырой.', {}, onProgress);

    expect(onProgress).toHaveBeenCalledWith('✍️ Текст сыроват, переписываю голосом Кеши...');
    expect(callOrder.indexOf('progress')).toBeLessThan(callOrder.indexOf('rewrite'));
  });
});

describe('runBossPipeline — review retry', () => {
  it('retries review once when response is not valid JSON', async () => {
    mockCallClaude
      .mockResolvedValueOnce('не JSON')
      .mockResolvedValueOnce(makeReviewJson('READY'));

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it('returns failure when review fails JSON parse twice', async () => {
    mockCallClaude
      .mockResolvedValueOnce('не JSON')
      .mockResolvedValueOnce('тоже не JSON');

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('runBossPipeline — rewrite retry', () => {
  it('retries rewrite once when output contains em-dash', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('RAW'))
      .mockResolvedValueOnce('Текст\u2014с тире')
      .mockResolvedValueOnce('Текст без тире.');

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(true);
    expect(result.finalText).toBe('Текст без тире.');
    expect(mockCallClaude).toHaveBeenCalledTimes(3);
  });

  it('retries rewrite once when output contains markdown', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('RAW'))
      .mockResolvedValueOnce('Текст **bold** слово')
      .mockResolvedValueOnce('Текст без разметки.');

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(true);
    expect(result.finalText).toBe('Текст без разметки.');
  });

  it('returns failure when rewrite still has em-dash after retry', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('RAW'))
      .mockResolvedValueOnce('Текст\u2014тире')
      .mockResolvedValueOnce('Снова\u2014тире');

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('em-dash');
  });
});

describe('runBossPipeline — validation failure', () => {
  it('returns failure when validateBossPost fails on READY branch', async () => {
    mockCallClaude.mockResolvedValueOnce(makeReviewJson('READY', 'Слишком длинный текст.'));
    mockValidateBossPost.mockReturnValue({ valid: false, errors: ['Post too long: 5000 chars (max 4096)'] });

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Post too long');
  });

  it('returns failure when validateBossPost fails on RAW branch', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('RAW'))
      .mockResolvedValueOnce('Текст с проблемами.');
    mockValidateBossPost.mockReturnValue({ valid: false, errors: ['Contains em-dash (—)'] });

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('em-dash');
  });
});
