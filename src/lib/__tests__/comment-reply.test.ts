import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Anthropic SDK for the agentic-loop integration test below.
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import {
  extractPostContext,
  buildPostMetaLines,
  composeCommentUserMessage,
  parseCommentIntent,
  sanitizeCommentResponse,
  type ReplyToMessageLike,
} from '../comment-reply.js';
import { callClaudeWithTools } from '../claude.js';
import { COMMENT_TOOLS, makeExecuteTool } from '../comment-tools.js';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.TAVILY_API_KEY = 'test';
  process.env.TELEGRAM_BOT_TOKEN = 'test';
  mockCreate.mockReset();
  vi.unstubAllGlobals();
});

describe('parseCommentIntent', () => {
  it.each([
    ['расширь, плз', 'expand'],
    ['напиши подробнее', 'expand'],
    ['объясни что это', 'explain'],
    ['что такое RAG', 'explain'],
    ['сравни Haiku и Sonnet', 'compare'],
    ['Cursor vs Windsurf', 'compare'],
    ['привет, как дела', 'freeform'],
  ])('classifies %s as %s', (text, expected) => {
    expect(parseCommentIntent(text)).toBe(expected);
  });
});

describe('extractPostContext', () => {
  it('handles text-only post with no entities', () => {
    const ctx = extractPostContext({ text: 'просто пост про AI' });
    expect(ctx).toEqual({
      postText: 'просто пост про AI',
      postUrls: [],
      photoFileId: undefined,
      inMediaGroup: false,
      hasCaption: true,
    });
  });

  it('falls back to caption when text absent', () => {
    const ctx = extractPostContext({
      caption: 'подпись к фотке',
      photo: [{ file_id: 'small' }, { file_id: 'large' }],
    });
    expect(ctx.postText).toBe('подпись к фотке');
    expect(ctx.photoFileId).toBe('large');
    expect(ctx.hasCaption).toBe(true);
  });

  it('uses placeholder for photo without caption', () => {
    const ctx = extractPostContext({
      photo: [{ file_id: 'only' }],
    });
    expect(ctx.postText).toBe('[пост без подписи, только картинка]');
    expect(ctx.photoFileId).toBe('only');
    expect(ctx.hasCaption).toBe(false);
  });

  it('uses fallback when nothing is available', () => {
    expect(extractPostContext(undefined).postText).toBe('[текст поста недоступен]');
  });

  it('detects media group', () => {
    const ctx = extractPostContext({
      photo: [{ file_id: 'one' }],
      media_group_id: '123',
    });
    expect(ctx.inMediaGroup).toBe(true);
  });

  it('extracts text_link entity URL (https only)', () => {
    const ctx = extractPostContext({
      text: 'кликни сюда',
      entities: [
        { type: 'text_link', offset: 0, length: 6, url: 'https://safe.com' },
        { type: 'text_link', offset: 0, length: 6, url: 'http://insecure.com' },
        { type: 'text_link', offset: 0, length: 6 }, // no url field
      ],
    });
    expect(ctx.postUrls).toEqual(['https://safe.com']);
  });

  it('extracts inline url entity by slicing text', () => {
    const url1 = 'https://example.com/article';
    const url2 = 'ftp://nope.com';
    const text = `смотри ${url1} и ещё ${url2}`;
    const ctx = extractPostContext({
      text,
      entities: [
        { type: 'url', offset: text.indexOf(url1), length: url1.length },
        { type: 'url', offset: text.indexOf(url2), length: url2.length },
      ],
    });
    expect(ctx.postUrls).toEqual([url1]);
  });

  it('falls back to caption_entities for media posts', () => {
    const ctx = extractPostContext({
      caption: 'статья тут',
      caption_entities: [
        { type: 'text_link', offset: 0, length: 6, url: 'https://news.example.com' },
      ],
    });
    expect(ctx.postUrls).toEqual(['https://news.example.com']);
  });

  it('dedupes and caps URLs at 5', () => {
    const urls = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(c => `https://${c}.com`);
    const ctx = extractPostContext({
      text: 'x',
      entities: urls.map((u, i) => ({
        type: 'text_link' as const,
        offset: 0,
        length: 1,
        url: i % 2 === 0 ? u : urls[0],
      })),
    });
    expect(ctx.postUrls.length).toBeLessThanOrEqual(5);
    expect(ctx.postUrls[0]).toBe('https://a.com');
  });
});

describe('buildPostMetaLines', () => {
  it('text-only post', () => {
    const lines = buildPostMetaLines({
      postText: 'x', postUrls: [], inMediaGroup: false, hasCaption: true,
    });
    expect(lines).toEqual(['Тип поста: только текст (картинок нет).']);
  });

  it('text with single photo', () => {
    const lines = buildPostMetaLines({
      postText: 'x', postUrls: [], photoFileId: 'F', inMediaGroup: false, hasCaption: true,
    });
    expect(lines[0]).toContain('одной картинкой');
    expect(lines[0]).toContain('view_image');
  });

  it('media group includes honesty cue', () => {
    const lines = buildPostMetaLines({
      postText: 'x', postUrls: [], photoFileId: 'F', inMediaGroup: true, hasCaption: true,
    });
    expect(lines[0]).toContain('медиагруппы');
    expect(lines[0]).toContain('честно скажи');
  });

  it('appends URLs line when urls present', () => {
    const lines = buildPostMetaLines({
      postText: 'x', postUrls: ['https://a.com', 'https://b.com'],
      inMediaGroup: false, hasCaption: true,
    });
    expect(lines[lines.length - 1]).toContain('https://a.com');
    expect(lines[lines.length - 1]).toContain('https://b.com');
    expect(lines[lines.length - 1]).toContain('extract_url');
  });
});

describe('sanitizeCommentResponse', () => {
  it('replaces em-dash with hyphen', () => {
    expect(sanitizeCommentResponse('текст — продолжение')).toBe('текст - продолжение');
  });

  it('replaces multiple em-dashes', () => {
    expect(sanitizeCommentResponse('A — B — C')).toBe('A - B - C');
  });

  it('does not touch hyphens or other punctuation', () => {
    expect(sanitizeCommentResponse('hello-world, test.')).toBe('hello-world, test.');
  });

  it('handles empty string', () => {
    expect(sanitizeCommentResponse('')).toBe('');
  });

  it('strips leading "Bosque," artifact', () => {
    expect(sanitizeCommentResponse('Bosque, на I/O Google показала...')).toBe('на I/O Google показала...');
  });

  it('keeps legitimate "Босс" greeting (on-brand)', () => {
    expect(sanitizeCommentResponse('Босс, вот что нашёл.')).toBe('Босс, вот что нашёл.');
  });

  it('does not strip "Босс" mid-sentence', () => {
    expect(sanitizeCommentResponse('по Codex - Босс уже спрашивал.')).toBe('по Codex - Босс уже спрашивал.');
  });
});

describe('composeCommentUserMessage', () => {
  const baseCtx = {
    postText: 'тест поста', postUrls: [], inMediaGroup: false, hasCaption: true,
  };

  it('first turn includes post context and metadata', () => {
    const msg = composeCommentUserMessage({
      isFirstTurn: true,
      postContext: baseCtx,
      userName: 'Аня',
      commentText: 'что это значит?',
      intent: 'explain',
    });
    expect(msg).toContain('Контекст текущего поста:');
    expect(msg).toContain('тест поста');
    expect(msg).toContain('Тип поста:');
    expect(msg).toContain('Аня: "что это значит?"');
    expect(msg).toContain('Объясни как для умного нетехнического');
  });

  it('subsequent turn drops post context', () => {
    const msg = composeCommentUserMessage({
      isFirstTurn: false,
      postContext: baseCtx,
      userName: 'Аня',
      commentText: 'и ещё вопрос',
      intent: 'freeform',
    });
    expect(msg).not.toContain('Контекст текущего поста');
    expect(msg).toContain('Аня: "и ещё вопрос"');
  });

  it('first turn includes previous posts block when provided', () => {
    const msg = composeCommentUserMessage({
      isFirstTurn: true,
      postContext: baseCtx,
      userName: 'Аня',
      commentText: 'q',
      intent: 'freeform',
      previousPostsBlock: '\n\nКонтекст 2 предыдущих постов: ...',
    });
    expect(msg).toContain('Контекст 2 предыдущих постов');
  });
});

describe('integration: full comment reply path with mocked Anthropic', () => {
  it('text post with URL → model extracts → final answer flows through', async () => {
    // Step 1: extract context as the handler would
    const url = 'https://example.com/haiku';
    const text = `новый Haiku 4.5 — анонс ${url}`;
    const reply: ReplyToMessageLike = {
      text,
      entities: [
        { type: 'url', offset: text.indexOf(url), length: url.length },
      ],
    };
    const ctx = extractPostContext(reply);
    expect(ctx.postUrls).toEqual([url]);
    expect(ctx.photoFileId).toBeUndefined();

    // Step 2: build user message
    const userMessage = composeCommentUserMessage({
      isFirstTurn: true,
      postContext: ctx,
      userName: 'Стёпа',
      commentText: 'что там по сути?',
      intent: parseCommentIntent('что там по сути?'),
    });
    expect(userMessage).toContain('https://example.com/haiku');
    expect(userMessage).toContain('extract_url');

    // Step 3: mock Anthropic to use extract_url, then return text
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't1', name: 'extract_url', input: { url: 'https://example.com/haiku' } },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Кратко: новый Haiku быстрее и дешевле.' }],
      });

    // Mock Tavily for extract_url
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ url: 'https://example.com/haiku', raw_content: 'Haiku 4.5 announces faster cheaper model...' }],
      }),
    }));

    const executeTool = makeExecuteTool({ photoFileId: ctx.photoFileId });
    const response = await callClaudeWithTools({
      systemPrompt: 'You are Kesha.',
      userMessage,
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
      maxTokens: 300,
      tools: COMMENT_TOOLS,
      executeTool,
      maxIterations: 3,
    });

    expect(response).toBe('Кратко: новый Haiku быстрее и дешевле.');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.tavily.com/extract',
      expect.any(Object),
    );
  });

  it('media group photo → context warns model honestly, model says it cannot see others', async () => {
    const reply: ReplyToMessageLike = {
      caption: 'три мема одним постом',
      photo: [{ file_id: 'small' }, { file_id: 'large' }],
      media_group_id: 'mg-123',
    };
    const ctx = extractPostContext(reply);
    expect(ctx.inMediaGroup).toBe(true);
    expect(ctx.photoFileId).toBe('large');

    const userMessage = composeCommentUserMessage({
      isFirstTurn: true,
      postContext: ctx,
      userName: 'Антон',
      commentText: 'а третья картинка что значит?',
      intent: parseCommentIntent('а третья картинка что значит?'),
    });

    expect(userMessage).toContain('медиагруппы');
    expect(userMessage).toContain('честно скажи');

    // Mock Anthropic to skip tool use and answer directly (model recognizes it can't see others)
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'честно — вижу только одну картинку, на остальные доступа нет' }],
    });

    const executeTool = makeExecuteTool({ photoFileId: ctx.photoFileId });
    const response = await callClaudeWithTools({
      systemPrompt: 'You are Kesha.',
      userMessage,
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
      maxTokens: 300,
      tools: COMMENT_TOOLS,
      executeTool,
      maxIterations: 3,
    });

    expect(response).toContain('одну картинку');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('exhausts iterations → forced final answer without tools', async () => {
    const ctx = extractPostContext({ text: 'long text', entities: [] });
    const userMessage = composeCommentUserMessage({
      isFirstTurn: true,
      postContext: ctx,
      userName: 'X',
      commentText: 'q',
      intent: 'freeform',
    });

    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'a', name: 'extract_url', input: { url: 'https://x.com' } }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'got it' }],
      });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'down',
    }));

    const executeTool = makeExecuteTool({});
    const response = await callClaudeWithTools({
      systemPrompt: 'sys',
      userMessage,
      model: 'm',
      temperature: 0.5,
      maxTokens: 100,
      tools: COMMENT_TOOLS,
      executeTool,
      maxIterations: 3,
    });

    expect(response).toBe('got it');
  });
});
