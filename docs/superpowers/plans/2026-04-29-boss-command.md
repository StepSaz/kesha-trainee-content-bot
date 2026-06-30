# Boss Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/boss <text>` Telegram command that smart-reviews the text and either publishes immediately (READY) or rewrites in Kesha's voice and shows a preview (RAW).

**Architecture:** One dedicated Netlify background function (`kesha-boss-background.mts`) handles all incoming Telegram updates — messages with `/boss` and inline keyboard callbacks. The boss pipeline (`src/lib/boss-pipeline.ts`) does review + conditional rewrite. Pending previews stored in Netlify Blobs.

**Tech Stack:** TypeScript, Netlify Background Functions, Netlify Blobs, Telegram Bot API, Anthropic SDK (via existing `callClaude`), Vitest

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `netlify/functions/kesha-boss-background.mts` | Telegram webhook — routes `/boss` commands and inline callbacks |
| Create | `src/lib/boss-pipeline.ts` | Review + conditional rewrite + validation logic |
| Create | `src/config/boss-review.txt` | System prompt for the smart review step |
| Create | `src/config/boss-rewrite.txt` | System prompt for the rewrite step |
| Create | `scripts/setup-boss-webhook.ts` | One-time Telegram webhook + setMyCommands registration |
| Create | `src/lib/boss-command-parser.ts` | Pure helper: parse `/boss` text into flags + inputText |
| Create | `src/lib/__tests__/boss-pipeline.test.ts` | Tests for boss-pipeline |
| Create | `src/lib/__tests__/boss-command-parser.test.ts` | Tests for parseCommand (pure, no mocks needed) |
| Modify | `src/config/pipeline.json` | Add `boss_command` config block |
| Modify | `src/lib/telegram.ts` | Add `sendMessage`, `editMessageText`, `answerCallbackQuery`, `InlineKeyboard` types |
| Modify | `src/lib/validator.ts` | Add `validateBossPost` |
| Modify | `src/lib/__tests__/telegram.test.ts` | Tests for new telegram functions |
| Modify | `src/lib/__tests__/validator.test.ts` | Tests for `validateBossPost` |
| Modify | `package.json` | Add `setup:boss-webhook` npm script |

---

## Task 1: Extend pipeline.json with boss_command config

**Files:**
- Modify: `src/config/pipeline.json`

- [ ] **Step 1: Add the boss_command block**

Open `src/config/pipeline.json` and add after the closing `}` of `"managed"`. The full file should be:

```json
{
  "steps": {
    "gatherWeb": {
      "model": "claude-haiku-4-5-20251001",
      "temperature": 0.3,
      "max_tokens": 2048,
      "tools": ["web_search"]
    },
    "selectTopics": {
      "model": "claude-sonnet-5",
      "temperature": 0.3,
      "max_tokens": 2048,
      "tools": []
    },
    "generate": {
      "model": "claude-sonnet-5",
      "temperature": 0.8,
      "max_tokens": 4096,
      "tools": []
    },
    "review": {
      "model": "claude-haiku-4-5-20251001",
      "temperature": 0.3,
      "max_tokens": 1024,
      "tools": []
    },
    "rewrite": {
      "model": "claude-sonnet-5",
      "temperature": 0.7,
      "max_tokens": 4096,
      "tools": []
    },
    "fix": {
      "model": "claude-haiku-4-5-20251001",
      "temperature": 0.1,
      "max_tokens": 4096,
      "tools": []
    }
  },
  "managed": {
    "model": "claude-sonnet-5"
  },
  "max_review_cycles": 1,
  "boss_command": {
    "enabled": true,
    "allowed_user_ids": [352830345],
    "min_input_length": 50,
    "max_input_length": 3500,
    "preview_timeout_minutes": 30,
    "models": {
      "review": {
        "model": "claude-sonnet-5",
        "temperature": 0.3,
        "max_tokens": 1024
      },
      "rewrite": {
        "model": "claude-sonnet-5",
        "temperature": 0.6,
        "max_tokens": 2048
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/config/pipeline.json
git commit -m "feat(boss): add boss_command config block to pipeline.json"
```

---

## Task 2: Create boss prompt files

**Files:**
- Create: `src/config/boss-review.txt`
- Create: `src/config/boss-rewrite.txt`

- [ ] **Step 1: Create boss-review.txt**

Create `src/config/boss-review.txt`:

```
Ты - литературный редактор и стилист канала "Временно Степан".

ВХОДНОЙ ТЕКСТ - это пост, который автор канала Степан хочет опубликовать от имени бота-персонажа Кеши (Иннокентий, junior content-maker, 🐤).

Твои задачи:

ЗАДАЧА 1 - ИСПРАВИТЬ:
- Грамматику, пунктуацию, опечатки
- Если есть em-dash (—), заменить на обычный дефис (-) или перестроить предложение
- НЕ менять смысл, НЕ добавлять/удалять факты, НЕ переписывать стилистически

ЗАДАЧА 2 - ВЫНЕСТИ ВЕРДИКТ: текст готов к публикации в голосе Кеши, или его надо переписывать?

ВЕРДИКТ "READY" (постим как есть после грамматики), если:
- Текст звучит живо и разговорно (как голос Кеши: junior, увлечённый, с эмоцией)
- Есть структура (зацепка, развитие, какое-то завершение или мысль в конце)
- В меру эмодзи (особенно 🐤, 🤓, 📝, 😅)
- Нет AI-маркеров: рубленых предложений для драматизма, "Bottom line", "The Real Problem", корпоративных штампов
- Можно представить, что это пишет живой junior-блогер

ВЕРДИКТ "RAW" (нужен rewrite), если:
- Сухой / телеграфный стиль ("сегодня вышло то-то, оно работает так")
- Корпоративный / нейтральный тон (как пресс-релиз или Википедия)
- Похоже на заметку для себя, а не на пост в канал
- Структуры нет, только набор фактов
- Очевидные AI-маркеры в тексте

Если сомневаешься между READY и RAW - выбирай READY. Степан в большинстве случаев скидывает уже готовые тексты, лишний rewrite ему не нужен.

Верни СТРОГО валидный JSON, без преамбулы, без пояснений - только JSON:

{
  "verdict": "READY" или "RAW",
  "verdict_reason": "<1-2 предложения почему>",
  "corrected_text": "<текст после грамматических правок>",
  "grammar_notes": "<что исправил, или 'без замечаний'>"
}
```

- [ ] **Step 2: Create boss-rewrite.txt**

Create `src/config/boss-rewrite.txt`:

```
Ты - Иннокентий (Кеша 🐤), бот-коавтор канала "Временно Степан". Твой "начальник" Степан скинул тебе сырой черновик и поручил оформить пост в твоём стиле.

ТВОЙ ГОЛОС:
- Junior content-maker, увлечённый, немного тревожный, но старательный
- Эмодзи в умеренном количестве (🐤, 🤓, 📝, 😅)
- Разговорный тон, простые предложения, без академичности
- Лёгкая самоирония и вводные конструкции типа "честно говоря", "если коротко", "имхо"
- Никаких корпоративных штампов, никакого менторского тона

ЖЁСТКИЕ ПРАВИЛА:
1. СТРОГО следуй исходному содержанию. Не добавляй фактов, мнений, контекста, примеров, которых нет в исходнике.
2. Никаких комментариев "от себя" - никаких "(прим. Кеши: ...)", никаких рассуждений на полях.
3. Em-dash (—) ЗАПРЕЩЁН. Используй дефисы или перестраивай предложения.
4. Plain text only - никакого markdown (**bold**, *italic*, `code`). Telegram это не рендерит.
5. Длина - не превышай длину исходника более чем на 20%. Стилизация, а не расширение.
6. Не используй вводную "На связи Степан 😎" - это голос Степана, не твой.

ЧТО ДЕЛАТЬ:
- Перефразируй текст в своём голосе
- Сохрани все факты, цифры, ссылки, имена ровно как в оригинале
- Можешь чуть переставить акценты для лучшего flow, но без потери смысла

Верни ТОЛЬКО переписанный текст, без преамбул, без "вот мой вариант:", без объяснений.
```

- [ ] **Step 3: Commit**

```bash
git add src/config/boss-review.txt src/config/boss-rewrite.txt
git commit -m "feat(boss): add boss review and rewrite prompts"
```

---

## Task 3: Extend telegram.ts with sendMessage, editMessageText, answerCallbackQuery

**Files:**
- Modify: `src/lib/telegram.ts`
- Modify: `src/lib/__tests__/telegram.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/__tests__/telegram.test.ts` (after the existing `sendToChannel` describe block):

```typescript
import { sendToChannel, sendMessage, editMessageText, answerCallbackQuery } from '../telegram.js';

// ... existing tests ...

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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- telegram
```

Expected: FAIL — `sendMessage`, `editMessageText`, `answerCallbackQuery` are not exported from `telegram.ts`

- [ ] **Step 3: Implement the new functions**

Replace the entire `src/lib/telegram.ts` with:

```typescript
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

  await fetch(
    `https://api.telegram.org/bot${token}/editMessageText`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

export async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN!;

  await fetch(
    `https://api.telegram.org/bot${token}/answerCallbackQuery`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    }
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- telegram
```

Expected: all `telegram.test.ts` tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/telegram.ts src/lib/__tests__/telegram.test.ts
git commit -m "feat(boss): add sendMessage, editMessageText, answerCallbackQuery to telegram lib"
```

---

## Task 4: Add validateBossPost

**Files:**
- Modify: `src/lib/validator.ts`
- Modify: `src/lib/__tests__/validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the end of `src/lib/__tests__/validator.test.ts`:

```typescript
import { validatePost, validateBossPost } from '../validator.js';

// ... existing tests ...

describe('validateBossPost', () => {
  it('passes a clean post', () => {
    const text = 'Это обычный пост без проблем. Вполне нормальный текст. 🐤';
    expect(validateBossPost(text)).toEqual({ valid: true, errors: [] });
  });

  it('fails when post exceeds 4096 characters', () => {
    const text = 'a'.repeat(4097);
    const result = validateBossPost(text);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('4097') && e.includes('4096'))).toBe(true);
  });

  it('passes a post of exactly 4096 characters', () => {
    const text = 'a'.repeat(4096);
    expect(validateBossPost(text).valid).toBe(true);
  });

  it('fails with em-dash', () => {
    const text = 'Текст\u2014с длинным тире';
    const result = validateBossPost(text);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('em-dash'))).toBe(true);
  });

  it('fails with markdown bold', () => {
    const text = 'Текст с **bold** словом';
    const result = validateBossPost(text);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('markdown'))).toBe(true);
  });

  it('fails with markdown heading', () => {
    const text = 'Текст\n## Заголовок\nТекст';
    const result = validateBossPost(text);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('markdown'))).toBe(true);
  });

  it('fails with code block', () => {
    const text = 'Текст\n```код```\nТекст';
    const result = validateBossPost(text);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('markdown'))).toBe(true);
  });

  it('collects multiple errors', () => {
    const text = 'x\u2014y **bold**';
    const result = validateBossPost(text);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- validator
```

Expected: FAIL — `validateBossPost` not exported

- [ ] **Step 3: Implement validateBossPost**

Append to `src/lib/validator.ts`:

```typescript
export function validateBossPost(text: string): ValidationResult {
  const errors: string[] = [];

  if (text.length > 4096) {
    errors.push(`Post too long: ${text.length} chars (max 4096)`);
  }

  if (text.includes('\u2014')) {
    errors.push('Contains em-dash (—), use hyphen instead');
  }

  if (/\*\*|##|```/.test(text)) {
    errors.push('Contains markdown formatting (**, ##, ```)');
  }

  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- validator
```

Expected: all `validator.test.ts` tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/validator.ts src/lib/__tests__/validator.test.ts
git commit -m "feat(boss): add validateBossPost to validator"
```

---

## Task 5: Implement boss-pipeline.ts

**Files:**
- Create: `src/lib/boss-pipeline.ts`
- Create: `src/lib/__tests__/boss-pipeline.test.ts`

**Prerequisite:** Tasks 2, 3, 4 must be complete (prompts exist on disk, `validateBossPost` and `callClaude` are importable).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/boss-pipeline.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../claude.js', () => ({ callClaude: vi.fn() }));
vi.mock('../validator.js', () => ({
  validatePost: vi.fn(),
  validateBossPost: vi.fn(),
}));

import { runBossPipeline } from '../boss-pipeline.js';
import { callClaude } from '../claude.js';
import { validateBossPost } from '../validator.js';

const mockCallClaude = vi.mocked(callClaude);
const mockValidateBossPost = vi.mocked(validateBossPost);

function makeReviewJson(verdict: 'READY' | 'RAW', correctedText = 'Corrected text.'): string {
  return JSON.stringify({
    verdict,
    verdict_reason: verdict === 'READY' ? 'Текст живой и разговорный.' : 'Текст сухой.',
    corrected_text: correctedText,
    grammar_notes: 'без замечаний',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateBossPost.mockReturnValue({ valid: true, errors: [] });
});

describe('runBossPipeline — READY branch', () => {
  it('returns READY branch with corrected_text when verdict is READY', async () => {
    mockCallClaude.mockResolvedValueOnce(makeReviewJson('READY', 'Исправленный текст.'));

    const result = await runBossPipeline('Некоторый текст поста.', {});

    expect(result.success).toBe(true);
    expect(result.branch).toBe('READY');
    expect(result.finalText).toBe('Исправленный текст.');
    expect(result.rewriteOutput).toBeNull();
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });

  it('does not call rewrite when verdict is READY', async () => {
    mockCallClaude.mockResolvedValueOnce(makeReviewJson('READY'));

    await runBossPipeline('Некоторый текст.', {});

    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });

  it('returns READY branch when forceSkip=true even if verdict is RAW', async () => {
    mockCallClaude.mockResolvedValueOnce(makeReviewJson('RAW', 'Сырой текст.'));

    const result = await runBossPipeline('Некоторый текст.', { forceSkip: true });

    expect(result.branch).toBe('READY');
    expect(result.finalText).toBe('Сырой текст.');
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });
});

describe('runBossPipeline — RAW branch', () => {
  it('calls rewrite and returns RAW branch when verdict is RAW', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('RAW', 'Сырой текст.'))
      .mockResolvedValueOnce('Переписанный текст в голосе Кеши.');

    const result = await runBossPipeline('Сырой черновик.', {});

    expect(result.success).toBe(true);
    expect(result.branch).toBe('RAW');
    expect(result.finalText).toBe('Переписанный текст в голосе Кеши.');
    expect(result.rewriteOutput).toBe('Переписанный текст в голосе Кеши.');
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it('returns RAW branch when forceRaw=true even if verdict is READY', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('READY', 'Готовый текст.'))
      .mockResolvedValueOnce('Принудительно переписанный текст.');

    const result = await runBossPipeline('Готовый текст.', { forceRaw: true });

    expect(result.branch).toBe('RAW');
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it('calls onProgress with rewrite status before calling rewrite', async () => {
    const callOrder: string[] = [];
    mockCallClaude
      .mockImplementationOnce(async () => { callOrder.push('review'); return makeReviewJson('RAW'); })
      .mockImplementationOnce(async () => { callOrder.push('rewrite'); return 'Rewritten.'; });

    const onProgress = vi.fn().mockImplementation(async () => { callOrder.push('progress'); });
    await runBossPipeline('Сырой.', {}, onProgress);

    expect(onProgress).toHaveBeenCalledWith('✍️ Текст сыроват, переписываю голосом Кеши...');
    expect(callOrder.indexOf('progress')).toBeLessThan(callOrder.indexOf('rewrite'));
  });
});

describe('runBossPipeline — review retry', () => {
  it('retries review once when response is not valid JSON', async () => {
    mockCallClaude
      .mockResolvedValueOnce('не JSON')
      .mockResolvedValueOnce(makeReviewJson('READY'));

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it('returns failure when review fails JSON parse twice', async () => {
    mockCallClaude
      .mockResolvedValueOnce('не JSON')
      .mockResolvedValueOnce('тоже не JSON');

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('runBossPipeline — rewrite retry', () => {
  it('retries rewrite once when output contains em-dash', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('RAW'))
      .mockResolvedValueOnce('Текст\u2014с тире')
      .mockResolvedValueOnce('Текст без тире.');

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(true);
    expect(result.finalText).toBe('Текст без тире.');
    expect(mockCallClaude).toHaveBeenCalledTimes(3);
  });

  it('retries rewrite once when output contains markdown', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('RAW'))
      .mockResolvedValueOnce('Текст **bold** слово')
      .mockResolvedValueOnce('Текст без разметки.');

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(true);
    expect(result.finalText).toBe('Текст без разметки.');
  });

  it('returns failure when rewrite still has em-dash after retry', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('RAW'))
      .mockResolvedValueOnce('Текст\u2014тире')
      .mockResolvedValueOnce('Снова\u2014тире');

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('em-dash');
  });
});

describe('runBossPipeline — validation failure', () => {
  it('returns failure when validateBossPost fails on READY branch', async () => {
    mockCallClaude.mockResolvedValueOnce(makeReviewJson('READY', 'Слишком длинный текст.'));
    mockValidateBossPost.mockReturnValue({ valid: false, errors: ['Post too long: 5000 chars (max 4096)'] });

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Post too long');
  });

  it('returns failure when validateBossPost fails on RAW branch', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeReviewJson('RAW'))
      .mockResolvedValueOnce('Текст с проблемами.');
    mockValidateBossPost.mockReturnValue({ valid: false, errors: ['Contains em-dash (—)'] });

    const result = await runBossPipeline('Текст.', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('em-dash');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- boss-pipeline
```

Expected: FAIL — `boss-pipeline.ts` not found

- [ ] **Step 3: Create boss-pipeline.ts**

Create `src/lib/boss-pipeline.ts`:

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { callClaude } from './claude.js';
import { validateBossPost } from './validator.js';

function readConfig(filename: string): string {
  return readFileSync(join(process.cwd(), 'src/config', filename), 'utf-8');
}

interface BossModelConfig {
  model: string;
  temperature: number;
  max_tokens: number;
}

interface BossCommandConfig {
  models: {
    review: BossModelConfig;
    rewrite: BossModelConfig;
  };
}

export interface BossReviewOutput {
  verdict: 'READY' | 'RAW';
  verdict_reason: string;
  corrected_text: string;
  grammar_notes: string;
}

export interface BossPipelineOptions {
  forceRaw?: boolean;
  forceSkip?: boolean;
}

export interface BossPipelineResult {
  success: boolean;
  branch: 'READY' | 'RAW';
  finalText: string;
  reviewOutput: BossReviewOutput;
  rewriteOutput: string | null;
  error?: string;
}

async function runReview(text: string, cfg: BossModelConfig): Promise<BossReviewOutput> {
  const systemPrompt = readConfig('boss-review.txt');

  async function attempt(extra?: string): Promise<BossReviewOutput> {
    const raw = await callClaude({
      systemPrompt: extra ? `${systemPrompt}\n\n${extra}` : systemPrompt,
      userMessage: text,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.max_tokens,
    });
    return JSON.parse(raw) as BossReviewOutput;
  }

  try {
    return await attempt();
  } catch {
    console.log('[boss-pipeline] review JSON parse failed, retrying...');
    return await attempt('ВАЖНО: верни СТРОГО валидный JSON без преамбулы, первым символом должен быть {');
  }
}

function hasFormattingProblems(text: string): boolean {
  return text.includes('\u2014') || /\*\*|##|```/.test(text);
}

async function runRewrite(correctedText: string, cfg: BossModelConfig): Promise<string> {
  const systemPrompt = readConfig('boss-rewrite.txt');

  async function attempt(extra?: string): Promise<string> {
    return callClaude({
      systemPrompt: extra ? `${systemPrompt}\n\n${extra}` : systemPrompt,
      userMessage: correctedText,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.max_tokens,
    });
  }

  const result = await attempt();
  if (!hasFormattingProblems(result)) return result;

  console.log('[boss-pipeline] rewrite has em-dash/markdown, retrying...');
  const retry = await attempt('СТОП: em-dash (—) ЗАПРЕЩЁН, используй дефис (-). Markdown (**, ##, ```) ЗАПРЕЩЁН. Верни только plain text.');
  if (!hasFormattingProblems(retry)) return retry;

  throw new Error('Rewrite contains em-dash or markdown after retry');
}

export async function runBossPipeline(
  text: string,
  options: BossPipelineOptions,
  onProgress?: (status: string) => Promise<void>
): Promise<BossPipelineResult> {
  const pipelineConfig = JSON.parse(readConfig('pipeline.json')) as { boss_command: BossCommandConfig };
  const cfg = pipelineConfig.boss_command;

  console.log(`[boss-pipeline] start length=${text.length} forceRaw=${options.forceRaw ?? false} forceSkip=${options.forceSkip ?? false}`);
  console.log(`[boss-pipeline] input: ${text}`);

  let reviewOutput: BossReviewOutput;
  try {
    reviewOutput = await runReview(text, cfg.models.review);
  } catch (err) {
    console.error('[boss-pipeline] review failed:', err);
    return {
      success: false,
      branch: 'READY',
      finalText: '',
      reviewOutput: { verdict: 'READY', verdict_reason: '', corrected_text: '', grammar_notes: '' },
      rewriteOutput: null,
      error: `Review failed: ${String(err)}`,
    };
  }

  console.log(`[boss-pipeline] verdict=${reviewOutput.verdict} reason=${reviewOutput.verdict_reason}`);
  console.log(`[boss-pipeline] corrected_text: ${reviewOutput.corrected_text}`);

  const branch: 'READY' | 'RAW' = options.forceSkip
    ? 'READY'
    : options.forceRaw
      ? 'RAW'
      : reviewOutput.verdict;

  console.log(`[boss-pipeline] branch=${branch}`);

  if (branch === 'READY') {
    const finalText = reviewOutput.corrected_text;
    const validation = validateBossPost(finalText);
    if (!validation.valid) {
      return { success: false, branch, finalText, reviewOutput, rewriteOutput: null, error: validation.errors.join('; ') };
    }
    console.log(`[boss-pipeline] READY done`);
    return { success: true, branch, finalText, reviewOutput, rewriteOutput: null };
  }

  if (onProgress) await onProgress('✍️ Текст сыроват, переписываю голосом Кеши...');

  let rewriteOutput: string;
  try {
    rewriteOutput = await runRewrite(reviewOutput.corrected_text, cfg.models.rewrite);
  } catch (err) {
    console.error('[boss-pipeline] rewrite failed:', err);
    return { success: false, branch, finalText: '', reviewOutput, rewriteOutput: null, error: String(err) };
  }

  console.log(`[boss-pipeline] rewrite done: ${rewriteOutput}`);

  const validation = validateBossPost(rewriteOutput);
  if (!validation.valid) {
    return { success: false, branch, finalText: rewriteOutput, reviewOutput, rewriteOutput, error: validation.errors.join('; ') };
  }

  return { success: true, branch, finalText: rewriteOutput, reviewOutput, rewriteOutput };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- boss-pipeline
```

Expected: all `boss-pipeline.test.ts` tests PASS

- [ ] **Step 5: Run all tests to check for regressions**

```bash
npm test
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/boss-pipeline.ts src/lib/__tests__/boss-pipeline.test.ts
git commit -m "feat(boss): implement boss-pipeline with review, conditional rewrite, and retry logic"
```

---

## Task 6: Implement kesha-boss-background.mts

**Files:**
- Create: `src/lib/boss-command-parser.ts`
- Create: `src/lib/__tests__/boss-command-parser.test.ts`
- Create: `netlify/functions/kesha-boss-background.mts`

- [ ] **Step 1: Write failing tests for parseCommand**

Create `src/lib/__tests__/boss-command-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseCommand } from '../boss-command-parser.js';

describe('parseCommand', () => {
  it('extracts plain text without flags', () => {
    expect(parseCommand('/boss Привет мир')).toEqual({ forceRaw: false, forceSkip: false, inputText: 'Привет мир' });
  });

  it('extracts text with --raw flag', () => {
    expect(parseCommand('/boss --raw Мой текст поста')).toEqual({ forceRaw: true, forceSkip: false, inputText: 'Мой текст поста' });
  });

  it('extracts text with --skip flag', () => {
    expect(parseCommand('/boss --skip Готовый пост')).toEqual({ forceRaw: false, forceSkip: true, inputText: 'Готовый пост' });
  });

  it('handles /boss@botname format (Telegram group syntax)', () => {
    expect(parseCommand('/boss@keshbot Текст поста')).toEqual({ forceRaw: false, forceSkip: false, inputText: 'Текст поста' });
  });

  it('handles /boss@botname --raw format', () => {
    expect(parseCommand('/boss@keshbot --raw Сырой текст')).toEqual({ forceRaw: true, forceSkip: false, inputText: 'Сырой текст' });
  });

  it('trims extra whitespace from inputText', () => {
    expect(parseCommand('/boss   много пробелов   ').inputText).toBe('много пробелов');
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

```bash
npm test -- boss-command-parser
```

Expected: FAIL — `boss-command-parser.ts` not found

- [ ] **Step 3: Create boss-command-parser.ts**

Create `src/lib/boss-command-parser.ts`:

```typescript
export function parseCommand(text: string): { forceRaw: boolean; forceSkip: boolean; inputText: string } {
  const withoutCommand = text.replace(/^\/boss\S*\s*/, '');

  if (withoutCommand.startsWith('--raw ')) {
    return { forceRaw: true, forceSkip: false, inputText: withoutCommand.slice(6).trim() };
  }
  if (withoutCommand.startsWith('--skip ')) {
    return { forceRaw: false, forceSkip: true, inputText: withoutCommand.slice(7).trim() };
  }
  return { forceRaw: false, forceSkip: false, inputText: withoutCommand.trim() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- boss-command-parser
```

Expected: all tests PASS

- [ ] **Step 5: Commit the parser**

```bash
git add src/lib/boss-command-parser.ts src/lib/__tests__/boss-command-parser.test.ts
git commit -m "feat(boss): add parseCommand helper with tests"
```

- [ ] **Step 7: Create kesha-boss-background.mts**

Create `netlify/functions/kesha-boss-background.mts`:

```typescript
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

  if (update.message?.text?.match(/^\/boss/)) {
    await handleCommand(update.message);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query);
  }

  return new Response(null, { status: 202 });
};

export const config: Config = {};
```

- [ ] **Step 8: Run all tests to check for regressions**

```bash
npm test
```

Expected: all tests PASS

- [ ] **Step 9: Commit**

```bash
git add netlify/functions/kesha-boss-background.mts
git commit -m "feat(boss): implement kesha-boss-background webhook handler"
```

---

## Task 7: Create webhook setup script and register with Telegram

**Files:**
- Create: `scripts/setup-boss-webhook.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the setup script**

Create `scripts/setup-boss-webhook.ts`:

```typescript
async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const siteUrl = process.env.NETLIFY_SITE_URL;

  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
  }

  if (!siteUrl) {
    console.error('Error: NETLIFY_SITE_URL not set (e.g. https://your-site.netlify.app)');
    process.exit(1);
  }

  const webhookUrl = `${siteUrl}/.netlify/functions/kesha-boss-background`;
  const apiBase = `https://api.telegram.org/bot${token}`;

  // 1. Set webhook
  console.log(`Setting webhook to: ${webhookUrl}`);
  const webhookRes = await fetch(`${apiBase}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });
  const webhookData = await webhookRes.json() as { ok: boolean; description?: string };
  if (!webhookData.ok) {
    console.error('setWebhook failed:', webhookData.description);
    process.exit(1);
  }
  console.log('✅ Webhook set');

  // 2. Register /boss command in bot command list
  console.log('Registering /boss command...');
  const commandsRes = await fetch(`${apiBase}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'boss', description: 'Опубликовать пост (только для начальника)' },
      ],
    }),
  });
  const commandsData = await commandsRes.json() as { ok: boolean; description?: string };
  if (!commandsData.ok) {
    console.error('setMyCommands failed:', commandsData.description);
    process.exit(1);
  }
  console.log('✅ Commands registered');

  // 3. Verify webhook info
  const infoRes = await fetch(`${apiBase}/getWebhookInfo`);
  const info = await infoRes.json() as { result: { url: string; has_custom_certificate: boolean; pending_update_count: number } };
  console.log('\n=== Webhook Info ===');
  console.log(`URL: ${info.result.url}`);
  console.log(`Pending updates: ${info.result.pending_update_count}`);
  console.log('===================\n');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script to package.json**

In `package.json`, add to the `scripts` block:

```json
"setup:boss-webhook": "npx tsx scripts/setup-boss-webhook.ts"
```

The full `scripts` block becomes:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "setup:managed": "npx tsx scripts/setup-managed-agent.ts",
  "setup:boss-webhook": "npx tsx scripts/setup-boss-webhook.ts"
}
```

- [ ] **Step 3: Run tests to make sure nothing broke**

```bash
npm test
```

Expected: all tests PASS

- [ ] **Step 4: Deploy to Netlify**

Push to main branch and wait for Netlify to deploy the new background function.

```bash
git add netlify/functions/kesha-boss-background.mts
git status
```

Verify `kesha-boss-background.mts` is tracked. Then:

```bash
git push origin main
```

Wait for Netlify deploy to complete (check Netlify dashboard or wait ~1-2 min).

- [ ] **Step 5: Register the webhook**

Set env vars and run the setup script. Replace `<your-site>` with your actual Netlify site subdomain:

```bash
TELEGRAM_BOT_TOKEN=<token> NETLIFY_SITE_URL=https://<your-site>.netlify.app npm run setup:boss-webhook
```

Expected output:
```
Setting webhook to: https://<your-site>.netlify.app/.netlify/functions/kesha-boss-background
✅ Webhook set
Registering /boss command...
✅ Commands registered

=== Webhook Info ===
URL: https://<your-site>.netlify.app/.netlify/functions/kesha-boss-background
Pending updates: 0
===================
```

- [ ] **Step 6: Commit**

```bash
git add scripts/setup-boss-webhook.ts package.json
git commit -m "feat(boss): add webhook setup script and npm command"
```

---

## Task 8: End-to-end verification

No code changes. Manual test runs to verify acceptance criteria.

- [ ] **Step 1: Test READY branch**

Send to bot in Telegram:
```
/boss Сегодня вышел Claude 4 - Anthropic удивил всех. Модель значительно умнее, быстрее и дешевле предыдущих версий. Я уже попробовал - впечатляет 🐤 Подробнее: https://anthropic.com/claude-4
```

Expected:
- Bot replies `🔍 Ревьювлю...`
- Message edits to `✅ Текст норм, постить без переработки...`
- Message edits to `✅ Опубликовано: t.me/psyreq/<id>`
- Post appears in channel with text as-is (grammar corrected if needed)
- No rewrite, no preview dialog

- [ ] **Step 2: Test RAW branch**

Send to bot:
```
/boss Claude 4 released today. New model from Anthropic. Better performance. Lower cost. Available now.
```

Expected:
- Bot replies `🔍 Ревьювлю...`
- Message edits to `✍️ Текст сыроват, переписываю голосом Кеши...`
- Message edits to `👀 Готово. Превью выше, подтверди публикацию.`
- New preview message appears with ✅/❌ buttons
- Press ✅ → post appears in channel, preview message updates to `✅ Опубликовано: ...`

- [ ] **Step 3: Test cancel**

Repeat Step 2, then press ❌ → preview message shows `❌ Отменено.`, nothing published in channel.

- [ ] **Step 4: Test auth rejection**

From a different Telegram account (not user ID 352830345) send `/boss test`. Expected: `Извини, эта команда только для начальника 🐤`

- [ ] **Step 5: Test input too short**

Send `/boss Hi`. Expected: error message mentioning minimum 50 characters.

- [ ] **Step 6: Test input too long**

Send `/boss ` followed by 3501 characters. Expected: error message mentioning maximum 3500 characters.

- [ ] **Step 7: Test --raw flag**

Send a clearly ready, Kesha-style text with `--raw` prefix. Expected: rewrite runs anyway, preview appears.

- [ ] **Step 8: Test --skip flag**

Send a clearly raw/dry text with `--skip` prefix. Expected: publishes immediately without rewrite.

- [ ] **Step 9: Check Netlify logs**

In Netlify dashboard → Functions → kesha-boss-background → verify logs contain:
- `[boss-pipeline] verdict=...`
- `[boss-pipeline] branch=...`
- Full input text
- corrected_text

- [ ] **Step 10: Verify rewrite accuracy**

Run 5 tests on RAW-branch posts. Manually compare rewrite output to input. Verify Kesha did not add facts, opinions, or context not present in the input.

- [ ] **Step 11: Verify auto-verdict accuracy (economy check)**

Run `/boss` 5 times with texts already written in Kesha's voice. Verify rewrite triggered ≤ 1 time. If triggered 2+ times → tune the verdict criteria in `boss-review.txt`.
