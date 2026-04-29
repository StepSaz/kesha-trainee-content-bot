import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runBossPipeline } from '../../src/lib/boss-pipeline.js';
import { parseCommand } from '../../src/lib/boss-command-parser.js';
import {
  sendToChannel,
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  type InlineKeyboard,
} from '../../src/lib/telegram.js';

interface TelegramUser {
  id: number;
  username?: string;
}

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: { message_id: number; chat: TelegramChat };
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface BossConfig {
  enabled: boolean;
  allowed_user_ids: number[];
  min_input_length: number;
  max_input_length: number;
  preview_timeout_minutes: number;
}

interface PendingPreview {
  userId: number;
  chatId: string;
  previewMessageId: number;
  finalText: string;
  channelId: string;
  createdAt: string;
}

function readBossConfig(): BossConfig {
  const raw = readFileSync(join(process.cwd(), 'src/config/pipeline.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { boss_command: BossConfig };
  return parsed.boss_command;
}

async function handleCommand(message: TelegramMessage): Promise<void> {
  const chatId = String(message.chat.id);
  const userId = message.from.id;
  const config = readBossConfig();

  if (!config.enabled) {
    await sendMessage(chatId, 'Boss command is currently disabled.');
    return;
  }

  if (!config.allowed_user_ids.includes(userId)) {
    await sendMessage(chatId, 'Извини, эта команда только для начальника 🐤');
    return;
  }

  const { forceRaw, forceSkip, inputText } = parseCommand(message.text ?? '');

  if (inputText.length < config.min_input_length) {
    await sendMessage(
      chatId,
      `Текст слишком короткий. Минимум ${config.min_input_length} символов (сейчас: ${inputText.length}).`
    );
    return;
  }

  if (inputText.length > config.max_input_length) {
    await sendMessage(
      chatId,
      `Текст слишком длинный. Максимум ${config.max_input_length} символов (сейчас: ${inputText.length}).`
    );
    return;
  }

  const initResult = await sendMessage(chatId, '🔍 Ревьювлю...');
  if (!initResult.success || !initResult.messageId) {
    console.error('[boss] failed to send initial progress message:', initResult.error);
    return;
  }
  const progressMessageId = initResult.messageId;
  const channelId = process.env.TELEGRAM_CHAT_ID!;

  try {
    const result = await runBossPipeline(inputText, { forceRaw, forceSkip }, async (status) => {
      await editMessageText(chatId, progressMessageId, status);
    });

    if (!result.success) {
      await editMessageText(chatId, progressMessageId, `❌ Ошибка: ${result.error}`);
      return;
    }

    if (result.branch === 'READY') {
      await editMessageText(chatId, progressMessageId, '✅ Текст норм, постить без переработки...');
      const sendResult = await sendToChannel(result.finalText, channelId);
      if (sendResult.success) {
        await editMessageText(chatId, progressMessageId, `✅ Опубликовано: t.me/psyreq/${sendResult.messageId}`);
      } else {
        await editMessageText(chatId, progressMessageId, `❌ Ошибка публикации: ${sendResult.error}`);
      }
      return;
    }

    // RAW branch — save pending preview
    const previewId = crypto.randomUUID();
    const store = getStore('kesha');

    const keyboard: InlineKeyboard = {
      inline_keyboard: [[
        { text: '✅ Постить', callback_data: `confirm:${previewId}` },
        { text: '❌ Отмена', callback_data: `cancel:${previewId}` },
      ]],
    };

    await editMessageText(chatId, progressMessageId, '👀 Готово. Превью выше, подтверди публикацию.');

    const previewMsg = await sendMessage(
      chatId,
      `🐤 Текст показался сыроватым, переписал. Постить?\n\n${result.finalText}`,
      { replyMarkup: keyboard }
    );

    const pending: PendingPreview = {
      userId,
      chatId,
      previewMessageId: previewMsg.messageId ?? 0,
      finalText: result.finalText,
      channelId,
      createdAt: new Date().toISOString(),
    };

    await store.setJSON(`boss-preview:${previewId}`, pending);
    console.log(`[boss] preview saved previewId=${previewId}`);
  } catch (err) {
    console.error('[boss] unexpected error in command handler:', err);
    await editMessageText(chatId, progressMessageId, `❌ Что-то пошло не так: ${String(err)}`);
  }
}

async function handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
  const callbackQueryId = callbackQuery.id;
  const chatId = String(callbackQuery.message?.chat.id ?? '');
  const previewMessageId = callbackQuery.message?.message_id ?? 0;
  const data = callbackQuery.data ?? '';

  const match = data.match(/^(confirm|cancel):(.+)$/);
  if (!match) {
    await answerCallbackQuery(callbackQueryId);
    return;
  }

  const action = match[1];
  const previewId = match[2];
  const store = getStore('kesha');
  const pending = await store.get(`boss-preview:${previewId}`, { type: 'json' }) as PendingPreview | null;

  if (!pending) {
    await answerCallbackQuery(callbackQueryId);
    await editMessageText(chatId, previewMessageId, '⏰ Истекло время на подтверждение.', { replyMarkup: null });
    return;
  }

  const config = readBossConfig();
  const expiresAt = new Date(new Date(pending.createdAt).getTime() + config.preview_timeout_minutes * 60 * 1000);
  if (new Date() > expiresAt) {
    await store.delete(`boss-preview:${previewId}`);
    await answerCallbackQuery(callbackQueryId);
    await editMessageText(chatId, previewMessageId, '⏰ Истекло время на подтверждение.', { replyMarkup: null });
    return;
  }

  await store.delete(`boss-preview:${previewId}`);

  if (action === 'confirm') {
    const sendResult = await sendToChannel(pending.finalText, pending.channelId);
    await answerCallbackQuery(callbackQueryId);
    if (sendResult.success) {
      await editMessageText(chatId, previewMessageId, `✅ Опубликовано: t.me/psyreq/${sendResult.messageId}`, { replyMarkup: null });
    } else {
      await editMessageText(chatId, previewMessageId, `❌ Ошибка публикации: ${sendResult.error}`, { replyMarkup: null });
    }
  } else {
    await answerCallbackQuery(callbackQueryId);
    await editMessageText(chatId, previewMessageId, '❌ Отменено.', { replyMarkup: null });
  }
}

export default async (req: Request): Promise<Response> => {
  let update: TelegramUpdate;
  try {
    update = await req.json() as TelegramUpdate;
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  console.log('[boss] update received:', JSON.stringify(update));

  // Fire and forget — return 202 immediately so Telegram doesn't time out
  if (update.message?.text?.match(/^\/boss/)) {
    void handleCommand(update.message);
  } else if (update.callback_query) {
    void handleCallback(update.callback_query);
  }

  return new Response(null, { status: 202 });
};

export const config: Config = {};
