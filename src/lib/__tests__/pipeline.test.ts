import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../claude.js', () => ({ callClaude: vi.fn(), callClaudeStructured: vi.fn() }));
vi.mock('../sources.js', () => ({ fetchHackerNewsContext: vi.fn() }));
vi.mock('../validator.js', () => ({ validatePost: vi.fn() }));
vi.mock('../url-checker.js', () => ({ findHallucinated: vi.fn() }));

import { generatePipelinePost, extractIntro, type SelectedTopics, type ReviewResult } from '../pipeline.js';
import { callClaude, callClaudeStructured } from '../claude.js';
import { fetchHackerNewsContext } from '../sources.js';
import { validatePost } from '../validator.js';
import { findHallucinated } from '../url-checker.js';

const mockCallClaude = vi.mocked(callClaude);
const mockCallClaudeStructured = vi.mocked(callClaudeStructured);
const mockFetchHackerNewsContext = vi.mocked(fetchHackerNewsContext);
const mockValidatePost = vi.mocked(validatePost);
const mockFindHallucinated = vi.mocked(findHallucinated);

// A single SelectedTopic helper
const topic = (title = 'A'): SelectedTopics['topics'][0] => ({
  title, summary: 's', sourceUrl: 'https://u', sourceOrigin: 'hn', tier: 1,
});

const okTopics = (n = 1): SelectedTopics => ({
  topics: Array.from({ length: n }, (_, i) => topic(`Topic ${i + 1}`)),
  sparseWeek: false,
});

const okReview: ReviewResult = { verdict: 'ok', notes: [] };

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

// Default: HN returns enough items to skip web search fallback (threshold=8 in sources.json)
beforeEach(() => {
  vi.clearAllMocks();
  mockFetchHackerNewsContext.mockResolvedValue({ context: 'HN context', itemCount: 10 });
  mockValidatePost.mockReturnValue({ valid: true, errors: [] });
  mockFindHallucinated.mockReturnValue({ urls: [], handles: [] }); // no hallucinations by default
});

describe('generatePipelinePost', () => {
  it('returns success with post when review is ok (skips rewrite)', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.success).toBe(true);
    expect(result.post).toBe(VALID_POST);
    expect(mockCallClaude).toHaveBeenCalledTimes(1);       // generate only
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(2); // select + review
    expect(result.timing).not.toHaveProperty('rewrite');
  });

  it('calls rewrite when review verdict is rework', async () => {
    const rewrittenPost = VALID_POST + ' (rewritten)';
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce({ verdict: 'rework', notes: [{ issue: 'Фраза X звучит generic.' }] } satisfies ReviewResult);
    mockCallClaude
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce(rewrittenPost);

    const result = await generatePipelinePost();

    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(2);
    expect(result.draft).toBe(VALID_POST);
    expect(result.post).toBe(rewrittenPost);
    expect(result.timing).toHaveProperty('rewrite');
  });

  it('skips rewrite when review verdict is minor', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce({ verdict: 'minor', notes: [{ issue: 'Небольшое замечание' }] } satisfies ReviewResult);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.post).toBe(VALID_POST);
    expect(result.timing).not.toHaveProperty('rewrite');
  });

  it('auto-fixes post when validation fails on first attempt', async () => {
    const fixedPost = VALID_POST + ' (fixed)';
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude
      .mockResolvedValueOnce('too long post')
      .mockResolvedValueOnce(fixedPost);

    mockValidatePost
      .mockReturnValueOnce({ valid: false, errors: ['Post too long: 4029 chars (max 4000)'] })
      .mockReturnValueOnce({ valid: true, errors: [] });

    const result = await generatePipelinePost();

    expect(result.success).toBe(true);
    expect(result.post).toBe(fixedPost);
    expect(result.timing).toHaveProperty('fix1');
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(2);
  });

  it('returns failure with errors when validation fails after all fix attempts', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValue('some text');
    mockValidatePost.mockReturnValue({ valid: false, errors: ['Missing 🐤 emoji'] });

    const result = await generatePipelinePost();

    expect(result.success).toBe(false);
    expect(result.errors).toContain('Missing 🐤 emoji');
    expect(result.post).toBeUndefined();
    expect(result.timing).toHaveProperty('fix1');
    expect(result.timing).toHaveProperty('fix2');
  });

  it('exposes hnContext, webContext, selectedTopics in result', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.hnContext).toBe('HN context');
    expect(result.webContext).toBe(''); // HN above threshold → web skipped
    expect(result.selectedTopics).toMatchObject({ topics: expect.any(Array), sparseWeek: false });
  });

  it('strips false sparseWeek when 4+ topics returned by model', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce({
        topics: [
          topic('A'), topic('B'), topic('C'), topic('D'),
        ],
        sparseWeek: true,
      } satisfies SelectedTopics)
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.selectedTopics.sparseWeek).toBe(false);

    const generateCall = mockCallClaude.mock.calls[0];
    const userMessage = generateCall[0].userMessage as string;
    expect(userMessage).not.toContain('ВНИМАНИЕ: эта неделя небогатая');
  });

  it('passes sparse week note to generatePost when sparseWeek is true', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce({
        topics: [topic('A'), topic('B'), topic('C')],
        sparseWeek: true,
      } satisfies SelectedTopics)
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost();

    const generateCall = mockCallClaude.mock.calls[0];
    const userMessage = generateCall[0].userMessage as string;
    expect(userMessage).toContain('ВНИМАНИЕ: эта неделя небогатая');
    expect(userMessage).toContain('3 темы');
  });

  it('includes timing keys for each step', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.timing).toHaveProperty('gatherContext');
    expect(result.timing).toHaveProperty('selectTopics');
    expect(result.timing).toHaveProperty('generate');
    expect(result.timing).toHaveProperty('review');
  });
});

describe('generatePipelinePost URL hallucination check', () => {
  it('calls fixPost when post contains a hallucinated URL', async () => {
    const badPost = VALID_POST + '\nПодробности: https://fake-hallucinated.example.com/article';
    const fixedPost = VALID_POST;
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude
      .mockResolvedValueOnce(badPost)   // generatePost returns post with hallucinated URL
      .mockResolvedValueOnce(fixedPost); // fixPost removes it

    mockFindHallucinated
      .mockReturnValueOnce({ urls: ['https://fake-hallucinated.example.com/article'], handles: [] })
      .mockReturnValueOnce({ urls: [], handles: [] }); // clean after fix

    const result = await generatePipelinePost();

    expect(result.success).toBe(true);
    expect(result.post).toBe(fixedPost);
    expect(result.timing).toHaveProperty('fix1');
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it('returns failure when hallucinated URLs persist after all fix attempts', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValue(VALID_POST);
    mockFindHallucinated.mockReturnValue({
      urls: ['https://still-fake.example.com'],
      handles: [],
    });

    const result = await generatePipelinePost();

    expect(result.success).toBe(false);
    expect(result.errors?.some(e => e.includes('Hallucinated URL'))).toBe(true);
    expect(result.timing).toHaveProperty('fix1');
    expect(result.timing).toHaveProperty('fix2');
  });
});

describe('generatePipelinePost web search fallback', () => {
  it('skips web search when HN returns enough items', async () => {
    mockFetchHackerNewsContext.mockResolvedValue({ context: 'HN ctx', itemCount: 10 });
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.webContext).toBe('');
    expect(mockCallClaude).toHaveBeenCalledTimes(1);       // generate only
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(2);
  });

  it('runs web search when HN throws (API unavailable)', async () => {
    mockFetchHackerNewsContext.mockRejectedValue(new Error('API down'));
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude
      .mockResolvedValueOnce('web fallback findings') // fetchWebContext
      .mockResolvedValueOnce(VALID_POST);             // generatePost

    const result = await generatePipelinePost();

    expect(result.hnContext).toBe('');
    expect(result.webContext).toBe('web fallback findings');
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it('runs web search when HN itemCount is below threshold (sparse week)', async () => {
    mockFetchHackerNewsContext.mockResolvedValue({ context: 'sparse HN ctx', itemCount: 3 });
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude
      .mockResolvedValueOnce('web supplement') // fetchWebContext
      .mockResolvedValueOnce(VALID_POST);      // generatePost

    const result = await generatePipelinePost();

    expect(result.hnContext).toBe('sparse HN ctx');
    expect(result.webContext).toBe('web supplement');
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });
});

describe('generatePipelinePost with publishedTopics', () => {
  it('injects dedup block into selectTopics system prompt when publishedTopics provided', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(3))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost({
      publishedTopics: ['1. OldTopic X (Anthropic)', '1. OldTopic Y (OpenAI)'],
    });

    const selectCallParams = mockCallClaudeStructured.mock.calls[0][0];
    expect(selectCallParams.systemPrompt).toContain('OldTopic X');
    expect(selectCallParams.systemPrompt).toContain('НЕ повторяй');
  });

  it('does not add dedup block when publishedTopics is empty array', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost({ publishedTopics: [] });

    const selectCallParams = mockCallClaudeStructured.mock.calls[0][0];
    expect(selectCallParams.systemPrompt).not.toContain('НЕ повторяй');
  });

  it('does not add dedup block when no options provided', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost();

    const selectCallParams = mockCallClaudeStructured.mock.calls[0][0];
    expect(selectCallParams.systemPrompt).not.toContain('НЕ повторяй');
  });
});

describe('generatePipelinePost with previousIntros', () => {
  it('injects intros block into generatePost user message when previousIntros provided', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(3))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost({
      previousIntros: ['Четверг, прогрелся, завис на HN.', 'Пятница, читал RSS.'],
    });

    const generateCallParams = mockCallClaude.mock.calls[0][0];
    expect(generateCallParams.userMessage).toContain('Четверг, прогрелся');
    expect(generateCallParams.userMessage).toContain('НЕ повторяй');
  });

  it('does not add intros block when previousIntros is empty', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost({ previousIntros: [] });

    const generateCallParams = mockCallClaude.mock.calls[0][0];
    expect(generateCallParams.userMessage).not.toContain('НЕ повторяй');
  });
});

describe('extractIntro', () => {
  it('returns text before first ~ ~ ~ separator, trimmed', () => {
    const post = 'Кеша на проводе.\n\nПривет, это интро.\n\n~ ~ ~\n\nСекция 1.';
    expect(extractIntro(post)).toBe('Кеша на проводе.\n\nПривет, это интро.');
  });

  it('returns first 500 chars when no separator present', () => {
    const post = 'a'.repeat(600);
    expect(extractIntro(post)).toBe('a'.repeat(500));
  });

  it('returns empty string when post is empty', () => {
    expect(extractIntro('')).toBe('');
  });

  it('handles post shorter than 500 chars with no separator', () => {
    const post = 'short post without separator';
    expect(extractIntro(post)).toBe('short post without separator');
  });

  it('returns empty string when separator is at position 0', () => {
    expect(extractIntro('~ ~ ~\n\nRest of post')).toBe('');
  });
});
