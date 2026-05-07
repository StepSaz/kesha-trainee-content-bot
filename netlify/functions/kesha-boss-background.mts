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
import { generatePipelinePost, extractIntro, type PipelineResult } from '../../src/lib/pipeline.js';
import { loadMemory, appendMemory, type MemoryEntry } from '../../src/lib/memory.js';
import { callClaude } from '../../src/lib/claude.js';
import { validateNotes } from '../../src/lib/validator.js';

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
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_to_message?: { message_id: number; text?: string };
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

interface PendingDigest {
  chatId: string;
  progressMessageId: number;
  post: string;
  selectedTopics: PipelineResult['selectedTopics'];
  newIntros: string[];
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

    if (!previewMsg.success || !previewMsg.messageId) {
      console.error('[boss] failed to send preview message:', previewMsg.error);
      await editMessageText(chatId, progressMessageId, '❌ Не удалось отправить превью.');
      return;
    }

    const pending: PendingPreview = {
      userId,
      chatId,
      previewMessageId: previewMsg.messageId,
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

async function handleDigest(message: TelegramMessage): Promise<void> {
  const chatId = String(message.chat.id);
  const config = readBossConfig();

  if (!config.allowed_user_ids.includes(message.from.id)) {
    await sendMessage(chatId, 'Только для начальника 🐤');
    return;
  }

  const store = getStore('kesha');

  const existingPending = await store.get('pending-digest');
  if (existingPending) {
    await sendMessage(chatId, '⚠️ Уже есть незавершённый дайджест. Сначала подтверди или отмени его.');
    return;
  }

  const progressResult = await sendMessage(chatId, '⏳ генерирую дайджест... (~60-90 сек)');
  if (!progressResult.success || !progressResult.messageId) return;
  const progressMessageId = progressResult.messageId;

  try {
    const memoryEntries = await loadMemory();
    const previousIntros = (await store.get('previous-intros', { type: 'json' }) as string[] | null) ?? [];

    const result = await generatePipelinePost({ memoryEntries, previousIntros });

    if (!result.success || !result.post) {
      await editMessageText(chatId, progressMessageId,
        `❌ Пайплайн упал: ${(result.errors ?? []).join(', ')}`);
      return;
    }

    const newIntro = extractIntro(result.post);
    const newIntros = [...previousIntros, newIntro].slice(-10);

    const pending: PendingDigest = {
      chatId,
      progressMessageId,
      post: result.post,
      selectedTopics: result.selectedTopics,
      newIntros,
      createdAt: new Date().toISOString(),
    };
    await store.setJSON('pending-digest', pending);

    const keyboard: InlineKeyboard = {
      inline_keyboard: [[
        { text: '🧪 В тест', callback_data: 'digest_test' },
        { text: '📢 В прод', callback_data: 'digest_prod' },
        { text: '❌ Отмена', callback_data: 'digest_cancel' },
      ]],
    };

    await editMessageText(chatId, progressMessageId, '✅ Готово, пост ниже — выбери куда отправить:');
    await sendMessage(chatId, result.post, { replyMarkup: keyboard });
  } catch (err) {
    await editMessageText(chatId, progressMessageId, `❌ Ошибка: ${String(err)}`);
  }
}

async function handleDigestCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
  const callbackQueryId = callbackQuery.id;
  const chatId = String(callbackQuery.message?.chat.id ?? '');
  const messageId = callbackQuery.message?.message_id ?? 0;
  const data = callbackQuery.data ?? '';

  const store = getStore('kesha');
  const pending = await store.get('pending-digest', { type: 'json' }) as PendingDigest | null;

  if (!pending) {
    await answerCallbackQuery(callbackQueryId);
    await editMessageText(chatId, messageId, '⏰ Дайджест устарел — запусти /digest снова.', { replyMarkup: null });
    return;
  }

  if (data === 'digest_cancel') {
    await store.delete('pending-digest');
    await answerCallbackQuery(callbackQueryId);
    await editMessageText(chatId, messageId, '❌ Отменено.', { replyMarkup: null });
    return;
  }

  let targetChatId: string;
  if (data === 'digest_test') targetChatId = process.env.TELEGRAM_TEST_CHAT_ID!;
  else if (data === 'digest_prod') targetChatId = process.env.TELEGRAM_CHAT_ID!;
  else {
    await answerCallbackQuery(callbackQueryId);
    return;
  }

  // Delete first — prevents double-click and ensures cleanup even if sendToChannel throws
  await store.delete('pending-digest');
  const sendResult = await sendToChannel(pending.post, targetChatId);
  await answerCallbackQuery(callbackQueryId);

  if (!sendResult.success) {
    await editMessageText(chatId, messageId,
      `❌ Ошибка отправки: ${sendResult.error}`, { replyMarkup: null });
    return;
  }

  if (data === 'digest_prod') {
    try {
      const newEntries: MemoryEntry[] = pending.selectedTopics.topics.map(t => ({
        url: t.sourceUrl,
        title: t.title,
        publishedAt: new Date().toISOString(),
        postId: sendResult.messageId ?? null,
      }));
      await appendMemory(newEntries);
      await store.setJSON('previous-intros', pending.newIntros);
    } catch (err) {
      console.error('[boss] memory update failed after publish:', err);
    }
  }

  const label = data === 'digest_test' ? 'тест' : 'прод';
  await editMessageText(chatId, messageId,
    `✅ Отправлено в ${label}: t.me/psyreq/${sendResult.messageId}`, { replyMarkup: null });
}

type CommentIntent = 'expand' | 'explain' | 'compare' | 'freeform';

function parseCommentIntent(text: string): CommentIntent {
  const t = text.toLowerCase();
  if (/расширь|подробнее|больше/.test(t)) return 'expand';
  if (/объясни|что значит|что такое/.test(t)) return 'explain';
  if (/сравни|vs\b|versus/.test(t)) return 'compare';
  return 'freeform';
}

async function handleCommentReply(message: TelegramMessage): Promise<void> {
  const config = readBossConfig();
  if (!config.allowed_user_ids.includes(message.from.id)) return;

  const replyToId = message.reply_to_message?.message_id;
  if (!replyToId) return;

  if (!message.text) return;

  const chatId = String(message.chat.id);
  const store = getStore('kesha');
  const rateKey = `comment-rate:${chatId}:${replyToId}`;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + thirtyDaysMs).toISOString();

  const existing = await store.getWithMetadata(rateKey, { type: 'json' });
  const currentCount = (existing?.data as number | null) ?? 0;
  const storedExpiry = existing?.metadata?.expiresAt as string | undefined;

  // If the blob exists but has passed its logical expiry, treat count as 0
  const effectiveCount = storedExpiry && new Date() > new Date(storedExpiry) ? 0 : currentCount;

  if (effectiveCount >= 3) return;

  await store.setJSON(rateKey, effectiveCount + 1, {
    metadata: { expiresAt },
  });

  const intent = parseCommentIntent(message.text);
  const postText = message.reply_to_message?.text ?? '';

  const intentInstructions: Record<CommentIntent, string> = {
    expand: 'Степан просит развернуть тему подробнее. Напиши 2-3 абзаца, углубись в детали.',
    explain: 'Степан просит объяснить проще. Объясни как для умного нетехнического человека.',
    compare: 'Степан просит сравнение. Сравни кратко — что лучше, хуже, в каком контексте.',
    freeform: 'Степан написал комментарий к посту. Ответь по делу, в своём стиле стажёра.',
  };

  try {
    const response = await callClaude({
      systemPrompt: 'Ты Кеша - стажёр-бот в Telegram-канале. Пишешь живо, по-русски, без официоза. Никаких em-dash (—), никакого markdown. Лаконично - не больше 3-4 предложений.',
      userMessage: `Контекст поста:\n${postText}\n\nКомментарий Степана: "${message.text}"\n\n${intentInstructions[intent]}`,
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
      maxTokens: 300,
    });

    if (!response) {
      console.error('[boss] comment reaction: Claude returned empty response, skipping send');
      return;
    }

    await sendMessage(chatId, response, { replyToMessageId: message.message_id });
  } catch (err) {
    console.error('[boss] comment reaction error:', err);
  }
}

async function handleNotes(message: TelegramMessage): Promise<void> {
  const chatId = String(message.chat.id);
  const config = readBossConfig();

  if (!config.allowed_user_ids.includes(message.from.id)) {
    await sendMessage(chatId, 'Только для начальника 🐤');
    return;
  }

  if (!message.document) {
    await sendMessage(chatId, '❌ Прикрепи .md файл.');
    return;
  }
  const doc = message.document;
  const fileName = doc.file_name ?? '';
  if (!fileName.toLowerCase().endsWith('.md')) {
    await sendMessage(chatId, '❌ Нужен .md файл.');
    return;
  }

  if ((doc.file_size ?? 0) > 50_000) {
    await sendMessage(chatId, `❌ Файл слишком большой (макс 50 000 байт).`);
    return;
  }

  const progressResult = await sendMessage(chatId, '📝 Читаю нотсы...');
  if (!progressResult.success || !progressResult.messageId) {
    console.error('[notes] failed to send progress message:', progressResult.error);
    return;
  }
  const progressMessageId = progressResult.messageId;
  const channelId = process.env.TELEGRAM_CHAT_ID!;
  const token = process.env.TELEGRAM_BOT_TOKEN!;

  try {
    // Download file from Telegram
    const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: doc.file_id }),
    });
    const fileData = await fileRes.json() as {
      ok: boolean;
      result?: { file_path: string };
      description?: string;
    };
    if (!fileData.ok || !fileData.result) {
      await editMessageText(chatId, progressMessageId,
        `❌ Не удалось получить файл: ${fileData.description ?? 'unknown error'}`);
      return;
    }

    const downloadController = new AbortController();
    const downloadTimeout = setTimeout(() => downloadController.abort(), 30_000);
    let downloadRes: Response;
    try {
      downloadRes = await fetch(
        `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`,
        { signal: downloadController.signal }
      );
    } finally {
      clearTimeout(downloadTimeout);
    }
    if (!downloadRes.ok) {
      await editMessageText(chatId, progressMessageId,
        `❌ Не удалось скачать файл: ${downloadRes.status}`);
      return;
    }
    const content = await downloadRes.text();

    if (content.length > 50_000) {
      await editMessageText(chatId, progressMessageId,
        `❌ Файл слишком большой (${content.length} символов, макс 50 000).`);
      return;
    }

    // Generate post
    await editMessageText(chatId, progressMessageId, '✍️ Пишу пост...');
    const systemPrompt = readFileSync(join(process.cwd(), 'src/config/notes-persona.txt'), 'utf-8');
    const generatedPost = await callClaude({
      systemPrompt,
      userMessage: content,
      model: 'claude-sonnet-4-6',
      temperature: 0.7,
      maxTokens: 2048,
    });

    if (!generatedPost) {
      await editMessageText(chatId, progressMessageId, '❌ Claude вернул пустой ответ.');
      return;
    }

    const validation = validateNotes(generatedPost);
    if (!validation.valid) {
      await editMessageText(chatId, progressMessageId,
        `❌ Пост не прошёл валидацию: ${validation.errors.join(', ')}`);
      return;
    }

    // Save preview
    const previewId = crypto.randomUUID();
    const store = getStore('kesha');
    const keyboard: InlineKeyboard = {
      inline_keyboard: [[
        { text: '✅ Постить', callback_data: `confirm:${previewId}` },
        { text: '❌ Отмена', callback_data: `cancel:${previewId}` },
      ]],
    };

    await editMessageText(chatId, progressMessageId,
      '👀 Готово. Превью ниже — подтверди публикацию.');

    const previewMsg = await sendMessage(chatId, generatedPost, { replyMarkup: keyboard });
    if (!previewMsg.success || !previewMsg.messageId) {
      console.error('[notes] failed to send preview message:', previewMsg.error);
      await editMessageText(chatId, progressMessageId, '❌ Не удалось отправить превью.');
      return;
    }

    const pending: PendingPreview = {
      userId: message.from.id,
      chatId,
      previewMessageId: previewMsg.messageId,
      finalText: generatedPost,
      channelId,
      createdAt: new Date().toISOString(),
    };
    await store.setJSON(`boss-preview:${previewId}`, pending);
    console.log(`[notes] preview saved previewId=${previewId}`);
  } catch (err) {
    console.error('[notes] unexpected error:', err);
    await editMessageText(chatId, progressMessageId, `❌ Что-то пошло не так: ${String(err)}`);
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

  // Netlify background functions return 202 to caller automatically at infrastructure level.
  // We await here so the function keeps running until handlers complete (up to 15 min).
  const msg = update.message;
  const cq = update.callback_query;

  if (cq) {
    const data = cq.data ?? '';
    if (data.startsWith('digest_')) {
      await handleDigestCallback(cq);
    } else {
      await handleCallback(cq);
    }
  } else if (msg?.text?.match(/^\/digest/)) {
    await handleDigest(msg);
  } else if (msg?.text?.match(/^\/boss/)) {
    await handleCommand(msg);
  } else if (msg?.caption?.startsWith('/notes') && msg.document) {
    await handleNotes(msg);
  } else if (msg?.caption?.startsWith('/notes')) {
    await sendMessage(String(msg.chat.id), 'Прикрепи .md файл и напиши /notes в подписи к нему.');
  } else if (msg?.text?.match(/^\/notes/)) {
    await sendMessage(String(msg.chat.id), 'Прикрепи .md файл и напиши /notes в подписи к нему.');
  } else if (msg && msg.reply_to_message && msg.from.id === 352830345) {
    await handleCommentReply(msg);
  }

  return new Response(null, { status: 202 });
};

export const config: Config = {};
