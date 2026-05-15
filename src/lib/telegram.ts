export interface SendResult {
  success: boolean;
  messageId?: number;
  error?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineKeyboardButton[][];
}

export async function sendToChannel(text: string, chatId?: string): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const targetChatId = chatId ?? process.env.TELEGRAM_CHAT_ID!;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: targetChatId, text }),
      }
    );

    const data = await response.json() as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };

    if (!data.ok) {
      return { success: false, error: data.description };
    }

    return { success: true, messageId: data.result?.message_id };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function sendMessage(
  chatId: string,
  text: string,
  options?: { replyMarkup?: InlineKeyboard | null; replyToMessageId?: number }
): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;

  try {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options !== undefined && 'replyMarkup' in options) {
      body.reply_markup = options.replyMarkup;
    }
    if (options?.replyToMessageId) {
      body.reply_to_message_id = options.replyToMessageId;
    }

    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json() as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };

    if (!data.ok) {
      return { success: false, error: data.description };
    }

    return { success: true, messageId: data.result?.message_id };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function editMessageText(
  chatId: string,
  messageId: number,
  text: string,
  options?: { replyMarkup?: InlineKeyboard | null }
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;

  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
  if (options !== undefined && 'replyMarkup' in options) {
    body.reply_markup = options.replyMarkup;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/editMessageText`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const data = await response.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error(`[telegram] editMessageText failed: ${data.description}`);
    }
  } catch (err) {
    console.error(`[telegram] editMessageText error: ${String(err)}`);
  }
}

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

const GET_FILE_TIMEOUT_MS = 8_000;

function mediaTypeFromPath(filePath: string): ImageMediaType {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

export async function getFileAsBase64(
  fileId: string
): Promise<{ base64: string; mediaType: ImageMediaType } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GET_FILE_TIMEOUT_MS);

  try {
    const metaRes = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: controller.signal }
    );
    const meta = await metaRes.json() as {
      ok: boolean;
      result?: { file_path?: string };
      description?: string;
    };
    if (!meta.ok || !meta.result?.file_path) {
      console.error(`[telegram] getFile failed: ${meta.description ?? 'no file_path'}`);
      return null;
    }

    const filePath = meta.result.file_path;
    const fileRes = await fetch(
      `https://api.telegram.org/file/bot${token}/${filePath}`,
      { signal: controller.signal }
    );
    if (!fileRes.ok) {
      console.error(`[telegram] file download failed: ${fileRes.status}`);
      return null;
    }

    const buffer = await fileRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return { base64, mediaType: mediaTypeFromPath(filePath) };
  } catch (err) {
    console.error(`[telegram] getFileAsBase64 error: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
      }
    );
    const data = await response.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error(`[telegram] answerCallbackQuery failed: ${data.description}`);
    }
  } catch (err) {
    console.error(`[telegram] answerCallbackQuery error: ${String(err)}`);
  }
}
