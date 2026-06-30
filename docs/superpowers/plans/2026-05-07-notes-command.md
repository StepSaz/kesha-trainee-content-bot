# Notes Command & Bot Command Menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/notes` command (user sends `.md` file → Kesha post with preview flow) and update the bot command menu to show `/boss`, `/digest`, `/notes`.

**Architecture:** `handleNotes` added to `kesha-boss-background.mts` following the existing `/boss` preview pattern — download `.md` from Telegram, call Claude with a new persona prompt, save `PendingPreview` blob, send with ✅/❌ keyboard. The existing `handleCallback` already handles `confirm:` / `cancel:` — no new callback handler needed. `validateStream` from `validator.ts` already exists and is the right validator for this post type.

**Tech Stack:** Node.js 22 + TypeScript ESM, Netlify Functions v2, `@netlify/blobs`, `@anthropic-ai/sdk`, Telegram Bot API

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/config/notes-persona.txt` | **create** | Claude prompt: convert raw meeting/stream notes to Kesha-style post |
| `netlify/functions/kesha-boss-background.mts` | modify | TelegramMessage + `caption`/`document` fields; `handleNotes`; router update |
| `scripts/setup-boss-webhook.ts` | modify | `setMyCommands`: add `/digest` and `/notes` |

---

## Task 1: `src/config/notes-persona.txt`

**Files:**
- Create: `src/config/notes-persona.txt`

No automated tests — this is a prompt file. Quality is verified manually via the full flow in Task 2.

- [ ] **Step 1.1: Create the prompt file**

Create `src/config/notes-persona.txt` with this exact content:

```
Ты — Кеша 🐤, бот-стажёр канала "Временно Степан" (@psyreq).

Тебе скинули нотсы — конспект митинга, стрима или созвона. Напиши на их основе пост для Telegram-канала в своём голосе.

СТРУКТУРА ПОСТА (обязательная):
Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ. Не бейте. 🐤

Кеша на проводе 🐤

[2-4 тематических блока, разделённых ~ ~ ~]

[Финальная фраза + 🐤]

ГОЛОС КЕШИ:
- Стажёр, который внимательно слушал и старательно конспектировал
- Тон живой, разговорный, без канцелярщины
- Лёгкая самоирония ("я старался", "если правильно записал")
- Эмодзи в меру: 🐤, 👀, 🫡, 📝

ЖЁСТКИЕ ПРАВИЛА:
1. Только факты из нотсов — ни слова от себя, никаких домыслов
2. Сохрани все имена, цифры, термины, ссылки точно как в нотсах
3. Em-dash (—) ЗАПРЕЩЁН — используй дефис или переформулируй
4. Plain text только — никакого markdown (**, ##, ```)
5. Длина — до 2500 символов. Если нотсы длиннее — сжимай, выбирай главное
6. Не раздувай — стилизация, а не расширение

СТРУКТУРА БЛОКОВ:
- Каждый блок = одна тема из нотсов
- Абзацы короткие (2-4 предложения), пустая строка между ними
- Между блоками разделитель: ~ ~ ~

Верни ТОЛЬКО текст поста. Без преамбул, без "вот мой вариант:", без объяснений.
```

- [ ] **Step 1.2: Commit**

```bash
git add src/config/notes-persona.txt
git commit -m "feat(notes): add Kesha notes-to-post persona prompt"
```

---

## Task 2: `handleNotes` in `kesha-boss-background.mts`

**Files:**
- Modify: `netlify/functions/kesha-boss-background.mts`

No new test file — the background function follows the existing untested pattern. Run `npx vitest run` to verify existing tests still pass after each edit.

- [ ] **Step 2.1: Add `validateStream` import**

Open `netlify/functions/kesha-boss-background.mts`. Find the existing import on line 1:

```typescript
import type { Config } from '@netlify/functions';
```

The file currently has no import from `validator.ts`. Add this import after the existing imports (after line 16, `import { callClaude } from '../../src/lib/claude.js';`):

```typescript
import { validateStream } from '../../src/lib/validator.js';
```

- [ ] **Step 2.2: Extend `TelegramMessage` interface**

Find the current `TelegramMessage` interface (lines 27-33):

```typescript
interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  text?: string;
  reply_to_message?: { message_id: number; text?: string };
}
```

Replace it with:

```typescript
interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  reply_to_message?: { message_id: number; text?: string };
}
```

- [ ] **Step 2.3: Add `handleNotes` function**

Add this function before the `export default` line:

```typescript
async function handleNotes(message: TelegramMessage): Promise<void> {
  const chatId = String(message.chat.id);
  const config = readBossConfig();

  if (!config.allowed_user_ids.includes(message.from.id)) {
    await sendMessage(chatId, 'Только для начальника 🐤');
    return;
  }

  const doc = message.document!;
  const fileName = doc.file_name ?? '';
  if (!fileName.toLowerCase().endsWith('.md')) {
    await sendMessage(chatId, '❌ Нужен .md файл.');
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

    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`
    );
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
      model: 'claude-sonnet-5-20260401',
      temperature: 0.7,
      maxTokens: 2048,
    });

    if (!generatedPost) {
      await editMessageText(chatId, progressMessageId, '❌ Claude вернул пустой ответ.');
      return;
    }

    const validation = validateStream(generatedPost);
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
```

- [ ] **Step 2.4: Update the router**

Find the current router block in `export default` (the `else if` chain):

```typescript
  } else if (msg?.text?.match(/^\/digest/)) {
    await handleDigest(msg);
  } else if (msg?.text?.match(/^\/boss/)) {
    await handleCommand(msg);
  } else if (msg && msg.reply_to_message && msg.from.id === 352830345) {
    await handleCommentReply(msg);
  }
```

Replace it with:

```typescript
  } else if (msg?.text?.match(/^\/digest/)) {
    await handleDigest(msg);
  } else if (msg?.text?.match(/^\/boss/)) {
    await handleCommand(msg);
  } else if (msg?.caption?.startsWith('/notes') && msg.document) {
    await handleNotes(msg);
  } else if (msg?.text?.match(/^\/notes/)) {
    await sendMessage(String(msg.chat.id), 'Прикрепи .md файл и напиши /notes в подписи к нему.');
  } else if (msg && msg.reply_to_message && msg.from.id === 352830345) {
    await handleCommentReply(msg);
  }
```

- [ ] **Step 2.5: Run tests**

```bash
npx vitest run
```

Expected: all 124 tests pass, zero failures.

- [ ] **Step 2.6: Commit**

```bash
git add netlify/functions/kesha-boss-background.mts
git commit -m "feat(notes): add /notes command — md file to Kesha post with preview flow"
```

---

## Task 3: Update bot command menu

**Files:**
- Modify: `scripts/setup-boss-webhook.ts`

- [ ] **Step 3.1: Add `/digest` and `/notes` to `setMyCommands`**

Find the current `commands` array in `scripts/setup-boss-webhook.ts`:

```typescript
    body: JSON.stringify({
      commands: [
        { command: 'boss', description: 'Опубликовать пост (только для начальника)' },
      ],
    }),
```

Replace with:

```typescript
    body: JSON.stringify({
      commands: [
        { command: 'boss', description: 'Опубликовать пост (только для начальника)' },
        { command: 'digest', description: 'Сгенерировать дайджест' },
        { command: 'notes', description: 'Пост из митинг нотсов / стрима' },
      ],
    }),
```

- [ ] **Step 3.2: Run tests**

```bash
npx vitest run
```

Expected: all 124 tests pass.

- [ ] **Step 3.3: Commit**

```bash
git add scripts/setup-boss-webhook.ts
git commit -m "feat(bot): register /digest and /notes in Telegram command menu"
```

- [ ] **Step 3.4: Re-run the webhook setup script**

After deploy, run this once with your credentials to update BotFather:

```bash
TELEGRAM_BOT_TOKEN=<your-token> NETLIFY_SITE_URL=https://your-site.netlify.app npx tsx scripts/setup-boss-webhook.ts
```

Expected output:
```
Setting webhook to: https://your-site.netlify.app/.netlify/functions/kesha-boss-background
✅ Webhook set
Registering /boss command...
✅ Commands registered

=== Webhook Info ===
URL: https://your-site.netlify.app/.netlify/functions/kesha-boss-background
Pending updates: 0
===================
```

After this, open the bot in Telegram and tap `/` — all three commands should appear in the menu.

---

## Manual Testing

After deploy:

1. Open `@kesha_trainee_bot` in Telegram
2. Tap `/` — verify `/boss`, `/digest`, `/notes` all appear in the menu
3. Tap `/notes` (no file) — bot should reply "Прикрепи .md файл и напиши /notes в подписи к нему."
4. Attach an `.md` file, type `/notes` as caption, send — bot should:
   - Reply "📝 Читаю нотсы..."
   - Edit to "✍️ Пишу пост..."
   - Edit to "👀 Готово. Превью ниже..."
   - Send the generated post with ✅/❌ buttons
5. Tap ✅ — post publishes to the channel
6. Tap ❌ — "❌ Отменено."
