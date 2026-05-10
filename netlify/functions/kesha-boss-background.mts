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
import { tavilySearch } from '../../src/lib/tavily.js';

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type?: 'private' | 'group' | 'supergroup' | 'channel';
}

interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_to_message?: { message_id: number; text?: string };
  message_thread_id?: number;
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
  comment_reply?: {
    per_thread_limit: number;
    per_user_spam_threshold: number;
    per_user_window_hours: number;
  };
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
    await answerCallbackQuery(callbackQueryId, 'Публикация отменена');
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
        { text: '✅ Опубликовать', callback_data: 'digest_prod' },
        { text: '❌ Отмена', callback_data: 'digest_cancel' },
      ]],
    };

    await editMessageText(chatId, progressMessageId, '✅ Готово, пост ниже - подтверди публикацию:');
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
    await answerCallbackQuery(callbackQueryId, 'Публикация отменена');
    await editMessageText(chatId, messageId, '❌ Отменено.', { replyMarkup: null });
    return;
  }

  if (data !== 'digest_prod') {
    await answerCallbackQuery(callbackQueryId);
    return;
  }
  const targetChatId = process.env.TELEGRAM_CHAT_ID!;

  // Delete first — prevents double-click and ensures cleanup even if sendToChannel throws
  await store.delete('pending-digest');
  const sendResult = await sendToChannel(pending.post, targetChatId);
  await answerCallbackQuery(callbackQueryId);

  if (!sendResult.success) {
    await editMessageText(chatId, messageId,
      `❌ Ошибка отправки: ${sendResult.error}`, { replyMarkup: null });
    return;
  }

  try {
    await store.setJSON('digest-last-manual-at', { publishedAt: new Date().toISOString() });
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

  await editMessageText(chatId, messageId,
    `✅ Отправлено в канал: t.me/psyreq/${sendResult.messageId}`, { replyMarkup: null });
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
  if (!message.text) return;

  // thread ID for direct comments on channel posts; reply_to_message.message_id for nested replies
  const threadId = message.message_thread_id ?? message.reply_to_message?.message_id;
  if (!threadId) return;

  const chatId = String(message.chat.id);
  const config = readBossConfig();
  const commentCfg = config.comment_reply ?? { per_thread_limit: 6, per_user_spam_threshold: 7, per_user_window_hours: 24 };
  const store = getStore('kesha');

  // Per-user spam guard (rolling window)
  const userRateKey = `comment-rate-user:${message.from.id}`;
  const userWindowMs = commentCfg.per_user_window_hours * 60 * 60 * 1000;
  const userExpiresAt = new Date(Date.now() + userWindowMs).toISOString();
  const userExisting = await store.getWithMetadata(userRateKey, { type: 'json' });
  const userCurrentCount = (userExisting?.data as number | null) ?? 0;
  const userStoredExpiry = userExisting?.metadata?.expiresAt as string | undefined;
  const userEffectiveCount = userStoredExpiry && new Date() > new Date(userStoredExpiry) ? 0 : userCurrentCount;

  // Already muted in this window - stay silent
  if (userEffectiveCount >= commentCfg.per_user_spam_threshold) return;

  const newUserCount = userEffectiveCount + 1;
  await store.setJSON(userRateKey, newUserCount, { metadata: { expiresAt: userExpiresAt } });

  // Threshold hit on this message - send soft mute notice to user, alert boss, skip Claude
  if (newUserCount === commentCfg.per_user_spam_threshold) {
    await sendMessage(chatId,
      'К сожалению, босс не разрешает мне пока вести длинные диалоги, так что я ненадолго замолкаю. Возвращайтесь попозже 🐤',
      { replyToMessageId: message.message_id }
    );
    const userTag = message.from.username
      ? `@${message.from.username}`
      : (message.from.first_name ?? String(message.from.id));
    const bossId = String(config.allowed_user_ids[0]);
    await sendMessage(bossId,
      `⚠️ Кеша замьютировал ${userTag} — достиг лимита ${commentCfg.per_user_spam_threshold} вопросов за ${commentCfg.per_user_window_hours}ч.`
    );
    return;
  }

  // Per-thread rate limit
  const rateKey = `comment-rate:${chatId}:${threadId}`;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + thirtyDaysMs).toISOString();
  const existing = await store.getWithMetadata(rateKey, { type: 'json' });
  const currentCount = (existing?.data as number | null) ?? 0;
  const storedExpiry = existing?.metadata?.expiresAt as string | undefined;
  const effectiveCount = storedExpiry && new Date() > new Date(storedExpiry) ? 0 : currentCount;

  // Already over per-thread limit - stay silent
  if (effectiveCount >= commentCfg.per_thread_limit) return;

  const newThreadCount = effectiveCount + 1;
  await store.setJSON(rateKey, newThreadCount, { metadata: { expiresAt } });

  // Threshold hit on this message - send notice and skip Claude
  if (newThreadCount === commentCfg.per_thread_limit) {
    await sendMessage(chatId,
      'Кажется, я достиг лимита ответов в этом треде, извините. Спрашивайте под следующим постом 🐤',
      { replyToMessageId: message.message_id }
    );
    return;
  }

  const intent = parseCommentIntent(message.text);
  const postText = message.reply_to_message?.text ?? '[текст поста недоступен]';
  const userName = message.from.first_name ?? message.from.username ?? 'Читатель';

  const intentInstructions: Record<CommentIntent, string> = {
    expand: `${userName} просит развернуть тему подробнее. Напиши 2-3 абзаца, углубись в детали.`,
    explain: `${userName} просит объяснить проще. Объясни как для умного нетехнического человека.`,
    compare: `${userName} просит сравнение. Сравни кратко — что лучше, хуже, в каком контексте.`,
    freeform: `${userName} написал комментарий к посту. Ответь по делу, в своём стиле стажёра.`,
  };

  const systemPrompt = [
    'Ты Иннокентий ("Кеша") - бот-стажёр Telegram-канала "Временно Степан" (@psyreq).',
    'Твой босс - Степан Сазановец (@st_szs). По четвергам ты публикуешь дайджест новостей про AI, tech, vibe coding и инструменты для IT.',
    'В комментариях ты помогаешь читателям: объясняешь термины из поста, разворачиваешь темы подробнее, сравниваешь технологии, обсуждаешь по делу.',
    'Архитектура: serverless background function на Netlify.',
    'Посты генерируешь через Claude Sonnet с managed agent и web search - собираешь новости за последние 7 дней, запускаешься по крону каждый четверг в 16:00 по Варшаве.',
    'Для ответов в комментах работаешь на Claude Haiku - он сейчас и отвечает.',
    'Степан может запускать тебя вручную командами /digest (сгенерировать пост), /boss (обработать готовый текст), /notes (пост из .md-файла).',
    'Не общий чат-бот - твоя зона это темы канала.',
    'Пишешь живо, по-русски, со стажёрской самоиронией, без официоза. Никаких em-dash (—), никакого markdown. Лаконично - не больше 3-4 предложений.',
    'Если спросят кто ты, что умеешь или как устроен - ответь честно и коротко, в своём стиле.',
  ].join(' ');

  try {
    const response = await callClaude({
      systemPrompt,
      userMessage: `Контекст поста:\n${postText}\n\nКомментарий ${userName}: "${message.text}"\n\n${intentInstructions[intent]}`,
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

async function handleDmChat(message: TelegramMessage): Promise<void> {
  if (!message.text) return;
  const chatId = String(message.chat.id);
  const userName = message.from.first_name ?? message.from.username ?? 'Степан';

  const searchResults = await tavilySearch(message.text, 5);

  let searchContext = '';
  if (searchResults.length > 0) {
    searchContext = '\n\nРезультаты веб-поиска:\n' + searchResults
      .map(r => `- ${r.title}: ${r.content.slice(0, 400)}`)
      .join('\n');
  }

  const systemPrompt = [
    'Ты Иннокентий ("Кеша") - бот-стажёр Telegram-канала "Временно Степан" (@psyreq).',
    'Твой босс - Степан Сазановец (@st_szs). Сейчас он пишет тебе в личку.',
    'Отвечай по-русски, живо, со стажёрской самоиронией, без официоза.',
    'Никаких em-dash (—), никакого markdown.',
    'Если получил результаты поиска - используй их, цитируй источники по делу.',
    'Если вопрос про канал, посты или технологии - отвечай коротко и по существу.',
    'Если вопрос личный или странный - можно пошутить, но оставайся в образе стажёра.',
  ].join(' ');

  try {
    const response = await callClaude({
      systemPrompt,
      userMessage: `${userName}: ${message.text}${searchContext}`,
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
      maxTokens: 1024,
    });

    if (response) {
      await sendMessage(chatId, response);
    }
  } catch (err) {
    console.error('[dm-chat] error:', err);
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
  } else if (msg && (msg.message_thread_id || msg.reply_to_message) && /кеша/i.test(msg.text ?? '')) {
    await handleCommentReply(msg);
  } else if (msg?.text && !msg.text.startsWith('/') && !msg.message_thread_id && !msg.reply_to_message && msg.chat.type === 'private') {
    const cfg = readBossConfig();
    if (cfg.allowed_user_ids.includes(msg.from.id)) {
      await handleDmChat(msg);
    }
  }

  return new Response(null, { status: 202 });
};

export const config: Config = {};
