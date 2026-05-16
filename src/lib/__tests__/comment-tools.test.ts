import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeExecuteTool, COMMENT_TOOLS } from '../comment-tools.js';

beforeEach(() => {
  process.env.TAVILY_API_KEY = 'test-key';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  vi.unstubAllGlobals();
});

describe('COMMENT_TOOLS schema', () => {
  it('declares extract_url and view_image', () => {
    const names = COMMENT_TOOLS.map(t => t.name).sort();
    expect(names).toEqual(['extract_url', 'view_image']);
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

describe('makeExecuteTool: unknown tool', () => {
  it('returns informative message for unknown name', async () => {
    const exec = makeExecuteTool({});
    const result = await exec('do_a_barrel_roll', {});
    expect(result).toBe('неизвестный инструмент: do_a_barrel_roll');
  });
});
