# Roadmap Execution Plan — handoff for Sonnet

> **Audience.** Claude Sonnet, picking up the roadmap in a fresh session.
> **Source of truth for scope:** `TODO.md` at repo root.
> **Source of truth for execution:** this doc.

---

## Context (where we are)

- **Branch:** `claude/digest-bot-improvements-UYx7Z` — develop here, push here. PR #4 already exists.
- **Commit progress:** M1 step 1 of 9 done — `callClaudeStructured` added to `src/lib/claude.ts` (commit `6c29ff7`). 8 sub-steps of M1 remain. Nothing yet uses the new helper.
- **Roadmap:** 9 items in `TODO.md`, grouped into 5 milestones (see below). Items already in dependency order — don't re-litigate.

## Working conventions

- **Tests:** `npm test` (vitest). Must pass before committing.
- **TypeScript build:** there's no separate build step — Netlify functions import `.js` extensions but TS compiles at deploy. If you change types, just make sure tests pass.
- **Commit style:** Conventional commits (`feat:`, `refactor:`, `docs:`, `fix:`). Body explains the *why*. Always end with the `https://claude.ai/code/session_...` line via HEREDOC.
- **Push policy:** push to `claude/digest-bot-improvements-UYx7Z` after each meaningful unit of work. PR #4 updates automatically.
- **Branch hooks:** stop-hook checks for uncommitted/unpushed changes. Don't accumulate uncommitted work across sessions.
- **Don't litter the repo with new docs.** This plan doc is the only execution-level doc — extend it, don't duplicate it.

## Milestone overview

| M | What | Items | Status |
|---|---|---|---|
| M1 | Foundations: structured output + composable validator | #1 | step 1/9 done |
| M2 | Production credibility | #2, #3 | not started |
| M3 | Telegram interactive surface | #9 v1, #6 base, #8 | not started |
| M4 | Channel memory | #4, #5 | not started |
| M5 | Learning loop | #7 v1 | not started |

Order is `M1 → M2 → M3 → M4 → M5`. Pause for user check-in between milestones.

---

## M1 — Foundations (in progress)

**Goal.** Replace prose parsing in pipeline with typed JSON via tool-use. Refactor validator into composable rules so per-mode validators (weekly/boss/stream) share common rules.

**Decisions already made:**
1. Use Anthropic tool-use with `tool_choice: { type: 'tool', name: '...' }` to force JSON. The `callClaudeStructured<T>` helper in `claude.ts` handles this — already merged.
2. Storage of `published-topics` blob stays as `string[]` for M1. M4 will migrate the schema to entity-level. Add a `formatSelectedTopics(t: SelectedTopics): string` helper for backward-compat serialization.
3. `validatePost` and `validateBossPost` stay exported as aliases (`= validateWeekly`, `= validateBoss`) so existing callers don't break.
4. `kesha-reviewer.txt` — only the final "ФОРМАТ ОТВЕТА" block changes. The 11-point checklist stays as-is.
5. `chickenDistance` rule threshold = **500 chars**. Real posts run 1500-3500 chars between greeting 🐤 and signature 🐤, so 500 is comfortably permissive.
6. No runtime JSON-schema validation (no zod). Cast `block.input as T`. If model breaks schema, the pipeline's existing retry covers it.

**Test fixture problem to fix:** `VALID_POST` in `validator.test.ts` and `pipeline.test.ts` has 🐤 on disclaimer line (`Не бейте. 🐤`) AND on greeting line (`Кеша на проводе🐤`) — distance ~30 chars, will fail the new `chickenDistance(500)` rule. Fix: remove 🐤 from disclaimer line; lengthen the body so greeting→signature 🐤 are ≥500 chars apart.

### M1 step-by-step

#### Step 2 — `validator.ts` composable refactor

Replace whole file with:

```ts
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type Rule = (text: string) => string | null;

const noEmDash: Rule = (t) =>
  t.includes('—') ? 'Contains em-dash (—), use hyphen instead' : null;

const noMarkdown: Rule = (t) =>
  /\*\*|##|```/.test(t) ? 'Contains markdown formatting (**, ##, ```)' : null;

const maxLength = (limit: number): Rule => (t) =>
  t.length > limit ? `Post too long: ${t.length} chars (max ${limit})` : null;

const chickenDistance = (minChars: number): Rule => (t) => {
  const idx: number[] = [];
  let i = -1;
  while ((i = t.indexOf('🐤', i + 1)) !== -1) idx.push(i);
  for (let k = 1; k < idx.length; k++) {
    const gap = idx[k] - idx[k - 1];
    if (gap < minChars) return `Two 🐤 too close: ${gap} chars apart (min ${minChars})`;
  }
  return null;
};

const requireDisclaimer: Rule = (t) =>
  /БОТ|УЧУСЬ/.test(t) ? null : 'Missing bot disclaimer (БОТ or УЧУСЬ in caps)';

const requireKesha: Rule = (t) =>
  t.includes('Кеша') ? null : 'Missing "Кеша" in text';

const requireChicken: Rule = (t) =>
  t.includes('🐤') ? null : 'Missing 🐤 emoji';

const requireSourceMarkers = (min: number): Rule => (t) => {
  const count = (t.match(/📎/g) ?? []).length;
  return count < min
    ? `Too few news items: ${count} source(s) found (min ${min} required)`
    : null;
};

function compose(...rules: Rule[]): (text: string) => ValidationResult {
  return (text) => {
    const errors = rules
      .map((r) => r(text))
      .filter((e): e is string => e !== null);
    return { valid: errors.length === 0, errors };
  };
}

export const validateWeekly = compose(
  requireDisclaimer,
  requireKesha,
  requireChicken,
  noEmDash,
  noMarkdown,
  maxLength(4000),
  requireSourceMarkers(3),
  chickenDistance(500),
);

export const validateBoss = compose(
  noEmDash,
  noMarkdown,
  maxLength(4096),
);

export const validateStream = compose(
  requireDisclaimer,
  requireKesha,
  requireChicken,
  noEmDash,
  noMarkdown,
  maxLength(4000),
  chickenDistance(500),
);

// Backward-compat aliases — existing code keeps working.
export const validatePost = validateWeekly;
export const validateBossPost = validateBoss;
```

#### Step 3 — `selectTopics` → JSON via tool-use

In `pipeline.ts`:

1. Add types near top:
```ts
export interface SelectedTopic {
  title: string;
  summary: string;
  sourceUrl: string;
  sourceOrigin: 'hn' | 'web';
  tier: 1 | 2 | 3;
}
export interface SelectedTopics {
  topics: SelectedTopic[];
  sparseWeek: boolean;
}
```

2. Define tool:
```ts
const selectTopicsTool: ToolDef = {
  name: 'select_topics',
  description: 'Return the curated list of topics for the weekly digest.',
  input_schema: {
    type: 'object',
    properties: {
      topics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Краткое название темы' },
            summary: { type: 'string', description: '1-2 предложения почему интересно для аналитиков/PMs (на русском)' },
            sourceUrl: { type: 'string', description: 'URL источника или telegram handle с @' },
            sourceOrigin: { type: 'string', enum: ['hn', 'web'] },
            tier: { type: 'integer', enum: [1, 2, 3] },
          },
          required: ['title', 'summary', 'sourceUrl', 'sourceOrigin', 'tier'],
        },
      },
      sparseWeek: { type: 'boolean', description: 'true ONLY if exactly 3 topics' },
    },
    required: ['topics', 'sparseWeek'],
  },
};
```

3. Rewrite `selectTopics()` to use `callClaudeStructured<SelectedTopics>(...)`. Drop the prose-out user-message instructions ("Number each topic", "SPARSE_WEEK only if..."). The tool schema covers format.

4. Update prompt: in the existing `systemPrompt`, replace the SELECTION ALGORITHM steps 4-5 with: `Set sparseWeek=true if and only if you returned exactly 3 topics. Otherwise sparseWeek=false.`

5. The SPARSE_WEEK guard becomes:
```ts
if (result.topics.length >= 4 && result.sparseWeek) {
  console.log(`[pipeline] stripped false sparseWeek (found ${result.topics.length} topics)`);
  result.sparseWeek = false;
}
```

#### Step 4 — `reviewPost` → JSON, update `kesha-reviewer.txt`

In `pipeline.ts`:

```ts
export interface ReviewNote {
  issue: string;
  quote?: string;
  suggestion?: string;
}
export interface ReviewResult {
  verdict: 'ok' | 'minor' | 'rework';
  notes: ReviewNote[];
}

const reviewPostTool: ToolDef = {
  name: 'review_post',
  description: 'Return the mechanical review verdict for a Kesha post.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['ok', 'minor', 'rework'] },
      notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            issue: { type: 'string', description: 'Суть проблемы одной строкой' },
            quote: { type: 'string', description: 'Цитата из текста, если речь о конкретной фразе' },
            suggestion: { type: 'string', description: 'Что заменить и на что' },
          },
          required: ['issue'],
        },
      },
    },
    required: ['verdict', 'notes'],
  },
};
```

Rewrite `reviewPost()` with `callClaudeStructured<ReviewResult>`.

In `src/config/kesha-reviewer.txt`, replace the entire `ФОРМАТ ОТВЕТА:` block (last block of file) with:

```
ФОРМАТ ОТВЕТА:
Используй tool review_post.

verdict:
- "ok" — все механические проверки пройдены
- "minor" — есть мелкие замечания, но пост публикуемый
- "rework" — критический провал: нет подписи, нет дисклеймера, нет вступления, меньше 3 тем, сломанная логика вывода (пункт 9), или выдуманная реплика Степана (пункт 10)

Каждая запись в notes:
- issue (обязательно): суть проблемы одной строкой
- quote (опционально): цитата из текста, если речь о конкретной фразе
- suggestion (опционально): что заменить и на что, в формате "фраза X — замени на Y"

Если всё ok — notes может быть пустым массивом.
```

The 11-point checklist before this block stays unchanged.

In pipeline orchestration, change verdict check:
```ts
// before
if (reviewVerdict.startsWith('нужна переработка')) { ... }
// after
if (review.verdict === 'rework') { ... }
```

The two non-rework branches (`ok`, `minor`) skip rewrite — same as current behavior for "хорошо"/"нормально".

#### Step 5 — pipeline plumbing

1. Update `PipelineResult`:
```ts
selectedTopics: SelectedTopics;  // was string
review: ReviewResult;             // was string
```

2. Add helper:
```ts
export function formatSelectedTopics(t: SelectedTopics): string {
  const lines = t.topics
    .map((topic, i) =>
      `${i + 1}. ${topic.title}\n   источник: ${topic.sourceUrl}\n   ${topic.summary}`)
    .join('\n\n');
  return t.sparseWeek ? `${lines}\n\nSPARSE_WEEK` : lines;
}
```

3. Update `generatePost(...)` signature: accept `SelectedTopics` instead of `string`. Inside, build prose for the user message:
```ts
const topicsProse = selectedTopics.topics
  .map((t, i) => `${i + 1}. ${t.title} (${t.sourceUrl}) — ${t.summary}`)
  .join('\n');
const isSparseWeek = selectedTopics.sparseWeek;
const topicCount = selectedTopics.topics.length;
```

4. Error-path `selectedTopics` default in catch becomes `{ topics: [], sparseWeek: false }` instead of `''`. Same for `review` default: `{ verdict: 'ok', notes: [] }` (or whatever sentinel makes sense — caller checks `success` field anyway).

#### Step 6 — Netlify functions

`netlify/functions/kesha-post-background.mts`:
- Line 97 — `result.review.toLowerCase().startsWith('хорошо')` → `result.review.verdict === 'ok'` (NB: invert logic where used)
- Line 107 — wrap `pipelineResult.selectedTopics` with `formatSelectedTopics(...)` from pipeline import

`netlify/functions/kesha-test-background.mts`:
- Line 52 — same `verdict !== 'ok'` change
- Line 65 — `result.review.split('\n')[0].trim()` → `result.review.verdict`

`netlify/functions/kesha-result.mts`:
- `StoredResult.selectedTopics` becomes `SelectedTopics | undefined`
- `StoredResult.review` becomes `ReviewResult | undefined`
- Rendering: import `formatSelectedTopics` and use it for the topics section. For review, render verdict badge + notes as list:
  ```ts
  const reviewBody = result.review
    ? `verdict: ${result.review.verdict}\n\n` +
      result.review.notes.map(n => {
        const q = n.quote ? `\n  цитата: ${n.quote}` : '';
        const s = n.suggestion ? `\n  правка: ${n.suggestion}` : '';
        return `- ${n.issue}${q}${s}`;
      }).join('\n')
    : '(пусто)';
  ```

#### Step 7 — tests

`src/lib/__tests__/claude.test.ts`:
- Add describe block `callClaudeStructured`. Tests:
  - Returns `block.input` when matching `tool_use` block present
  - Throws "No tool_use block for X" when only text block returned
  - Passes `tools: [tool]` and `tool_choice: { type: 'tool', name }` to API
  - Forwards model/temperature/max_tokens

`src/lib/__tests__/validator.test.ts`:
- Update VALID_POST: drop 🐤 from disclaimer line, add ~500+ chars of news body so greeting 🐤 and signature 🐤 are far apart
- Add tests for `chickenDistance`:
  - Two 🐤 within 500 chars → fails with "too close" error
  - Single 🐤 → no chicken-distance error
  - Two 🐤 with 600+ chars between → no chicken-distance error
- All existing tests should pass with updated VALID_POST

`src/lib/__tests__/pipeline.test.ts`:
- Update mock: `vi.mock('../claude.js', () => ({ callClaude: vi.fn(), callClaudeStructured: vi.fn() }))`
- For `selectTopics` and `reviewPost` mock returns: structured objects, not strings
  ```ts
  mockCallClaudeStructured
    .mockResolvedValueOnce({ topics: [{ title: 'A', summary: 's', sourceUrl: 'u', sourceOrigin: 'hn', tier: 1 }, ...], sparseWeek: false } satisfies SelectedTopics)
    .mockResolvedValueOnce({ verdict: 'ok', notes: [] } satisfies ReviewResult);
  ```
- For `generatePost`/`rewritePost`/`fixPost`/`fetchWebContext` keep `callClaude` mock returning strings
- Update call-count expectations: previously selectTopics+generate+review = 3 `callClaude` calls; now 1 `callClaude` + 2 `callClaudeStructured`
- Update VALID_POST same as validator tests
- The `userMessage.toContain('SPARSE_WEEK')` assertion needs rethinking — `sparseWeek` is now a boolean field passed to generatePost, not a string in the user message. Easier assertion: check the system prompt or a marker the prompt contains for sparse weeks (e.g. the "ВНИМАНИЕ: эта неделя небогатая" copy)

#### Step 8 — run tests

```bash
npm test
```

Iterate on failures. Most likely class of failures:
- Tests assert on string fields that are now objects — update assertions
- `callClaude` mock count off-by-one — selectTopics moved to `callClaudeStructured`
- VALID_POST regex matches — body content changed

#### Step 9 — single commit covering steps 2-8

```
refactor(pipeline): structured output + composable validator (M1 #1)
```

Body should mention all sub-changes briefly. End with the session URL.

Push to `claude/digest-bot-improvements-UYx7Z`.

### M1 done = ready to start M2

Tell user: "M1 done. Зелёные тесты, PR #4 обновлён. Готов начинать M2?"

---

## M2 — Production credibility (#2 → #3)

**Goal.** Make weekly output trustworthy — no fabricated URLs, multiple primary sources, no SPOF on shir-man.

### #2 — URL anti-hallucination

- New `src/lib/url-checker.ts`:
  - `extractCitations(text: string): { urls: string[]; handles: string[] }` — regex extracts URLs and `@handle`s
  - `findHallucinated(post, contexts: string[]): { urls: string[]; handles: string[] }` — anything in post not in any context
- Pipeline adds new step after `generatePost` (and after rewrite if it ran): if hallucinated citations found, route to `fixPost` with a specific error message listing them. Reuse the existing fix loop infrastructure (max 2 attempts).
- Keep `validateWeekly` source-count rule unchanged — that's `requireSourceMarkers(3)`. URL hallucination is a separate check, not a validator rule (validator is text-only; URL check needs context).

Tests: unit tests for `extractCitations` and `findHallucinated`. Pipeline integration test: hallucinated URL → fixPost called with the error.

### #3 — Source diversity + caching

- Rename `hackernews.ts` → `sources.ts`
- New parallel fetchers: Anthropic blog RSS, OpenAI blog RSS, Google AI blog RSS, TechCrunch AI tag RSS. Use `Promise.allSettled` so single failure doesn't kill everything.
- Each fetcher has 8s timeout, retry once with exponential backoff
- Dedup by URL across all sources
- Cache result in Netlify Blob (`getStore('kesha').setJSON('source-cache', ...)`) with 1h TTL — read cache first, fetch on miss
- `priority_sources` in `sources.json` becomes the actual list of RSS URLs (not free-form names)
- `fallback_threshold` controls when to add web_search fallback (already exists, keep semantics)

Decision needed: parse RSS in TypeScript without a library, or add `rss-parser` dep. Probably add the dep — RSS parsing edge cases aren't worth re-implementing.

---

## M3 — Telegram interactive surface (#9 v1, #6 base, #8)

**Goal.** Single webhook endpoint for all incoming Telegram traffic from Stepan. DM menu replaces HTTP trigger. File upload feeds the stream pipeline.

### Architecture

- One new function: `netlify/functions/kesha-bot-webhook.mts`. Subscribes to `message`, `callback_query`, `document` updates via `setWebhook`.
- One new helper: `src/lib/bot-router.ts`:
  - `isStepan(update)` — auth check
  - `route(update)` — dispatches to `dm-menu`, `comment-handler`, `stream-handler` based on `chat.type` and content
- Existing `kesha-test-background.mts` stays for CI/diagnostics, no longer the user-facing trigger.

### Build order within M3

1. **Webhook plumbing first** — endpoint, `setWebhook` script, auth helper, ignore-everything-else default
2. **DM menu (#9 v1)** — `/start` command, inline keyboard with 4 buttons, button handlers (mostly stubs initially):
   - "Запустить дайджест" — triggers existing `generatePipelinePost`, sends to test channel
   - "Пост по тексту" — instructs reply-mode, hands off to existing boss-pipeline
   - "Пост по стриму" — placeholder until #8 lands; show "скоро"
   - "Статистика" — show subscriber count via `getChatMemberCount`, last 5 posts from blob
3. **Stream pipeline (#8)** — new `src/lib/stream-pipeline.ts`, new `src/config/kesha-stream-extract.txt`, plus minor persona overrides for stream format. Plug into menu's "Пост по стриму" button + raw `document` upload to bot.
4. **Comment handler base (#6 base)** — handle channel-discussion-group replies from Stepan. Small intent set: "расширь по теме X", "сравни с прошлым годом", "переведи проще". No editorial-rating yet (that's M5).

### Decisions to defer to M3 start

- Whether to use Telegram Mini App (web view inside Telegram) for stats v2, or stay with text reports
- Whether comment-handler responses post in the discussion group thread or in DM with Stepan
- Rate-limit policy

### M3 v2 stats — defer

`#9 v2` (per-post engagement, AI cost, etc.) requires M4 storage and optionally M5 reactions webhook. Don't build in M3.

---

## M4 — Channel memory (#4, #5)

**Goal.** Replace flat string-array dedup with normalized post + entity storage. Use it for callbacks.

### #4 — entity storage

- New `src/lib/memory.ts`:
  - `interface PostRecord { postId: string; telegramMessageId: number; publishedAt: string; topics: SelectedTopic[]; entities: string[]; postText: string; }`
  - `appendPost(record): Promise<void>`, `getRecentPosts(limit): Promise<PostRecord[]>`, `findByEntity(entity, sinceDate): Promise<PostRecord[]>`
  - Storage: Netlify Blob `kesha-posts` with single JSON array (pruned to last 50 posts)
- Entity extraction: small helper `extractEntities(topic: SelectedTopic): string[]` — basic NER on title (e.g., known company names from a list, capitalized brand-like tokens). Don't go ML — list-based extraction is enough for v1.
- Migration: on first read, if blob is empty, start fresh. Old `published-topics` blob stays separate, eventually deprecated.
- `selectTopics` change: accept recent `PostRecord[]`, build dedup signal — "URL уже публиковался X дней назад", "Anthropic Claude X.Y упоминался N недель назад".

### #5 — self-callbacks

- In `kesha-persona.txt`, add optional move "callback to N weeks ago" — short paragraph of guidance with one example, alongside existing optional moves (lines 67-71).
- In `generatePost`, surface a callback hint when an entity in current topics overlaps with an entity in `getRecentPosts(8 weeks back)`. Don't force — pass as "if relevant, you can reference X from N weeks ago when..."
- Keep this lightweight; the persona pattern does most of the work.

---

## M5 — Learning loop (#7 v1)

**Goal.** Stepan rates posts in DM/comments, ratings feed into next generation as style examples.

### Build steps

1. New intent in `bot-router` (built in M3): `rate <1-5> [optional note]` — when Stepan replies to a post in comments OR in DM with this command, store the rating in the corresponding `PostRecord` from M4.
2. `generatePost` change: before writing, fetch top-3 highest-rated and bottom-3 lowest-rated past posts from memory. Inject as style examples — but per-component (intro, sections, conclusion are separate units thanks to M1 structured topics). Don't conflate topic with style.
3. Cold start: feature disabled until at least 10 rated posts exist.

### v2 (audience metrics) — out of scope

Defer indefinitely. The original "Telegram metrics webhook" approach (in TODO.md) is technically possible but the editorial signal from Stepan is cleaner. Document v2 as available-if-needed in TODO; don't build.

---

## Cross-cutting reminders for Sonnet

- **Don't pre-build for future milestones.** If M2 doesn't need it, don't add the hook for M3.
- **Don't add libraries unless necessary.** Project uses minimal deps. RSS parsing in M2 is the one likely exception.
- **Tests must pass before commit.** No "I'll fix it later" pushes.
- **TODO.md is canonical scope.** This doc is canonical execution. If they conflict, scope wins — update execution.
- **Read `CLAUDE.md`** at session start. Project conventions matter.
- **Commit messages** end with the session URL via HEREDOC. Don't paraphrase the format.
- **Pause for user check-in** at end of each milestone. Don't chain M1 → M2 without user signal.
