# Boss Command — Design Spec

**Date:** 2026-04-29
**Feature:** `/boss` Telegram command for on-demand post publishing

---

## Overview

Степан отправляет `/boss <текст>` в личку боту. Бот умно обрабатывает текст: исправляет грамматику и выносит вердикт READY/RAW. READY — публикует сразу. RAW — перезаписывает голосом Кеши и показывает preview с кнопками подтверждения.

Главная цель: **не запускать rewrite автоматически**. Степан в большинстве случаев шлёт уже готовый текст — лишние API-вызовы ему не нужны.

---

## Architecture

### New files

```
netlify/functions/kesha-boss-background.mts   ← Telegram webhook handler
src/lib/boss-pipeline.ts                       ← review + conditional rewrite + validate
src/config/boss-review.txt                     ← промпт review-шага
src/config/boss-rewrite.txt                    ← промпт rewrite-шага
scripts/setup-boss-webhook.ts                  ← одноразовый webhook setup
```

### Modified files

```
src/lib/telegram.ts       ← добавляем sendMessage, editMessageText, answerCallbackQuery
src/lib/validator.ts      ← добавляем validateBossPost
src/config/pipeline.json  ← добавляем блок boss_command
```

### No new npm dependencies

`crypto.randomUUID` встроен в Node 18+. Netlify Blobs уже используется.

---

## Webhook

Один dedicated background function `kesha-boss-background.mts` обрабатывает все incoming Telegram updates для boss command:

- `update.message` с командой `/boss` → command handler
- `update.callback_query` с `confirm:<id>` или `cancel:<id>` → preview callback handler

Background function возвращает `202` немедленно (Telegram удовлетворён). Вся обработка — async после return.

Webhook регистрируется скриптом `scripts/setup-boss-webhook.ts` (одноразово). Тот же скрипт вызывает `setMyCommands` для добавления `/boss` в подсказки бота.

---

## Command Flow

```
/boss [--raw|--skip] <text>
  ↓
1. Auth: user_id в allowed_user_ids? → нет: ответить "только для начальника"
2. Parse flags: --raw / --skip / auto
3. Extract text (всё после команды и флага)
4. Length check [50, 3500] → нарушение: ответить с лимитами
5. sendMessage("🔍 Ревьювлю...") → сохранить messageId
6. runBossPipeline(text, { forceRaw, forceSkip })
7. Branch on result:
   READY → editMessage("✅ Текст норм...") → publish → editMessage("✅ Опубликовано: ...")
   RAW   → editMessage("👀 Готово...") → save preview to Blobs → send preview with inline keyboard
```

---

## Pipeline (`src/lib/boss-pipeline.ts`)

### Input

```ts
interface BossPipelineOptions {
  forceRaw?: boolean;   // --raw flag
  forceSkip?: boolean;  // --skip flag
}

runBossPipeline(text: string, options: BossPipelineOptions): Promise<BossPipelineResult>
```

### Output

```ts
interface BossPipelineResult {
  success: boolean;
  branch: 'READY' | 'RAW';
  finalText: string;
  reviewOutput: {
    verdict: 'READY' | 'RAW';
    verdict_reason: string;
    corrected_text: string;
    grammar_notes: string;
  };
  rewriteOutput: string | null;
  error?: string;
  logs: string[];
}
```

### Step 1: Smart Review (always)

- Model: `claude-sonnet-5-20260401`, temp `0.3`, max_tokens `1024`
- Prompt: `boss-review.txt`
- Output: JSON с полями `verdict`, `verdict_reason`, `corrected_text`, `grammar_notes`
- Retry: если JSON невалидный → 1 retry с напоминанием про формат → фейл

### Branch decision

| Условие | Ветка |
|---|---|
| `--skip` флаг | READY (forced) |
| `--raw` флаг | RAW (forced) |
| verdict == READY | READY |
| verdict == RAW | RAW |

### Step 2A: READY

- Берём `reviewOutput.corrected_text` as-is
- Валидируем через `validateBossPost`
- Если фейл → возвращаем ошибку

### Step 2B: RAW — Rewrite

- Model: `claude-sonnet-5-20260401`, temp `0.6`, max_tokens `2048`
- Prompt: `boss-rewrite.txt`
- Input: `reviewOutput.corrected_text`
- Retry: если output содержит em-dash или markdown → 1 retry с reminder → фейл
- Валидируем через `validateBossPost`

### Logging

Каждый шаг: `console.log('[boss-pipeline] ...')`. Обязательно логируем:
- Исходный текст (полностью)
- Вердикт + verdict_reason
- Какая ветка (READY/RAW), был ли forceRaw/forceSkip
- corrected_text после review
- rewrite output (если был)
- Финальный текст
- Статус валидации

---

## Validation (`validateBossPost`)

Отдельная функция в `src/lib/validator.ts`. Проверяет только:

- Длина ≤ 4096 символов
- Нет em-dash (`\u2014`)
- Нет markdown (`**`, `##`, ` ``` `)

Существующий `validatePost` не трогаем — у него несовместимые правила для pipeline-постов.

---

## Preview Flow (ветка RAW)

### Сохранение в Blobs

```
store: 'kesha'
key: 'boss-preview:<previewId>'   (previewId = crypto.randomUUID())
value: {
  userId: number,
  chatId: string,       // чат Степана (откуда пришла команда), для editMessageText
  previewMessageId: number,  // message_id preview-сообщения с кнопками
  finalText: string,
  channelId: string,    // TELEGRAM_CHAT_ID из env — канал для публикации
  createdAt: string     // ISO string
}
```

### Preview message

```
🐤 Текст показался сыроватым, переписал. Постить?

<finalText>

[✅ Постить]  [❌ Отмена]
```

`callback_data`: `confirm:<previewId>` / `cancel:<previewId>`

### Callback handling

1. Парсим `callback_data` → тип + previewId
2. Достаём из Blobs → нет записи или `createdAt + 30min < now` → `answerCallbackQuery` + `editMessageText(chatId, previewMessageId, "⏰ Истекло время на подтверждение")`
3. `confirm` → `sendToChannel(finalText, channelId)` → `answerCallbackQuery` → `editMessageText(chatId, previewMessageId, "✅ Опубликовано: ...")`  (inline keyboard убирается)
4. `cancel` → `answerCallbackQuery` → `editMessageText(chatId, previewMessageId, "❌ Отменено")` (inline keyboard убирается)
5. В обоих случаях → `store.delete('boss-preview:<previewId>')`

Timeout cleanup — lazy, проверяется при каждом callback. Отдельного cron нет.

---

## Progress Messages

Редактируем одно сообщение через `editMessageText` (не спамим новыми).

**READY branch:**
```
🔍 Ревьювлю...
  → ✅ Текст норм, постить без переработки...
  → ✅ Опубликовано: t.me/psyreq/123
```

**RAW branch:**
```
🔍 Ревьювлю...
  → ✍️ Текст сыроват, переписываю голосом Кеши...
  → 👀 Готово. Превью выше, подтверди публикацию.
  → (после кнопки) ✅ Опубликовано: t.me/psyreq/123
```

---

## Telegram lib extensions (`src/lib/telegram.ts`)

```ts
sendMessage(chatId: string, text: string, options?: { replyMarkup?: InlineKeyboard }): Promise<SendResult>
editMessageText(chatId: string, messageId: number, text: string, options?: { replyMarkup?: InlineKeyboard }): Promise<void>
answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>
```

---

## Config (`pipeline.json`)

```json
"boss_command": {
  "enabled": true,
  "allowed_user_ids": [352830345],
  "min_input_length": 50,
  "max_input_length": 3500,
  "preview_timeout_minutes": 30,
  "models": {
    "review":  { "model": "claude-sonnet-5-20260401", "temperature": 0.3, "max_tokens": 1024 },
    "rewrite": { "model": "claude-sonnet-5-20260401", "temperature": 0.6, "max_tokens": 2048 }
  }
}
```

---

## Error Handling

| Этап | Ошибка | Поведение |
|---|---|---|
| Auth | User не в whitelist | «Извини, эта команда только для начальника» |
| Input | Текст вне [50, 3500] | Сообщение с лимитами |
| Review | Claude API error | Retry 1 раз → фейл с сообщением Степану |
| Review | JSON невалидный | Retry 1 раз с напоминанием → фейл |
| Rewrite | Claude API error | Retry 1 раз → фейл |
| Rewrite | Em-dash / markdown в output | Retry 1 раз с reminder → фейл |
| Validation | finalText > 4096 / em-dash / markdown | Фейл с деталями Степану |
| Callback | Preview истёк | «⏰ Истекло время на подтверждение» |
| Publish | Telegram API error | Retry 2 раза с exponential backoff → фейл |

---

## Out of Scope

- Веб-форма
- Медиа (картинки, видео)
- Превью для ветки READY
- Расписание / задержка публикации
- Аналитика
- Откат / удаление опубликованного поста

---

## Implementation Plan (step order)

1. Расширить `pipeline.json` блоком `boss_command`
2. Создать промпты `boss-review.txt` и `boss-rewrite.txt`
3. Расширить `src/lib/telegram.ts` новыми функциями
4. Добавить `validateBossPost` в `src/lib/validator.ts`
5. Реализовать `src/lib/boss-pipeline.ts`
6. Реализовать `netlify/functions/kesha-boss-background.mts`
7. Создать `scripts/setup-boss-webhook.ts` и зарегистрировать webhook
8. E2E тестирование по acceptance criteria из исходного спека
