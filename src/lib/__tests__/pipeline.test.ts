import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../claude.js', () => ({ callClaude: vi.fn() }));
vi.mock('../rss.js', () => ({ fetchRssContext: vi.fn() }));
vi.mock('../validator.js', () => ({ validatePost: vi.fn() }));

import { generatePipelinePost } from '../pipeline.js';
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

  it('returns failure with errors when validation fails', async () => {
    mockCallClaude.mockResolvedValue('some text');
    mockValidatePost.mockReturnValue({ valid: false, errors: ['Missing 🐤 emoji'] });

    const result = await generatePipelinePost();

    expect(result.success).toBe(false);
    expect(result.errors).toContain('Missing 🐤 emoji');
    expect(result.post).toBeUndefined();
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
