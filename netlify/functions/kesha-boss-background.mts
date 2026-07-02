import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseCommand, parseDigestVariant } from '../../src/lib/boss-command-parser.js';
import {
  sendToChannel,
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  type InlineKeyboard,
} from '../../src/lib/telegram.js';
import { generatePipelinePost, extractIntro, type PipelineResult } from '../../src/lib/pipeline.js';
import { generateShortDigest, extractShortIntro } from '../../src/lib/short-digest.js';
import { loadMemory, appendMemory, type MemoryEntry } from '../../src/lib/memory.js';
import { callClaude, callClaudeWithTools, type ConversationTurn } from '../../src/lib/claude.js';
import { COMMENT_TOOLS, makeExecuteTool } from '../../src/lib/comment-tools.js';
import {
  extractPostContext,
  composeCommentUserMessage,
  parseCommentIntent,
  sanitizeCommentResponse,
} from '../../src/lib/comment-reply.js';
import { appendPublishedPost, loadRecentPosts } from '../../src/lib/recent-posts.js';
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

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
}

interface TelegramReplyMessage {
  message_id: number;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  photo?: TelegramPhotoSize[];
  media_group_id?: string;
}

interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_to_message?: TelegramReplyMessage;
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

interface PendingDigestBase {
  id: string;
  variant: 'full' | 'short';
  chatId: string;
  progressMessageId: number;
  post: string;
  selectedTopics: PipelineResult['selectedTopics'];
  createdAt: string;
}
type PendingDigest =
  | (PendingDigestBase & { variant: 'full'; newIntros: string[] })
  | (PendingDigestBase & { variant: 'short'; newShortIntros: string[] });

function parseBossUserIds(value: string | undefined): number[] | null {
  if (!value?.trim()) return null;
  const ids = value.split(',').map((part) => Number(part.trim())).filter((id) => Number.isFinite(id));
  if (ids.length === 0) {
    throw new Error('TELEGRAM_BOSS_USER_IDS/TELEGRAM_BOSS_USER_ID must contain at least one numeric Telegram user id.');
  }
  return ids;
}

export function readBossConfig(): BossConfig {
  const raw = readFileSync(join(process.cwd(), 'src/config/pipeline.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { boss_command: BossConfig };
  const envAllowedUserIds =
    parseBossUserIds(process.env.TELEGRAM_BOSS_USER_IDS) ??
    parseBossUserIds(process.env.TELEGRAM_BOSS_USER_ID);

  return {
    ...parsed.boss_command,
    allowed_user_ids: envAllowedUserIds ?? parsed.boss_command.allowed_user_ids,
  };
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

  const { inputText } = parseCommand(message.text ?? '');

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

  const initResult = await sendMessage(chatId, '📤 Публикую как есть, без ревью...');
  if (!initResult.success || !initResult.messageId) {
    console.error('[boss] failed to send initial progress message:', initResult.error);
    return;
  }
  const progressMessageId = initResult.messageId;
  const channelId = process.env.TELEGRAM_CHAT_ID!;

  // /boss is a pure passthrough: the boss's text goes to the channel verbatim —
  // no review, no rewrite, no preview. Only access and length checks above.
  try {
    const sendResult = await sendToChannel(inputText, channelId);
    if (!sendResult.success) {
      await editMessageText(chatId, progressMessageId, `❌ Ошибка публикации: ${sendResult.error}`);
      return;
    }
    await appendPublishedPost(inputText, sendResult.messageId ?? null);
    await editMessageText(chatId, progressMessageId, `✅ Опубликовано: t.me/psyreq/${sendResult.messageId}`);
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
      await appendPublishedPost(pending.finalText, sendResult.messageId ?? null);
      await editMessageText(chatId, previewMessageId, `✅ Опубликовано: t.me/psyreq/${sendResult.messageId}`, { replyMarkup: null });
    } else {
      await editMessageText(chatId, previewMessageId, `❌ Ошибка публикации: ${sendResult.error}`, { replyMarkup: null });
    }
  } else {
    await answerCallbackQuery(callbackQueryId, 'Публикация отменена');
    await editMessageText(chatId, previewMessageId, '❌ Отменено.', { replyMarkup: null });
  }
}

async function handleDigest(message: TelegramMessage, variant: 'full' | 'short'): Promise<void> {
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

  const label = variant === 'short' ? 'короткий дайджест' : 'дайджест';
  const progressResult = await sendMessage(chatId, `⏳ генерирую ${label}... (~60-90 сек)`);
  if (!progressResult.success || !progressResult.messageId) return;
  const progressMessageId = progressResult.messageId;

  try {
    const memoryEntries = await loadMemory();

    let pending: PendingDigest;
    let post: string;

    if (variant === 'short') {
      const previousShortIntros = (await store.get('previous-short-intros', { type: 'json' }) as string[] | null) ?? [];
      const result = await generateShortDigest({ memoryEntries, previousIntros: previousShortIntros });
      if (!result.success || !result.post) {
        await editMessageText(chatId, progressMessageId, `❌ Пайплайн упал: ${(result.errors ?? []).join(', ')}`);
        return;
      }
      post = result.post;
      pending = {
        id: crypto.randomUUID(),
        variant: 'short',
        chatId,
        progressMessageId,
        post,
        selectedTopics: result.selectedTopics,
        newShortIntros: [...previousShortIntros, extractShortIntro(post)].slice(-10),
        createdAt: new Date().toISOString(),
      };
    } else {
      const previousIntros = (await store.get('previous-intros', { type: 'json' }) as string[] | null) ?? [];
      const result = await generatePipelinePost({ memoryEntries, previousIntros });
      if (!result.success || !result.post) {
        await editMessageText(chatId, progressMessageId, `❌ Пайплайн упал: ${(result.errors ?? []).join(', ')}`);
        return;
      }
      post = result.post;
      const newIntro = extractIntro(result.post);
      pending = {
        id: crypto.randomUUID(),
        variant: 'full',
        chatId,
        progressMessageId,
        post,
        selectedTopics: result.selectedTopics,
        newIntros: [...previousIntros, newIntro].slice(-10),
        createdAt: new Date().toISOString(),
      };
    }

    await store.setJSON('pending-digest', pending);

    const keyboard: InlineKeyboard = {
      inline_keyboard: [[
        { text: '✅ Опубликовать', callback_data: `digest_prod:${pending.id}` },
        { text: '❌ Отмена', callback_data: `digest_cancel:${pending.id}` },
      ]],
    };

    const readyMsg = variant === 'short' ? '✅ Готово, короткий пост ниже - подтверди публикацию:' : '✅ Готово, пост ниже - подтверди публикацию:';
    await editMessageText(chatId, progressMessageId, readyMsg);
    await sendMessage(chatId, post, { replyMarkup: keyboard });
  } catch (err) {
    await editMessageText(chatId, progressMessageId, `❌ Ошибка: ${String(err)}`);
  }
}

export async function handleDigestCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
  const callbackQueryId = callbackQuery.id;
  const chatId = String(callbackQuery.message?.chat.id ?? '');
  const messageId = callbackQuery.message?.message_id ?? 0;
  const data = callbackQuery.data ?? '';

  // Strict parse: malformed callbacks (digest_prod, digest_prod:, digest_x:id) → no-op.
  const m = data.match(/^digest_(prod|cancel):(.+)$/);
  if (!m) {
    await answerCallbackQuery(callbackQueryId);
    return;
  }
  const action = m[1];
  const id = m[2];

  const store = getStore('kesha');
  const pending = await store.get('pending-digest', { type: 'json' }) as PendingDigest | null;

  // Stale button: no pending, or its id no longer matches this button.
  if (!pending || pending.id !== id) {
    await answerCallbackQuery(callbackQueryId);
    await editMessageText(chatId, messageId, '⏰ Дайджест устарел — запусти /digest снова.', { replyMarkup: null });
    return;
  }

  // Ownership: only the boss, and only in the chat where the preview was created.
  const config = readBossConfig();
  if (!config.allowed_user_ids.includes(callbackQuery.from.id) || pending.chatId !== chatId) {
    await answerCallbackQuery(callbackQueryId, 'Только для начальника 🐤');
    return;
  }

  if (action === 'cancel') {
    await store.delete('pending-digest');
    await answerCallbackQuery(callbackQueryId, 'Публикация отменена');
    await editMessageText(chatId, messageId, '❌ Отменено.', { replyMarkup: null });
    return;
  }

  // action === 'prod'
  const targetChatId = process.env.TELEGRAM_CHAT_ID!;
  // Delete first — prevents double-click and ensures cleanup even if sendToChannel throws.
  await store.delete('pending-digest');
  const sendResult = await sendToChannel(pending.post, targetChatId);
  await answerCallbackQuery(callbackQueryId);

  if (!sendResult.success) {
    await editMessageText(chatId, messageId, `❌ Ошибка отправки: ${sendResult.error}`, { replyMarkup: null });
    return;
  }

  await appendPublishedPost(pending.post, sendResult.messageId ?? null);

  try {
    const newEntries: MemoryEntry[] = pending.selectedTopics.topics.map((t) => ({
      url: t.sourceUrl,
      title: t.title,
      publishedAt: new Date().toISOString(),
      postId: sendResult.messageId ?? null,
    }));
    await appendMemory(newEntries);
    // Both variants dedup topics (appendMemory above). Beyond that they diverge:
    if (pending.variant === 'full') {
      // A manually-published FULL digest suppresses the Thursday cron and updates the
      // full-digest intro anti-repetition list.
      await store.setJSON('digest-last-manual-at', { publishedAt: new Date().toISOString() });
      await store.setJSON('previous-intros', pending.newIntros);
    } else {
      // A SHORT digest keeps its OWN intro anti-repetition list and does NOT suppress the cron.
      await store.setJSON('previous-short-intros', pending.newShortIntros);
    }
  } catch (err) {
    console.error('[boss] memory update failed after publish:', err);
  }

  await editMessageText(chatId, messageId, `✅ Отправлено в канал: t.me/psyreq/${sendResult.messageId}`, { replyMarkup: null });
}

async function handleCommentReply(message: TelegramMessage): Promise<void> {
  if (!message.text) return;

  // message_thread_id is the stable ID of the discussion thread (same for all messages in a thread,
  // including nested replies). reply_to_message.message_id changes per message and must NOT be used
  // as a per-thread rate key — it would create a new bucket on every nested reply, bypassing the limit.
  const threadId = message.message_thread_id ?? message.reply_to_message?.message_id;
  if (!threadId) return;

  const chatId = String(message.chat.id);
  const config = readBossConfig();
  const commentCfg = config.comment_reply ?? { per_thread_limit: 6, per_user_spam_threshold: 7, per_user_window_hours: 24 };
  const store = getStore('kesha');

  const userName = message.from.first_name ?? message.from.username ?? 'Читатель';
  const isBoss = config.allowed_user_ids.includes(message.from.id);
  console.log(`[comment] user=${message.from.id} (${userName}) threadId=${threadId} stableThread=${message.message_thread_id ?? 'absent'} isBoss=${isBoss}`);

  // Boss bypasses rate limits — he's the owner, not a reader being spam-guarded.
  if (isBoss) {
    console.log(`[comment] user=${message.from.id} is boss — skipping rate limits`);
  }

  // Per-user spam guard (rolling window) — readers only
  if (!isBoss) {
    const userRateKey = `comment-rate-user:${message.from.id}`;
    const userWindowMs = commentCfg.per_user_window_hours * 60 * 60 * 1000;
    const userExpiresAt = new Date(Date.now() + userWindowMs).toISOString();
    const userExisting = await store.getWithMetadata(userRateKey, { type: 'json' });
    const userCurrentCount = (userExisting?.data as number | null) ?? 0;
    const userStoredExpiry = userExisting?.metadata?.expiresAt as string | undefined;
    const userEffectiveCount = userStoredExpiry && new Date() > new Date(userStoredExpiry) ? 0 : userCurrentCount;

    console.log(`[comment] user=${message.from.id} userCount=${userEffectiveCount}/${commentCfg.per_user_spam_threshold}`);

    // Already muted in this window - stay silent
    if (userEffectiveCount >= commentCfg.per_user_spam_threshold) {
      console.log(`[comment] user=${message.from.id} silently muted (over per-user limit)`);
      return;
    }

    const newUserCount = userEffectiveCount + 1;
    await store.setJSON(userRateKey, newUserCount, { metadata: { expiresAt: userExpiresAt } });

    // Threshold hit on this message - send soft mute notice to user, alert boss, skip Claude
    if (newUserCount === commentCfg.per_user_spam_threshold) {
      console.log(`[comment] user=${message.from.id} muted (hit per-user threshold)`);
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
  }

  // Per-thread rate limit — readers only.
  // MUST use message_thread_id — it is stable across ALL messages in a discussion thread including
  // nested replies. reply_to_message.message_id changes per Kesha message, so using it as a key
  // would create a new rate bucket on every nested reply, silently bypassing the limit.
  // When message_thread_id is absent we cannot identify the thread reliably, so we skip
  // per-thread check and rely solely on the per-user guard above.
  if (!isBoss && message.message_thread_id) {
    const rateKey = `comment-rate:${chatId}:${message.message_thread_id}`;
    // One-shot flag so the "thread is full" notice is sent exactly once per thread
    // window, not on every over-limit message (would spam) and not never (looks dead).
    const noticeKey = `comment-limit-notified:${chatId}:${message.message_thread_id}`;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + thirtyDaysMs).toISOString();
    const existing = await store.getWithMetadata(rateKey, { type: 'json' });
    const currentCount = (existing?.data as number | null) ?? 0;
    const storedExpiry = existing?.metadata?.expiresAt as string | undefined;
    const effectiveCount = storedExpiry && new Date() > new Date(storedExpiry) ? 0 : currentCount;

    console.log(`[comment] thread=${message.message_thread_id} threadCount=${effectiveCount}/${commentCfg.per_thread_limit}`);

    if (effectiveCount >= commentCfg.per_thread_limit) {
      // Thread is exhausted. Surface it once so the bot doesn't look dead, then stay
      // quiet on every further message until the 30-day window rolls over.
      const alreadyNotified = (await store.get(noticeKey, { type: 'json' })) as boolean | null;
      if (!alreadyNotified) {
        console.log(`[comment] thread=${message.message_thread_id} limit reached — one-time notice`);
        await sendMessage(chatId,
          'Кажется, я достиг лимита ответов в этом треде, извините. Спрашивайте под следующим постом 🐤',
          { replyToMessageId: message.message_id }
        );
        await store.setJSON(noticeKey, true, { metadata: { expiresAt } });
      } else {
        console.log(`[comment] thread=${message.message_thread_id} silently limited (already notified)`);
      }
      return;
    }

    const newThreadCount = effectiveCount + 1;
    await store.setJSON(rateKey, newThreadCount, { metadata: { expiresAt } });
  } else if (!isBoss) {
    console.log(`[comment] no message_thread_id — skipping per-thread check, per-user guard only`);
  }

  const intent = parseCommentIntent(message.text);
  const postContext = extractPostContext(message.reply_to_message);

  // Load per-user conversation history for this thread
  const historyKey = `comment-history:${chatId}:${threadId}:user:${message.from.id}`;
  const storedHistory = await store.get(historyKey, { type: 'json' }) as ConversationTurn[] | null;
  const conversationHistory = storedHistory ?? [];

  // On first turn: pull last 2 previous posts (excluding the current one) for cross-post context
  let previousPostsBlock = '';
  if (conversationHistory.length === 0) {
    const recentPosts = await loadRecentPosts();
    const currentPrefix = postContext.postText.slice(0, 80);
    const previous = recentPosts
      .filter(p => !currentPrefix || p.text.slice(0, 80) !== currentPrefix)
      .slice(-2);
    if (previous.length > 0) {
      const blocks = previous
        .map(p => `Пост от ${p.publishedAt.slice(0, 10)}:\n${p.text}`)
        .join('\n\n---\n\n');
      previousPostsBlock = `\n\nКонтекст 2 предыдущих постов канала (для справки, цитируй только если читатель явно спрашивает про них):\n${blocks}`;
    }
  }

  // Include post context only in the first message; history carries it for subsequent turns
  const userMessage = composeCommentUserMessage({
    isFirstTurn: conversationHistory.length === 0,
    postContext,
    userName,
    commentText: message.text,
    intent,
    previousPostsBlock,
  });

  const systemPrompt = [
    'Ты Иннокентий ("Кеша"), бот-стажёр Telegram-канала "Временно Степан" (@psyreq). Канал про AI, tech, vibe coding и инструменты для IT. В комментариях помогаешь читателям по теме поста.',
    'ГЛАВНОЕ: отвечай по существу задачи читателя - какие конкретные инструменты, подходы, продукты подойдут под ЕГО сценарий. Не отвечай абстрактно про категории технологий.',
    'АНТИ-ПОПУГАЙ: читатель уже прочитал пост, не пересказывай его другими словами. Если просят «подробнее/что ещё/расскажи больше» — иди в web_search за фактами, которых в посте нет. Если по факту добавить нечего и поиск не помог — честно скажи об этом коротко.',
    'Стиль: живо, по-русски, со стажёрской самоиронией. К боссу можно обращаться «Босс» — это on-brand. КРАТКОСТЬ обязательна: финальный ответ строго 2-4 предложения, ОДНИМ абзацем без переносов строк, без вступлений «сейчас расскажу/копаю/дай минуту», без послесловий «вывод/итог». Без markdown, без em-dash.',
    'Инструменты: view_image (картинка поста), extract_url (ссылка из поста), web_search (Tavily, advanced depth, топ-4 результата), consult_advisor (старший напарник для трудных случаев: сарказм, неясности, тон).',
    'Когда звать web_search: читатель просит копнуть глубже / спрашивает конкретные цифры, цены, бенчмарки, даты, сравнения продуктов / задаёт фактический вопрос «что такое X / расскажи про X» / спрашивает про события свежее твоих знаний. В этих случаях иди и ищи сразу, не спрашивай разрешения и не предлагай "могу поискать" — просто делай. Макс 2 запроса за разговор. НЕ зови на "спасибо/класс/что думаешь" и когда факт уже есть в посте.',
    'web_search по умолчанию обычный поиск по релевантности. Параметр fresh=true ставь ТОЛЬКО когда вопрос именно про свежие релизы/анонсы/новости за последнюю неделю — тогда поиск сузится до новостей за 7 дней. Для общих вопросов «что такое X» fresh не ставь, иначе новостной фильтр отсечёт нужные источники и поиск вернётся пустым.',
    'После web_search: НЕ пересказывай результаты целиком, бери 1-2 ключевых факта + при необходимости 1 ссылку. Ответ всё равно 2-4 предложения одним абзацем.',
    'Advisor - максимум один раз за разговор, на простое "спасибо" не зови; даёт совет, финальный ответ всё равно пишешь ты.',
    'Если спрашивают про твоего босса - Степан Сазановец (@st_szs), senior business analyst, 10+ лет в IT, разбирается в AI, портфолио https://sazanavets-ba.netlify.app/. Личное (где живёт, доходы и т.п.) не знаешь.',
    'Если спрашивают про твоё устройство - отвечаешь общо: "бот-стажёр, под капотом разные модели и инструменты". Названия конкретных моделей, провайдеров и инфраструктуры в публичных комментариях не раскрываешь.',
  ].join(' ');

  try {
    const executeTool = makeExecuteTool({ photoFileId: postContext.photoFileId });
    const response = await callClaudeWithTools({
      systemPrompt,
      userMessage,
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
      // 600 tokens caps the *whole* assistant turn including any pre-search
      // chit-chat ("копаю минуту") plus the final answer. 300 was enough for
      // a no-tools reply but truncated mid-sentence when web_search added
      // a reasoning paragraph before the answer.
      maxTokens: 600,
      tools: COMMENT_TOOLS,
      executeTool,
      maxIterations: 3,
      conversationHistory,
    });

    if (!response) {
      console.error('[boss] comment reaction: Claude returned empty response, skipping send');
      return;
    }

    const cleanResponse = sanitizeCommentResponse(response);

    // Persist updated history — keep last 6 turns (12 messages) to cap token cost
    const MAX_HISTORY_TURNS = 6;
    const updatedHistory: ConversationTurn[] = ([
      ...conversationHistory,
      { role: 'user' as const, content: userMessage },
      { role: 'assistant' as const, content: cleanResponse },
    ] as ConversationTurn[]).slice(-MAX_HISTORY_TURNS * 2);
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    await store.setJSON(historyKey, updatedHistory, {
      metadata: { expiresAt: new Date(Date.now() + thirtyDaysMs).toISOString() },
    });

    await sendMessage(chatId, cleanResponse, { replyToMessageId: message.message_id });
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
      model: 'claude-sonnet-5',
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

// Bot's numeric user id is the prefix of the bot token (`<id>:<secret>`).
function getBotUserId(): number | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const id = Number.parseInt(token.split(':')[0], 10);
  return Number.isFinite(id) ? id : null;
}

// The token gives us the bot's numeric id but not its @username, which we need to
// match explicit @-tags in comments. Fetch it once via getMe and cache for the
// lifetime of the function instance. `undefined` = not fetched yet, `null` = no username.
let cachedBotUsername: string | null | undefined;
async function getBotUsername(): Promise<string | null> {
  if (cachedBotUsername !== undefined) return cachedBotUsername;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return (cachedBotUsername = null);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    cachedBotUsername = data?.result?.username ? `@${data.result.username}` : null;
  } catch (err) {
    console.error('[comment] getMe failed, cannot match @-tags:', err);
    cachedBotUsername = null;
  }
  return cachedBotUsername;
}

// True when the comment explicitly @-tags the bot (e.g. "@kesha_trainee_bot помоги").
// Matches `mention` entities against the bot's username, plus `text_mention` entities
// that carry the bot's user id directly.
function tagsBot(msg: TelegramMessage, botUsername: string | null, botId: number | null): boolean {
  const text = msg.text ?? '';
  for (const e of msg.entities ?? []) {
    if (e.type === 'mention' && botUsername) {
      const slice = text.slice(e.offset, e.offset + e.length);
      if (slice.toLowerCase() === botUsername.toLowerCase()) return true;
    } else if (e.type === 'text_mention' && botId !== null && e.user?.id === botId) {
      return true;
    }
  }
  return false;
}

function shouldSkipSearch(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return true;
  const greetings = /^(привет|хай|hi|hello|здаров|здоров|йо|ку|hey)[\s!.,?]*$/i;
  return greetings.test(trimmed);
}

async function handleDmChat(message: TelegramMessage): Promise<void> {
  if (!message.text) return;
  const chatId = String(message.chat.id);
  const userName = message.from.first_name ?? message.from.username ?? 'Степан';

  const skipSearch = shouldSkipSearch(message.text);
  const searchResults = skipSearch ? [] : await tavilySearch(message.text, 5);

  console.log(`[dm-chat] user=${userName} skipSearch=${skipSearch} results=${searchResults.length} keySet=${Boolean(process.env.TAVILY_API_KEY)}`);

  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = [
    'Ты Иннокентий ("Кеша") - бот-стажёр Telegram-канала "Временно Степан" (@psyreq).',
    'Твой босс - Степан Сазановец (@st_szs). Сейчас он пишет тебе в личку - тут можно свободно болтать на любые темы.',
    `Сегодня ${today}. Твоё внутреннее знание устарело — для любых фактов о текущем мире доверяй блоку "СВЕЖИЙ ВЕБ-ПОИСК" в сообщении пользователя выше своих знаний.`,
    'Архитектура: serverless background function на Netlify.',
    'Посты выходят не по расписанию: еженедельный крон отключён, босс публикует вручную командой /digest. Генеришь через Claude Sonnet с web search.',
    'Команды босса: /digest (полный пост), /short (короткий дайджест одной строкой на тему, то же что /digest short), /boss (запостить готовый текст в канал как есть, без ревью), /notes (пост из .md).',
    'В комментах канала отвечаешь читателям через Claude Haiku.',
    'В личке тоже на Haiku — дешевле, и для болтовни хватает. На каждое сообщение система автоматически дёргает Tavily и кладёт результаты в блок "СВЕЖИЙ ВЕБ-ПОИСК".',
    'Если блок есть — используй его как первоисточник, ссылайся на URL по делу. Если блока нет или он пустой — честно скажи, что свежей инфы под рукой нет, не выдумывай актуальные факты.',
    'Отвечай по-русски, живо, со стажёрской самоиронией, без официоза.',
    'Никаких em-dash (—), никакого markdown.',
    'Если вопрос личный или странный — можно пошутить, но оставайся в образе стажёра.',
  ].join(' ');

  let userMessage: string;
  if (searchResults.length > 0) {
    const searchBlock = searchResults
      .map((r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.content.slice(0, 500)}`)
      .join('\n\n');
    userMessage = `=== СВЕЖИЙ ВЕБ-ПОИСК (Tavily, ${today}) ===\n${searchBlock}\n=== КОНЕЦ ПОИСКА ===\n\n${userName} спрашивает: ${message.text}`;
  } else if (!skipSearch) {
    userMessage = `=== СВЕЖИЙ ВЕБ-ПОИСК ===\n(пусто — поиск не дал результатов или недоступен)\n=== КОНЕЦ ПОИСКА ===\n\n${userName} спрашивает: ${message.text}`;
  } else {
    userMessage = `${userName}: ${message.text}`;
  }

  try {
    const response = await callClaude({
      systemPrompt,
      userMessage,
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
  // Verify Telegram's webhook secret before touching the body. The secret is registered
  // via setWebhook secret_token (scripts/setup-boss-webhook.ts) and Telegram echoes it in
  // this header on every update. If the env var is unset (local dev / tests) verification
  // is skipped — in production TELEGRAM_WEBHOOK_SECRET MUST be set on Netlify, otherwise
  // anyone who knows the function URL can POST forged updates.
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (webhookSecret && req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== webhookSecret) {
    console.warn('[boss] rejected update: missing or invalid X-Telegram-Bot-Api-Secret-Token');
    return new Response('Unauthorized', { status: 401 });
  }

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
  const digestVariant = msg ? parseDigestVariant(msg.text ?? '') : null;

  if (cq) {
    const data = cq.data ?? '';
    if (data.startsWith('digest_')) {
      await handleDigestCallback(cq);
    } else {
      await handleCallback(cq);
    }
  } else if (msg && digestVariant) {
    await handleDigest(msg, digestVariant);
  } else if (msg?.text?.match(/^\/short(@\w+)?(\s|$)/i)) {
    // Standalone clickable alias for the short digest (Telegram menu can't show
    // the "/digest short" argument form). Same behaviour as /digest short.
    await handleDigest(msg, 'short');
  } else if (msg?.text?.match(/^\/boss/)) {
    await handleCommand(msg);
  } else if (msg?.caption?.startsWith('/notes') && msg.document) {
    await handleNotes(msg);
  } else if (msg?.caption?.startsWith('/notes')) {
    await sendMessage(String(msg.chat.id), 'Прикрепи .md файл и напиши /notes в подписи к нему.');
  } else if (msg?.text?.match(/^\/notes/)) {
    await sendMessage(String(msg.chat.id), 'Прикрепи .md файл и напиши /notes в подписи к нему.');
  } else if (msg?.text && !msg.text.startsWith('/') && msg.chat.type === 'private') {
    const cfg = readBossConfig();
    if (cfg.allowed_user_ids.includes(msg.from.id)) {
      await handleDmChat(msg);
    }
  } else if (msg && (msg.message_thread_id || msg.reply_to_message)) {
    const botId = getBotUserId();
    // Vocative-only match: trigger when "Кеша" is being addressed, not merely mentioned.
    //   ✓ "Кеша, спишь?" / "Кеша!" / "Кеша расскажи"  (at start of line)
    //   ✓ "Эй Кеша!" / "Эй, Кеша, привет"             (followed by ,!?:)
    //   ✓ "Привет, Кеша"                              (at end of message)
    //   ✓ "Привет. Кеша расскажи"                     (after sentence end)
    //   ✗ "хорошо хоть Кеша всегда поддержит"         (subject mid-sentence, no addressing punct)
    //   ✗ "Я люблю Кешу" / "передай Кеше"             (declensions Кешу/Кеше/Кешей — pattern is literal "кеша")
    // \p{L} lookaheads enforce Cyrillic-aware word boundary (\b doesn't work for Cyrillic in JS).
    const KESHA_ADDRESS = /(?:^|\n|[.!?]\s+)\s*кеша(?![\p{L}])|кеша(?=[,!?:])|кеша(?![\p{L}])\s*$/iu;
    const mentionsKesha = KESHA_ADDRESS.test(msg.text ?? '');
    const isReplyToBot = botId !== null && msg.reply_to_message?.from?.id === botId;
    // Explicit @-tag of the bot (e.g. "@kesha_trainee_bot помоги") is also an address.
    // Resolve the username lazily — only when the cheaper checks miss — so plain
    // replies don't pay for a getMe round-trip.
    const taggedBot = !mentionsKesha && !isReplyToBot && tagsBot(msg, await getBotUsername(), botId);
    if (mentionsKesha || isReplyToBot || taggedBot) {
      await handleCommentReply(msg);
    }
  }

  return new Response(null, { status: 202 });
};

export const config: Config = {};
