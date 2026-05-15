import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendToChannel, sendMessage, editMessageText, answerCallbackQuery, getFileAsBase64 } from '../telegram.js';

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '@test_channel';
  vi.unstubAllGlobals();
});

describe('sendToChannel', () => {
  it('sends message to default channel and returns messageId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    }));

    const result = await sendToChannel('Hello Кеша 🐤');

    expect(result).toEqual({ success: true, messageId: 42 });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chat_id: '@test_channel', text: 'Hello Кеша 🐤' }),
      })
    );
  });

  it('uses provided chatId over default', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 99 } }),
    }));

    await sendToChannel('test', '@other_channel');

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ chat_id: '@other_channel', text: 'test' }),
      })
    );
  });

  it('does not set parse_mode (plain text)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    }));

    await sendToChannel('test');

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('returns error when Telegram API returns ok: false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: false, description: 'chat not found' }),
    }));

    const result = await sendToChannel('test');

    expect(result).toEqual({ success: false, error: 'chat not found' });
  });

  it('returns error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const result = await sendToChannel('test');

    expect(result.success).toBe(false);
    expect(result.error).toContain('network error');
  });
});

describe('sendMessage', () => {
  it('sends message to chatId and returns messageId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 55 } }),
    }));

    const result = await sendMessage('123456', 'Hello Кеша');

    expect(result).toEqual({ success: true, messageId: 55 });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chat_id: '123456', text: 'Hello Кеша' }),
      })
    );
  });

  it('includes reply_markup when replyMarkup option provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 56 } }),
    }));

    const keyboard = { inline_keyboard: [[{ text: '✅ Да', callback_data: 'confirm:abc' }]] };
    await sendMessage('123456', 'Preview text', { replyMarkup: keyboard });

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.reply_markup).toEqual(keyboard);
  });

  it('does not include reply_markup when replyMarkup not provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { message_id: 57 } }),
    }));

    await sendMessage('123456', 'No keyboard');

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).not.toHaveProperty('reply_markup');
  });

  it('returns error when Telegram API returns ok: false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: false, description: 'chat not found' }),
    }));

    const result = await sendMessage('123456', 'test');

    expect(result).toEqual({ success: false, error: 'chat not found' });
  });

  it('returns error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const result = await sendMessage('123456', 'test');

    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });
});

describe('editMessageText', () => {
  it('calls editMessageText endpoint with chatId, messageId, text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true }),
    }));

    await editMessageText('123456', 42, '🔍 Ревьювлю...');

    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/editMessageText',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chat_id: '123456', message_id: 42, text: '🔍 Ревьювлю...' }),
      })
    );
  });

  it('includes reply_markup: null to remove inline keyboard', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true }),
    }));

    await editMessageText('123456', 42, '✅ Опубликовано', { replyMarkup: null });

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.reply_markup).toBeNull();
  });
});

describe('answerCallbackQuery', () => {
  it('calls answerCallbackQuery endpoint with callbackQueryId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ok: true }),
    }));

    await answerCallbackQuery('cq_abc123');

    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/answerCallbackQuery',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ callback_query_id: 'cq_abc123' }),
      })
    );
  });
});

describe('getFileAsBase64', () => {
  it('returns base64 + mediaType on happy path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/file_42.jpg' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getFileAsBase64('AgACAgIAxxx');

    expect(result).toEqual({
      base64: Buffer.from([1, 2, 3, 4]).toString('base64'),
      mediaType: 'image/jpeg',
    });
    expect(fetchMock.mock.calls[0][0]).toContain('/getFile?file_id=AgACAgIAxxx');
    expect(fetchMock.mock.calls[1][0]).toContain('/file/bottest-token/photos/file_42.jpg');
  });

  it('detects png from extension', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/file.PNG' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([0]).buffer,
      }));

    const result = await getFileAsBase64('id');

    expect(result?.mediaType).toBe('image/png');
  });

  it('returns null when getFile responds with ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, description: 'file too big' }),
    }));

    const result = await getFileAsBase64('id');

    expect(result).toBeNull();
  });

  it('returns null when file download is non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/x.jpg' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await getFileAsBase64('id');

    expect(result).toBeNull();
  });

  it('returns null on fetch throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const result = await getFileAsBase64('id');

    expect(result).toBeNull();
  });
});
