import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../claude.js', () => ({ callClaude: vi.fn(), callClaudeStructured: vi.fn() }));
vi.mock('../sources.js', async () => {
  const actual = await vi.importActual<typeof import('../sources.js')>('../sources.js');
  return {
    ...actual,
    fetchHackerNewsContext: vi.fn(),
    fetchLightWebSearch: vi.fn(),
  };
});
vi.mock('../validator.js', () => ({ validatePost: vi.fn() }));
vi.mock('../url-checker.js', () => ({ findHallucinated: vi.fn() }));
vi.mock('../memory.js', () => ({
  findCallbacks: vi.fn().mockReturnValue([]),
}));

import { generatePipelinePost, extractIntro, selectTopicsForContexts, type SelectedTopics, type ReviewResult, type TopicExperience } from '../pipeline.js';
import { callClaude, callClaudeStructured } from '../claude.js';
import { fetchHackerNewsContext, fetchLightWebSearch } from '../sources.js';
import { validatePost } from '../validator.js';
import { findHallucinated } from '../url-checker.js';
import { findCallbacks } from '../memory.js';
const mockFindCallbacks = vi.mocked(findCallbacks);

const mockCallClaude = vi.mocked(callClaude);
const mockCallClaudeStructured = vi.mocked(callClaudeStructured);
const mockFetchHackerNewsContext = vi.mocked(fetchHackerNewsContext);
const mockFetchLightWebSearch = vi.mocked(fetchLightWebSearch);
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

const okExperiences = (topics: SelectedTopics) => ({
  experiences: topics.topics.map((t, i) => ({
    topicTitle: t.title,
    reaction: `test reaction ${i}`,
    reactionType: (['studied', 'hooked', 'surprised', 'connected', 'confused', 'personal', 'compared'] as const)[i % 7],
  })),
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

// Default: HN returns 10 items, light web search returns '' (empty mock)
beforeEach(() => {
  vi.clearAllMocks();
  mockFindCallbacks.mockReturnValue([]);
  mockFetchHackerNewsContext.mockResolvedValue({ context: 'HN context', itemCount: 10 });
  mockFetchLightWebSearch.mockResolvedValue('');
  mockValidatePost.mockReturnValue({ valid: true, errors: [] });
  mockFindHallucinated.mockReturnValue({ urls: [], handles: [] }); // no hallucinations by default
});

describe('generatePipelinePost', () => {
  it('returns success with post when review is ok (skips rewrite)', async () => {
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.success).toBe(true);
    expect(result.post).toBe(VALID_POST);
    expect(mockCallClaude).toHaveBeenCalledTimes(1);       // generate only
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(3); // select + experience + review
    expect(result.timing).not.toHaveProperty('rewrite');
  });

  it('calls rewrite when review verdict is rework', async () => {
    const rewrittenPost = VALID_POST + ' (rewritten)';
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce({ verdict: 'rework', notes: [{ issue: 'Фраза X звучит generic.' }] } satisfies ReviewResult);
    mockCallClaude
      .mockResolvedValueOnce(VALID_POST)
      .mockResolvedValueOnce(rewrittenPost);

    const result = await generatePipelinePost();

    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(3);
    expect(result.draft).toBe(VALID_POST);
    expect(result.post).toBe(rewrittenPost);
    expect(result.timing).toHaveProperty('rewrite');
  });

  it('skips rewrite when review verdict is minor', async () => {
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce({ verdict: 'minor', notes: [{ issue: 'Небольшое замечание' }] } satisfies ReviewResult);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.post).toBe(VALID_POST);
    expect(result.timing).not.toHaveProperty('rewrite');
  });

  it('auto-fixes post when validation fails on first attempt', async () => {
    const fixedPost = VALID_POST + ' (fixed)';
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
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
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(3);
  });

  it('returns failure with errors when validation fails after all fix attempts', async () => {
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
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
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.hnContext).toBe('HN context');
    expect(result.webContext).toBe(''); // light web search mock returns ''
    expect(result.selectedTopics).toMatchObject({ topics: expect.any(Array), sparseWeek: false });
  });

  it('strips false sparseWeek when 4+ topics returned by model', async () => {
    const customTopics: SelectedTopics = {
      topics: [topic('A'), topic('B'), topic('C'), topic('D')],
      sparseWeek: true,
    };
    mockCallClaudeStructured
      .mockResolvedValueOnce(customTopics)
      .mockResolvedValueOnce(okExperiences(customTopics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.selectedTopics.sparseWeek).toBe(false);

    const generateCall = mockCallClaude.mock.calls[0];
    const userMessage = generateCall[0].userMessage as string;
    expect(userMessage).not.toContain('ВНИМАНИЕ: эта неделя небогатая');
  });

  it('passes sparse week note to generatePost when sparseWeek is true', async () => {
    const customTopics: SelectedTopics = {
      topics: [topic('A'), topic('B'), topic('C')],
      sparseWeek: true,
    };
    mockCallClaudeStructured
      .mockResolvedValueOnce(customTopics)
      .mockResolvedValueOnce(okExperiences(customTopics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost();

    const generateCall = mockCallClaude.mock.calls[0];
    const userMessage = generateCall[0].userMessage as string;
    expect(userMessage).toContain('ВНИМАНИЕ: эта неделя небогатая');
    expect(userMessage).toContain('3 темы');
  });

  it('includes timing keys for each step', async () => {
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.timing).toHaveProperty('gatherContext');
    expect(result.timing).toHaveProperty('selectTopics');
    expect(result.timing).toHaveProperty('experience');
    expect(result.timing).toHaveProperty('generate');
    expect(result.timing).toHaveProperty('review');
  });
});

describe('generatePipelinePost URL hallucination check', () => {
  it('calls fixPost when post contains a hallucinated URL', async () => {
    const badPost = VALID_POST + '\nПодробности: https://fake-hallucinated.example.com/article';
    const fixedPost = VALID_POST;
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
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
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
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

describe('generatePipelinePost parallel context gathering', () => {
  it('returns light web search result as webContext alongside HN context', async () => {
    mockFetchHackerNewsContext.mockResolvedValue({ context: 'HN ctx', itemCount: 10 });
    mockFetchLightWebSearch.mockResolvedValue('light web results');
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.hnContext).toBe('HN ctx');
    expect(result.webContext).toBe('light web results');
    expect(mockCallClaude).toHaveBeenCalledTimes(1);       // generate only
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(3);
  });

  it('returns empty hnContext when HN throws, light web search still runs', async () => {
    mockFetchHackerNewsContext.mockRejectedValue(new Error('API down'));
    mockFetchLightWebSearch.mockResolvedValue('light web results');
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.hnContext).toBe('');
    expect(result.webContext).toBe('light web results');
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });

  it('returns empty webContext when light web search returns empty string', async () => {
    mockFetchHackerNewsContext.mockResolvedValue({ context: 'sparse HN ctx', itemCount: 3 });
    mockFetchLightWebSearch.mockResolvedValue('');
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.hnContext).toBe('sparse HN ctx');
    expect(result.webContext).toBe('');
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });
});

describe('generatePipelinePost with memoryEntries', () => {
  it('injects dedup block into selectTopics system prompt when memoryEntries provided', async () => {
    const topics = okTopics(3);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost({
      memoryEntries: [
        { url: 'https://example.com/x', title: 'OldTopic X', publishedAt: new Date().toISOString(), postId: null },
        { url: 'https://example.com/y', title: 'OldTopic Y', publishedAt: new Date().toISOString(), postId: null },
      ],
    });

    const selectCallParams = mockCallClaudeStructured.mock.calls[0][0];
    expect(selectCallParams.systemPrompt).toContain('OldTopic X');
    expect(selectCallParams.systemPrompt).toContain('НЕ повторяй');
    expect(selectCallParams.systemPrompt).toContain('ТЕМЫ ИЗ ПОСЛЕДНИХ ПОСТОВ');
  });

  it('does not add dedup block when memoryEntries is empty array', async () => {
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost({ memoryEntries: [] });

    const selectCallParams = mockCallClaudeStructured.mock.calls[0][0];
    expect(selectCallParams.systemPrompt).not.toContain('НЕ повторяй');
  });

  it('does not add dedup block when no options provided', async () => {
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost();

    const selectCallParams = mockCallClaudeStructured.mock.calls[0][0];
    expect(selectCallParams.systemPrompt).not.toContain('НЕ повторяй');
  });
});

describe('generatePipelinePost with previousIntros', () => {
  it('injects intros block into generatePost user message when previousIntros provided', async () => {
    const topics = okTopics(3);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
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
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost({ previousIntros: [] });

    const generateCallParams = mockCallClaude.mock.calls[0][0];
    expect(generateCallParams.userMessage).not.toContain('НЕ повторяй');
  });
});

describe('generatePipelinePost with callbacks', () => {
  it('injects CALLBACK CONTEXT into generatePost when findCallbacks returns matches', async () => {
    const callbackEntry = {
      url: '',
      title: 'GPT-5 Flash release',
      publishedAt: new Date(Date.now() - 3 * 7 * 24 * 60 * 60 * 1000).toISOString(),
      postId: null,
    };
    mockFindCallbacks.mockReturnValueOnce([callbackEntry]);

    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost({
      memoryEntries: [callbackEntry],
    });

    const generateCallParams = mockCallClaude.mock.calls[0][0];
    expect(generateCallParams.userMessage).toContain('CALLBACK CONTEXT');
    expect(generateCallParams.userMessage).toContain('GPT-5 Flash release');
  });

  it('does not inject CALLBACK CONTEXT when findCallbacks returns empty', async () => {
    mockFindCallbacks.mockReturnValueOnce([]);

    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost({ memoryEntries: [] });

    const generateCallParams = mockCallClaude.mock.calls[0][0];
    expect(generateCallParams.userMessage).not.toContain('CALLBACK CONTEXT');
  });

  it('uses correct Russian plural form for weeks (5 weeks → недель)', async () => {
    const fiveWeeksAgo = new Date(Date.now() - 5 * 7 * 24 * 60 * 60 * 1000).toISOString();
    const callbackEntry = {
      url: '', title: 'Some old release', publishedAt: fiveWeeksAgo, postId: null as null,
    };
    mockFindCallbacks.mockReturnValueOnce([callbackEntry]);
    const topics = okTopics(1);
    mockCallClaudeStructured
      .mockResolvedValueOnce(topics)
      .mockResolvedValueOnce(okExperiences(topics))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    await generatePipelinePost({ memoryEntries: [callbackEntry] });

    const generateCallParams = mockCallClaude.mock.calls[0][0];
    expect(generateCallParams.userMessage).toContain('5 недель');
    expect(generateCallParams.userMessage).not.toContain('5 недели');
  });
});

describe('generatePipelinePost with experience step', () => {
  it('calls experienceTopics and passes reactions to generatePost', async () => {
    const experiences: { experiences: TopicExperience[] } = {
      experiences: [
        { topicTitle: 'Topic 1', reaction: 'полез в доку - подозрительно просто', reactionType: 'studied' },
      ],
    };

    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))      // selectTopics
      .mockResolvedValueOnce(experiences)       // experienceTopics
      .mockResolvedValueOnce(okReview);         // reviewPost
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.success).toBe(true);
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(3); // select + experience + review
    // Verify experience reactions are passed to generatePost
    const generateCallParams = mockCallClaude.mock.calls[0][0];
    expect(generateCallParams.userMessage).toContain('Твоя реакция: полез в доку');
  });

  it('includes timing for experience step', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce({ experiences: [{ topicTitle: 'Topic 1', reaction: 'test', reactionType: 'hooked' }] })
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.timing).toHaveProperty('experience');
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

describe('selectTopicsForContexts', () => {
  it('selects topics from contexts and reads config internally', async () => {
    const topics = okTopics(2);
    mockCallClaudeStructured.mockResolvedValueOnce(topics);

    const result = await selectTopicsForContexts('HN context', 'WEB context', []);

    expect(result).toEqual(topics);
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(1);
    const callParams = mockCallClaudeStructured.mock.calls[0][0];
    expect(callParams.userMessage).toContain('HN context');
    expect(callParams.userMessage).toContain('WEB context');
  });

  it('injects dedup block when memoryEntries provided', async () => {
    mockCallClaudeStructured.mockResolvedValueOnce(okTopics(2));
    await selectTopicsForContexts('HN', 'WEB', [
      { url: 'https://example.com/x', title: 'OldTopic Z', publishedAt: new Date().toISOString(), postId: null },
    ]);
    const callParams = mockCallClaudeStructured.mock.calls[0][0];
    expect(callParams.systemPrompt).toContain('OldTopic Z');
  });
});
