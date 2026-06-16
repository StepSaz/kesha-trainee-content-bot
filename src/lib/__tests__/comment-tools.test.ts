import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeExecuteTool, COMMENT_TOOLS } from '../comment-tools.js';

vi.mock('../claude.js', async () => {
  const actual = await vi.importActual<typeof import('../claude.js')>('../claude.js');
  return { ...actual, callClaude: vi.fn() };
});
const { callClaude } = await import('../claude.js');

beforeEach(() => {
  process.env.TAVILY_API_KEY = 'test-key';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  vi.unstubAllGlobals();
  vi.mocked(callClaude).mockReset();
});

describe('COMMENT_TOOLS schema', () => {
  it('declares extract_url, view_image, web_search, consult_advisor', () => {
    const names = COMMENT_TOOLS.map(t => t.name).sort();
    expect(names).toEqual(['consult_advisor', 'extract_url', 'view_image', 'web_search']);
  });

  it('extract_url requires url string', () => {
    const tool = COMMENT_TOOLS.find(t => t.name === 'extract_url')!;
    expect(tool.input_schema).toMatchObject({
      type: 'object',
      required: ['url'],
    });
  });

  it('view_image takes no arguments', () => {
    const tool = COMMENT_TOOLS.find(t => t.name === 'view_image')!;
    expect(tool.input_schema).toMatchObject({
      type: 'object',
      properties: {},
    });
  });
});

describe('makeExecuteTool: extract_url', () => {
  it('rejects non-http URL', async () => {
    const exec = makeExecuteTool({});
    const result = await exec('extract_url', { url: 'ftp://x.com' });
    expect(result).toBe('некорректный URL');
  });

  it('rejects missing URL', async () => {
    const exec = makeExecuteTool({});
    const result = await exec('extract_url', {});
    expect(result).toBe('некорректный URL');
  });

  it('returns Tavily content on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ url: 'https://a.com', raw_content: 'article body' }] }),
    }));

    const exec = makeExecuteTool({});
    const result = await exec('extract_url', { url: 'https://a.com' });

    expect(result).toBe('article body');
  });

  it('returns fallback with host on Tavily failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'err',
    }));

    const exec = makeExecuteTool({});
    const result = await exec('extract_url', { url: 'https://example.com/path' });

    expect(result).toBe('не смог открыть ссылку: example.com');
  });

  it('caches repeated URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ url: 'https://a.com', raw_content: 'cached body' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const exec = makeExecuteTool({});
    await exec('extract_url', { url: 'https://a.com' });
    await exec('extract_url', { url: 'https://a.com' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('makeExecuteTool: view_image', () => {
  it('reports absent photo when context has none', async () => {
    const exec = makeExecuteTool({});
    const result = await exec('view_image', {});
    expect(result).toBe('под комментом нет картинки');
  });

  it('returns image content on first call', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/x.jpg' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([9, 9]).buffer,
      }));

    const exec = makeExecuteTool({ photoFileId: 'FID' });
    const result = await exec('view_image', {});

    expect(result).toMatchObject({
      kind: 'image',
      mediaType: 'image/jpeg',
      base64: Buffer.from([9, 9]).toString('base64'),
    });
  });

  it('returns text on second call (already loaded)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/x.jpg' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([0]).buffer,
      }));

    const exec = makeExecuteTool({ photoFileId: 'FID' });
    await exec('view_image', {});
    const second = await exec('view_image', {});

    expect(second).toBe('уже смотрел эту картинку, добавить нечего');
  });

  it('returns text on download failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, description: 'too big' }),
    }));

    const exec = makeExecuteTool({ photoFileId: 'FID' });
    const result = await exec('view_image', {});

    expect(result).toBe('не смог скачать картинку');
  });
});

describe('makeExecuteTool: consult_advisor', () => {
  it('rejects empty question', async () => {
    const exec = makeExecuteTool({});
    const result = await exec('consult_advisor', { question: '   ' });
    expect(result).toBe('нужен непустой question');
    expect(callClaude).not.toHaveBeenCalled();
  });

  it('returns advice from Sonnet on first call', async () => {
    vi.mocked(callClaude).mockResolvedValue('  не отвечай сарказмом, он спрашивает серьёзно  ');
    const exec = makeExecuteTool({});

    const result = await exec('consult_advisor', {
      question: 'это сарказм или нет?',
      draft_answer: 'спасибо за фидбек',
    });

    expect(result).toBe('не отвечай сарказмом, он спрашивает серьёзно');
    expect(callClaude).toHaveBeenCalledTimes(1);
    const args = vi.mocked(callClaude).mock.calls[0][0];
    expect(args.model).toBe('claude-sonnet-4-6');
    expect(args.userMessage).toContain('это сарказм или нет?');
    expect(args.userMessage).toContain('спасибо за фидбек');
  });

  it('caps at one call per session', async () => {
    vi.mocked(callClaude).mockResolvedValue('первый совет');
    const exec = makeExecuteTool({});

    await exec('consult_advisor', { question: 'q1' });
    const second = await exec('consult_advisor', { question: 'q2' });

    expect(second).toBe('уже спрашивал напарника в этом разговоре, справляйся сам');
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  it('returns graceful fallback on advisor error', async () => {
    vi.mocked(callClaude).mockRejectedValue(new Error('boom'));
    const exec = makeExecuteTool({});

    const result = await exec('consult_advisor', { question: 'help' });
    expect(result).toBe('напарник недоступен, отвечай сам');
  });
});

describe('makeExecuteTool: web_search', () => {
  it('rejects empty query', async () => {
    const exec = makeExecuteTool({});
    const result = await exec('web_search', { query: '   ' });
    expect(result).toBe('нужен непустой query');
  });

  it('returns formatted Tavily results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [
        { title: 'Gemini 3.5 launch', url: 'https://blog.google/a', content: 'Google announced Gemini 3.5 at I/O.', score: 0.9 },
      ] }),
    }));

    const exec = makeExecuteTool({});
    const result = await exec('web_search', { query: 'google io 2026' });

    expect(typeof result).toBe('string');
    expect(result as string).toContain('Gemini 3.5 launch');
    expect(result as string).toContain('https://blog.google/a');
  });

  it('defaults to a general search with no time range (factual queries)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const exec = makeExecuteTool({});
    await exec('web_search', { query: 'what is Bielik LLM' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.search_depth).toBe('advanced');
    expect(body.max_results).toBe(5);
    expect(body.topic).toBe('general');
    expect(body.time_range).toBeUndefined();
    expect(body.chunks_per_source).toBe(5);
    expect(body.exclude_domains).toEqual(['reddit.com', 'quora.com']);
  });

  it('applies news topic and weekly time range when fresh=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const exec = makeExecuteTool({});
    await exec('web_search', { query: 'latest model releases', fresh: true });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.topic).toBe('news');
    expect(body.time_range).toBe('week');
  });

  it('reports empty result set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }));

    const exec = makeExecuteTool({});
    const result = await exec('web_search', { query: 'нечего нет' });
    expect(result).toBe('поиск ничего не вернул');
  });

  it('caps at 2 calls per session', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ title: 't', url: 'https://x', content: 'c', score: 0.5 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const exec = makeExecuteTool({});
    await exec('web_search', { query: 'q1' });
    await exec('web_search', { query: 'q2' });
    const third = await exec('web_search', { query: 'q3' });

    expect(third).toBe('лимит поисков исчерпан (2 на разговор), отвечай тем, что есть');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('makeExecuteTool: unknown tool', () => {
  it('returns informative message for unknown name', async () => {
    const exec = makeExecuteTool({});
    const result = await exec('do_a_barrel_roll', {});
    expect(result).toBe('неизвестный инструмент: do_a_barrel_roll');
  });
});
