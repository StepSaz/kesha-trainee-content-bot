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
  options?: { replyMarkup?: InlineKeyboard | null }
): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;

  try {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options !== undefined && 'replyMarkup' in options) {
      body.reply_markup = options.replyMarkup;
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

export async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
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
