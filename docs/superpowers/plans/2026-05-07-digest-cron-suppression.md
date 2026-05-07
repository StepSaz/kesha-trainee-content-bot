# Digest Cron Suppression — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** If Stepan publishes a manual `/digest` to prod, the next Thursday cron run skips automatically (within 7 days).

**Architecture:** Extract pure `shouldSuppressCron(publishedAt, nowMs)` helper to `src/lib/cron-guard.ts` so it can be unit-tested. On prod publish in `handleDigestCallback`, write blob `digest-last-manual-at: { publishedAt: ISO }`. At cron startup in `kesha-post-background.mts`, read that blob and return early if within 7 days. Also simplify the `/digest` keyboard — drop the 🧪 В тест button, always publish to prod.

**Tech Stack:** Node.js 22 + TypeScript ESM, Netlify Functions v2, `@netlify/blobs`, Vitest

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/cron-guard.ts` | **create** | Pure `shouldSuppressCron` helper |
| `src/lib/__tests__/cron-guard.test.ts` | **create** | Unit tests for the helper |
| `netlify/functions/kesha-boss-background.mts` | modify | Simplify keyboard; write suppression blob on prod publish |
| `netlify/functions/kesha-post-background.mts` | modify | Read blob at startup, skip cron if suppressed |

---

## Task 1: `src/lib/cron-guard.ts` + unit tests

**Files:**
- Create: `src/lib/cron-guard.ts`
- Create: `src/lib/__tests__/cron-guard.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `src/lib/__tests__/cron-guard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shouldSuppressCron } from '../cron-guard.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

describe('shouldSuppressCron', () => {
  it('returns false when publishedAt is null', () => {
    expect(shouldSuppressCron(null, now)).toBe(false);
  });

  it('returns true when published 1 day ago', () => {
    expect(shouldSuppressCron(new Date(now - DAY).toISOString(), now)).toBe(true);
  });

  it('returns true when published 6 days ago', () => {
    expect(shouldSuppressCron(new Date(now - 6 * DAY).toISOString(), now)).toBe(true);
  });

  it('returns false when published exactly 7 days ago', () => {
    expect(shouldSuppressCron(new Date(now - 7 * DAY).toISOString(), now)).toBe(false);
  });

  it('returns false when published 8 days ago', () => {
    expect(shouldSuppressCron(new Date(now - 8 * DAY).toISOString(), now)).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
npx vitest run src/lib/__tests__/cron-guard.test.ts
```

Expected: FAIL — "Cannot find module '../cron-guard.js'"

- [ ] **Step 1.3: Create `src/lib/cron-guard.ts`**

```typescript
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

export function shouldSuppressCron(publishedAt: string | null, nowMs: number): boolean {
  if (!publishedAt) return false;
  return nowMs - new Date(publishedAt).getTime() < SEVEN_DAYS;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
npx vitest run src/lib/__tests__/cron-guard.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 1.5: Run full suite to check for regressions**

```bash
npx vitest run
```

Expected: all tests pass (124 + 5 new = 129 total).

- [ ] **Step 1.6: Commit**

```bash
git add src/lib/cron-guard.ts src/lib/__tests__/cron-guard.test.ts
git commit -m "feat(digest): add shouldSuppressCron helper with tests"
```

---

## Task 2: Simplify `/digest` keyboard + write suppression blob

**Files:**
- Modify: `netlify/functions/kesha-boss-background.mts`

No new test file — background function integration code follows the existing untested pattern. Run `npx vitest run` after each edit to verify no regressions.

- [ ] **Step 2.1: Simplify the keyboard in `handleDigest`**

Find the keyboard block inside `handleDigest` (around line 281):

```typescript
    const keyboard: InlineKeyboard = {
      inline_keyboard: [[
        { text: '🧪 В тест', callback_data: 'digest_test' },
        { text: '📢 В прод', callback_data: 'digest_prod' },
        { text: '❌ Отмена', callback_data: 'digest_cancel' },
      ]],
    };

    await editMessageText(chatId, progressMessageId, '✅ Готово, пост ниже — выбери куда отправить:');
```

Replace with:

```typescript
    const keyboard: InlineKeyboard = {
      inline_keyboard: [[
        { text: '✅ Опубликовать', callback_data: 'digest_prod' },
        { text: '❌ Отмена', callback_data: 'digest_cancel' },
      ]],
    };

    await editMessageText(chatId, progressMessageId, '✅ Готово, пост ниже - подтверди публикацию:');
```

- [ ] **Step 2.2: Simplify `handleDigestCallback` — drop `digest_test` branch**

Find the targetChatId block in `handleDigestCallback` (around line 318):

```typescript
  let targetChatId: string;
  if (data === 'digest_test') targetChatId = process.env.TELEGRAM_TEST_CHAT_ID!;
  else if (data === 'digest_prod') targetChatId = process.env.TELEGRAM_CHAT_ID!;
  else {
    await answerCallbackQuery(callbackQueryId);
    return;
  }
```

Replace with:

```typescript
  if (data !== 'digest_prod') {
    await answerCallbackQuery(callbackQueryId);
    return;
  }
  const targetChatId = process.env.TELEGRAM_CHAT_ID!;
```

- [ ] **Step 2.3: Write suppression blob + fix label**

Find the block after `if (!sendResult.success)` check (around line 337):

```typescript
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
```

Replace with:

```typescript
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
```

- [ ] **Step 2.4: Run tests**

```bash
npx vitest run
```

Expected: 129 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add netlify/functions/kesha-boss-background.mts
git commit -m "feat(digest): simplify keyboard to prod-only, write suppression blob on publish"
```

---

## Task 3: Add cron skip logic to `kesha-post-background.mts`

**Files:**
- Modify: `netlify/functions/kesha-post-background.mts`

- [ ] **Step 3.1: Add `shouldSuppressCron` import**

Find the existing imports at the top of the file:

```typescript
import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { generatePipelinePost, extractIntro, type PipelineOptions, type PipelineResult } from '../../src/lib/pipeline.js';
import { loadMemory, appendMemory, type MemoryEntry } from '../../src/lib/memory.js';
import { generateManagedPost } from '../../src/lib/managed-agent.js';
import { sendToChannel } from '../../src/lib/telegram.js';
```

Replace with:

```typescript
import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { generatePipelinePost, extractIntro, type PipelineOptions, type PipelineResult } from '../../src/lib/pipeline.js';
import { loadMemory, appendMemory, type MemoryEntry } from '../../src/lib/memory.js';
import { generateManagedPost } from '../../src/lib/managed-agent.js';
import { sendToChannel } from '../../src/lib/telegram.js';
import { shouldSuppressCron } from '../../src/lib/cron-guard.js';
```

- [ ] **Step 3.2: Add suppression check after `const store = getStore('kesha')`**

Find this block (around line 23):

```typescript
  const store = getStore('kesha');
  await store.setJSON('latest-result', {
    status: 'running',
    startedAt: new Date().toISOString(),
    trigger: 'cron',
    mode,
    channel: cronChannel,
  });
```

Replace with:

```typescript
  const store = getStore('kesha');

  try {
    const lastManual = await store.get('digest-last-manual-at', { type: 'json' }) as { publishedAt: string } | null;
    if (shouldSuppressCron(lastManual?.publishedAt ?? null, Date.now())) {
      const ageH = Math.round((Date.now() - new Date(lastManual!.publishedAt).getTime()) / 3600000);
      console.log(`[kesha-post] skipping cron — manual digest published ${ageH}h ago`);
      return new Response('skipped (manual digest)', { status: 200 });
    }
  } catch (err) {
    console.error('[kesha-post] failed to read suppression blob, continuing:', err);
  }

  await store.setJSON('latest-result', {
    status: 'running',
    startedAt: new Date().toISOString(),
    trigger: 'cron',
    mode,
    channel: cronChannel,
  });
```

- [ ] **Step 3.3: Run tests**

```bash
npx vitest run
```

Expected: 129 tests pass.

- [ ] **Step 3.4: Commit**

```bash
git add netlify/functions/kesha-post-background.mts
git commit -m "feat(digest): skip cron if manual digest published within 7 days"
```

---

## Manual Testing

After deploy:

1. Run `/digest` in the bot, press ✅ Опубликовать — confirm the keyboard shows only two buttons.
2. Confirm post appears in the prod channel, confirmation message says "Отправлено в канал".
3. Check Netlify blob store (`kesha` store) — key `digest-last-manual-at` should exist with a recent `publishedAt`.
4. To verify cron suppression without waiting until Thursday: call the cron function directly via the manual HTTP trigger endpoint with `KESHA_ENABLED=true` set, check logs for `skipping cron — manual digest published Xh ago`.
5. To reset suppression (e.g. before a Thursday you want the cron to run): delete the `digest-last-manual-at` blob from Netlify blob explorer.
