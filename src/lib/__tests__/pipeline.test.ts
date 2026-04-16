import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../claude.js', () => ({ callClaude: vi.fn() }));
vi.mock('../rss.js', () => ({ fetchRssContext: vi.fn() }));
vi.mock('../validator.js', () => ({ validatePost: vi.fn() }));

import { generatePipelinePost, extractIntro } from '../pipeline.js';
import { callClaude } from '../claude.js';
import { fetchRssContext } from '../rss.js';
import { validatePost } from '../validator.js';

const mockCallClaude = vi.mocked(callClaude);
const mockFetchRssContext = vi.mocked(fetchRssContext);
const mockValidatePost = vi.mocked(validatePost);

const VALID_POST = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ. Не бейте. 🐤

Кеша на проводе🐤

Тестовый пост.`;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchRssContext.mockResolvedValue('RSS context');
  mockValidatePost.mockReturnValue({ valid: true, errors: [] });
});

describe('generatePipelinePost', () => {
  it('returns success with post when review says хорошо (skips rewrite)', async () => {
    mockCallClaude
      .mockResolvedValueOnce('web context')        // fetchWebContext
      .mockResolvedValueOnce('topic 1, topic 2')   // selectTopics
      .mockResolvedValueOnce(VALID_POST)            // generatePost
      .mockResolvedValueOnce('хорошо\n\nВсё отлично!'); // reviewPost

    const result = await generatePipelinePost();

    expect(result.success).toBe(true);
    expect(result.post).toBe(VALID_POST);
    expect(mockCallClaude).toHaveBeenCalledTimes(4); // no rewrite
    expect(result.timing).not.toHaveProperty('rewrite');
  });

  it('calls rewrite when review does not start with хорошо', async () => {
    const rewrittenPost = VALID_POST + ' (rewritten)';
    mockCallClaude
      .mockResolvedValueOnce('web context')
      .mockResolvedValueOnce('topic 1')
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce('нужна переработка\n\nФраза X звучит generic.')
      .mockResolvedValueOnce(rewrittenPost);

    const result = await generatePipelinePost();

    expect(mockCallClaude).toHaveBeenCalledTimes(5);
    expect(result.draft).toBe(VALID_POST);
    expect(result.post).toBe(rewrittenPost);
    expect(result.timing).toHaveProperty('rewrite');
  });

  it('auto-fixes post when validation fails on first attempt', async () => {
    const fixedPost = VALID_POST + ' (fixed)';
    mockCallClaude
      .mockResolvedValueOnce('web context')
      .mockResolvedValueOnce('topics')
      .mockResolvedValueOnce('too long post')
      .mockResolvedValueOnce('хорошо')
      .mockResolvedValueOnce(fixedPost); // fixPost call

    mockValidatePost
      .mockReturnValueOnce({ valid: false, errors: ['Post too long: 4029 chars (max 4000)'] })
      .mockReturnValueOnce({ valid: true, errors: [] });

    const result = await generatePipelinePost();

    expect(result.success).toBe(true);
    expect(result.post).toBe(fixedPost);
    expect(result.timing).toHaveProperty('fix1');
    expect(mockCallClaude).toHaveBeenCalledTimes(5);
  });

  it('returns failure with errors when validation fails after all fix attempts', async () => {
    mockCallClaude.mockResolvedValue('some text');
    mockValidatePost.mockReturnValue({ valid: false, errors: ['Missing 🐤 emoji'] });

    const result = await generatePipelinePost();

    expect(result.success).toBe(false);
    expect(result.errors).toContain('Missing 🐤 emoji');
    expect(result.post).toBeUndefined();
    expect(result.timing).toHaveProperty('fix1');
    expect(result.timing).toHaveProperty('fix2');
  });

  it('exposes rssContext, webContext, selectedTopics in result', async () => {
    mockCallClaude
      .mockResolvedValueOnce('web findings')
      .mockResolvedValueOnce('topics')
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce('хорошо');

    const result = await generatePipelinePost();

    expect(result.rssContext).toBe('RSS context');
    expect(result.webContext).toBe('web findings');
    expect(result.selectedTopics).toBe('topics');
  });

  it('strips false SPARSE_WEEK when 4+ numbered topics are present', async () => {
    const falseSparseTopic = '1. Topic A\n2. Topic B\n3. Topic C\n4. Topic D\nSPARSE_WEEK';
    mockCallClaude
      .mockResolvedValueOnce('web context')
      .mockResolvedValueOnce(falseSparseTopic)
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce('хорошо');

    const result = await generatePipelinePost();

    const generateCall = mockCallClaude.mock.calls[2];
    const userMessage = generateCall[0].userMessage as string;
    expect(userMessage).not.toContain('SPARSE_WEEK');
    expect(result.selectedTopics).not.toContain('SPARSE_WEEK');
  });

  it('passes SPARSE_WEEK hint to generatePost when selectTopics includes it', async () => {
    const sparseTopics = 'Topic 1\nTopic 2\nSPARSE_WEEK';
    mockCallClaude
      .mockResolvedValueOnce('web context')
      .mockResolvedValueOnce(sparseTopics)
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce('хорошо');

    await generatePipelinePost();

    const generateCall = mockCallClaude.mock.calls[2];
    const userMessage = generateCall[0].userMessage as string;
    expect(userMessage).toContain('SPARSE_WEEK');
    expect(userMessage).toContain('3 темы');
  });

  it('includes timing keys for each step', async () => {
    mockCallClaude
      .mockResolvedValueOnce('web')
      .mockResolvedValueOnce('topics')
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce('хорошо');

    const result = await generatePipelinePost();

    expect(result.timing).toHaveProperty('gatherContext');
    expect(result.timing).toHaveProperty('selectTopics');
    expect(result.timing).toHaveProperty('generate');
    expect(result.timing).toHaveProperty('review');
  });
});

describe('generatePipelinePost with publishedTopics', () => {
  it('injects dedup block into selectTopics system prompt when publishedTopics provided', async () => {
    mockCallClaude
      .mockResolvedValueOnce('web context')
      .mockResolvedValueOnce('1. Topic A\n2. Topic B\n3. Topic C')
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce('хорошо');

    await generatePipelinePost({
      publishedTopics: ['1. OldTopic X (Anthropic)', '1. OldTopic Y (OpenAI)'],
    });

    const selectCall = mockCallClaude.mock.calls[1];
    expect(selectCall[0].systemPrompt).toContain('OldTopic X');
    expect(selectCall[0].systemPrompt).toContain('НЕ повторяй');
  });

  it('does not add dedup block when publishedTopics is empty array', async () => {
    mockCallClaude
      .mockResolvedValueOnce('web context')
      .mockResolvedValueOnce('1. Topic A\n2. Topic B\n3. Topic C')
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce('хорошо');

    await generatePipelinePost({ publishedTopics: [] });

    const selectCall = mockCallClaude.mock.calls[1];
    expect(selectCall[0].systemPrompt).not.toContain('НЕ повторяй');
  });

  it('does not add dedup block when no options provided', async () => {
    mockCallClaude
      .mockResolvedValueOnce('web context')
      .mockResolvedValueOnce('1. Topic A')
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce('хорошо');

    await generatePipelinePost();

    const selectCall = mockCallClaude.mock.calls[1];
    expect(selectCall[0].systemPrompt).not.toContain('НЕ повторяй');
  });
});

describe('generatePipelinePost with previousIntros', () => {
  it('injects intros block into generatePost user message when previousIntros provided', async () => {
    mockCallClaude
      .mockResolvedValueOnce('web context')
      .mockResolvedValueOnce('1. Topic A\n2. Topic B\n3. Topic C')
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce('хорошо');

    await generatePipelinePost({
      previousIntros: ['Четверг, прогрелся, завис на HN.', 'Пятница, читал RSS.'],
    });

    const generateCall = mockCallClaude.mock.calls[2];
    expect(generateCall[0].userMessage).toContain('Четверг, прогрелся');
    expect(generateCall[0].userMessage).toContain('НЕ повторяй');
  });

  it('does not add intros block when previousIntros is empty', async () => {
    mockCallClaude
      .mockResolvedValueOnce('web context')
      .mockResolvedValueOnce('1. Topic A')
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce('хорошо');

    await generatePipelinePost({ previousIntros: [] });

    const generateCall = mockCallClaude.mock.calls[2];
    expect(generateCall[0].userMessage).not.toContain('НЕ повторяй');
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
