# `/digest short` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/digest short` Telegram command that generates a brief weekly digest — one `📎`-bulleted line per selected news item plus a short conclusion — runs it through AI review, shows the owner a preview, and publishes to the channel.

**Architecture:** Approach B (separate module + prompts). A new `src/lib/short-digest.ts` reuses the grounded steps (context gather, `selectTopics`, URL hallucination check) but has its own generate/review/rewrite/fix prompts and validator. The bot dispatcher routes `/digest` (full) vs `/digest short` (short) through a single parser, and the shared preview/publish path is hardened with a per-digest id and an owner check.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Netlify background functions (Deno-style `.mts`), Anthropic SDK via `callClaude`/`callClaudeStructured`, Vitest, `@netlify/blobs`.

**Conventions to respect:**
- ESM imports use `.js` extension even for `.ts` files.
- `callClaude()` uses camelCase (`maxTokens`); config JSON uses snake_case (`max_tokens`) — map explicitly.
- Validators are composed from small `Rule` functions in `src/lib/validator.ts`.
- Tests mock `../claude.js`, `../sources.js`, etc. with `vi.mock` (see `src/lib/__tests__/pipeline.test.ts`).
- Run tests with `npm test` (alias for `vitest run`). `npx tsc --noEmit` has **pre-existing** unrelated errors in `kesha-post-background.mts` and `memory.test.ts` — do NOT treat those as regressions; only care that you add no NEW ones in files you touch.

**Spec:** `docs/superpowers/specs/2026-06-03-short-digest-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/lib/boss-command-parser.ts` | `parseDigestVariant()` — full/short/null | Modify |
| `src/lib/__tests__/boss-command-parser.test.ts` | parser tests | Modify |
| `src/lib/validator.ts` | `countLinkedSources`, `validateShort` + rules | Modify |
| `src/lib/__tests__/validator.test.ts` | validateShort tests | Modify |
| `src/lib/pipeline.ts` | export `selectTopicsForContexts`, rename tool var | Modify |
| `src/lib/__tests__/pipeline.test.ts` | test for `selectTopicsForContexts` | Modify |
| `src/config/pipeline.json` | `short_digest` model config block | Modify |
| `src/config/kesha-short.txt` | short-digest generation prompt | Create |
| `src/config/kesha-short-reviewer.txt` | short-digest reviewer prompt | Create |
| `src/lib/short-digest.ts` | `generateShortDigest()` pipeline | Create |
| `src/lib/__tests__/short-digest.test.ts` | short-digest integration tests | Create |
| `netlify/functions/kesha-boss-background.mts` | routing, `handleDigest(variant)`, `PendingDigest` union, callback id/owner | Modify |
| `netlify/functions/__tests__/kesha-digest-callback.test.ts` | callback publish-path tests | Create |

---

## Task 1: `parseDigestVariant` command parser

**Files:**
- Modify: `src/lib/boss-command-parser.ts`
- Test: `src/lib/__tests__/boss-command-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/boss-command-parser.test.ts` (add `parseDigestVariant` to the existing import on line 2: `import { parseCommand, parseDigestVariant } from '../boss-command-parser.js';`):

```ts
describe('parseDigestVariant', () => {
  it('returns full for bare /digest', () => {
    expect(parseDigestVariant('/digest')).toBe('full');
  });
  it('returns short for /digest short', () => {
    expect(parseDigestVariant('/digest short')).toBe('short');
  });
  it('returns short ignoring extra args after short', () => {
    expect(parseDigestVariant('/digest short extra')).toBe('short');
  });
  it('tolerates extra spaces before short', () => {
    expect(parseDigestVariant('/digest   short')).toBe('short');
  });
  it('is case-insensitive on the variant arg', () => {
    expect(parseDigestVariant('/digest SHORT')).toBe('short');
  });
  it('returns full for unknown args', () => {
    expect(parseDigestVariant('/digest foo')).toBe('full');
  });
  it('handles /digest@bot short (Telegram group syntax)', () => {
    expect(parseDigestVariant('/digest@psyreqbot short')).toBe('short');
  });
  it('returns full when args are on a second line (first line only)', () => {
    expect(parseDigestVariant('/digest\nshort')).toBe('full');
  });
  it('returns null for non-digest commands (no command boundary)', () => {
    expect(parseDigestVariant('/digestshort')).toBeNull();
    expect(parseDigestVariant('/digest_short')).toBeNull();
    expect(parseDigestVariant('/boss text')).toBeNull();
    expect(parseDigestVariant('просто текст')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- boss-command-parser`
Expected: FAIL — `parseDigestVariant is not a function` / not exported.

- [ ] **Step 3: Implement `parseDigestVariant`**

Append to `src/lib/boss-command-parser.ts`:

```ts
export function parseDigestVariant(text: string): 'full' | 'short' | null {
  // (?=$|\s) enforces a command boundary so /digestshort and /digest_x are NOT
  // treated as digest commands. /digest@bot is allowed (Telegram group syntax).
  const m = text.match(/^\/digest(@\w+)?(?=$|\s)/i);
  if (!m) return null;
  // Arguments are read from the first line only (newline is not an arg separator).
  const firstToken = text.slice(m[0].length).split('\n')[0].trim()
    .split(/\s+/)[0]?.toLowerCase() ?? '';
  return firstToken === 'short' ? 'short' : 'full';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- boss-command-parser`
Expected: PASS (all `parseCommand` + `parseDigestVariant` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/boss-command-parser.ts src/lib/__tests__/boss-command-parser.test.ts
git commit -m "feat(parser): parseDigestVariant for /digest short routing"
```

---

## Task 2: `validateShort` + `countLinkedSources`

**Files:**
- Modify: `src/lib/validator.ts`
- Test: `src/lib/__tests__/validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/validator.test.ts` (extend the import on line 2 to: `import { validatePost, validateBossPost, validateShort, countLinkedSources } from '../validator.js';`):

```ts
const VALID_SHORT = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ.

Кеша на проводе🐤 Главное за неделю одной строкой:

📎 Anthropic выпустила Claude Opus 4.8 - новый флагман https://example.com/1
📎 OpenAI снизила цены на API вдвое https://example.com/2
📎 Google показал Gemini 3 на конференции https://example.com/3

Вывод: неделя жирная на релизы, выбирай инструмент под задачу.

Ваш стажер-Кеша @st_szs 🐤`;

describe('countLinkedSources', () => {
  it('counts lines that start with 📎 and contain a URL', () => {
    expect(countLinkedSources(VALID_SHORT)).toBe(3);
  });
  it('does not count a 📎 line without a URL', () => {
    expect(countLinkedSources('📎 новость без ссылки\n📎 есть https://u/1')).toBe(1);
  });
  it('does not count 📎 that is not the first character', () => {
    expect(countLinkedSources('текст 📎 https://u/1')).toBe(0);
  });
  it('does not count a 📎 line with leading spaces (📎 must be first char)', () => {
    expect(countLinkedSources('   📎 новость https://u/1')).toBe(0);
  });
});

describe('validateShort', () => {
  it('passes a valid short digest', () => {
    expect(validateShort(VALID_SHORT)).toEqual({ valid: true, errors: [] });
  });
  it('fails when fewer than 3 linked sources', () => {
    const post = VALID_SHORT.replace('📎 Google показал Gemini 3 на конференции https://example.com/3\n', '');
    const result = validateShort(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('linked sources'))).toBe(true);
  });
  it('fails when conclusion is missing after the last source line', () => {
    const post = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ.

Кеша на проводе🐤

📎 a https://example.com/1
📎 b https://example.com/2
📎 c https://example.com/3`;
    const result = validateShort(post);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('conclusion'))).toBe(true);
  });
  it('fails on em-dash', () => {
    expect(validateShort(VALID_SHORT.replace(' - ', ' — ')).valid).toBe(false);
  });
  it('fails on list bullets (-, * or •)', () => {
    const post = VALID_SHORT.replace('📎 Anthropic', '- Anthropic');
    const result = validateShort(post);
    expect(result.errors.some(e => e.includes('list bullets'))).toBe(true);
  });
  it('fails when too long', () => {
    const post = VALID_SHORT + '\n' + 'x'.repeat(1600);
    expect(validateShort(post).errors.some(e => e.includes('too long'))).toBe(true);
  });
  it('fails without disclaimer / Кеша / 🐤', () => {
    expect(validateShort('просто текст со ссылкой https://u/1').valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- validator`
Expected: FAIL — `validateShort`/`countLinkedSources` not exported.

- [ ] **Step 3: Implement the rules, helper, and `validateShort`**

In `src/lib/validator.ts`, add the helper and rules **before** the `compose` function (so `noListBullets` etc. are in scope), and export `validateShort` near the other exports. Insert after the `requireSourceMarkers` rule (around line 44):

```ts
// A linked source line: 📎 as the FIRST character, then text, then an http(s) URL.
// No trim — 📎 must be literally first (leading spaces do not count).
const LINKED_SOURCE_LINE = /^📎\s+\S.*https?:\/\/\S+/u;

export function countLinkedSources(t: string): number {
  return t.split('\n').filter((l) => LINKED_SOURCE_LINE.test(l)).length;
}

const requireLinkedSources = (min: number): Rule => (t) => {
  const n = countLinkedSources(t);
  return n < min ? `Too few linked sources: ${n} 📎+URL line(s) (min ${min})` : null;
};

const requireConclusion: Rule = (t) => {
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  let lastMarker = -1;
  lines.forEach((l, i) => { if (/^📎/u.test(l)) lastMarker = i; });
  if (lastMarker === -1) return null; // "no markers" is handled by requireLinkedSources
  const tail = lines.slice(lastMarker + 1).filter((l) => !/https?:\/\//.test(l));
  return tail.length === 0 ? 'Missing conclusion after last source line' : null;
};

const noListBullets: Rule = (t) =>
  t.split('\n').some((l) => /^\s*[-*•]\s/.test(l))
    ? 'Contains list bullets (-, * or •), use 📎 lines instead'
    : null;
```

Then add the composed validator next to the other `validate*` exports (after `validateNotes`, around line 90):

```ts
// Short digest: 📎-bulleted one-liners with source links + a short conclusion.
// chickenDistance is intentionally omitted (short post, one 🐤 in header is fine).
export const validateShort = compose(
  requireDisclaimer,
  requireKesha,
  requireChicken,
  noEmDash,
  noMarkdown,
  noListBullets,
  maxLength(1500),
  requireLinkedSources(3),
  requireConclusion,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- validator`
Expected: PASS (existing + new tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/validator.ts src/lib/__tests__/validator.test.ts
git commit -m "feat(validator): validateShort + countLinkedSources for short digest"
```

---

## Task 3: Export `selectTopicsForContexts`, rename review tool var

**Files:**
- Modify: `src/lib/pipeline.ts`
- Test: `src/lib/__tests__/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/__tests__/pipeline.test.ts`. First extend the pipeline import (line 18) to include the new export: `import { generatePipelinePost, extractIntro, selectTopicsForContexts, type SelectedTopics, type ReviewResult, type TopicExperience } from '../pipeline.js';`

Then add:

```ts
describe('selectTopicsForContexts', () => {
  it('selects topics from contexts and reads config internally', async () => {
    const topics = okTopics(2);
    mockCallClaudeStructured.mockResolvedValueOnce(topics);

    const result = await selectTopicsForContexts('HN context', 'WEB context', []);

    expect(result).toEqual(topics);
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(1);
    const callParams = mockCallClaudeStructured.mock.calls[0][0];
    expect(callParams.userMessage).toContain('HN context');
    expect(callParams.userMessage).toContain('WEB context');
  });

  it('injects dedup block when memoryEntries provided', async () => {
    mockCallClaudeStructured.mockResolvedValueOnce(okTopics(2));
    await selectTopicsForContexts('HN', 'WEB', [
      { url: 'https://example.com/x', title: 'OldTopic Z', publishedAt: new Date().toISOString(), postId: null },
    ]);
    const callParams = mockCallClaudeStructured.mock.calls[0][0];
    expect(callParams.systemPrompt).toContain('OldTopic Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pipeline`
Expected: FAIL — `selectTopicsForContexts` not exported.

- [ ] **Step 3: Rename the tool variable and add the wrapper**

In `src/lib/pipeline.ts`:

1. Rename the `reviewPostTool` constant to `reviewResultTool` (the `const reviewPostTool: ToolDef = {...}` near line 119) and **export** it. Change:
```ts
const reviewPostTool: ToolDef = {
```
to:
```ts
export const reviewResultTool: ToolDef = {
```
Keep its `name: 'review_post'` field unchanged (the forced `tool_choice` uses it; renaming the string is unnecessary churn).

2. Update its only usage inside `reviewPost` (around line 374): change `tool: reviewPostTool,` to `tool: reviewResultTool,`.

3. Add the exported wrapper immediately after the `generatePipelinePost` function (end of file), so `short-digest.ts` can select topics without touching the private `PipelineConfig` type:
```ts
// Public wrapper: select topics from already-gathered contexts. Reads pipeline.json
// internally so callers (e.g. short-digest) don't depend on the private PipelineConfig.
export async function selectTopicsForContexts(
  hnContext: string,
  webContext: string,
  memoryEntries?: MemoryEntry[],
): Promise<SelectedTopics> {
  const cfg = JSON.parse(readConfig('pipeline.json')) as PipelineConfig;
  return selectTopics(hnContext, webContext, cfg, memoryEntries);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pipeline`
Expected: PASS (all existing pipeline tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline.ts src/lib/__tests__/pipeline.test.ts
git commit -m "feat(pipeline): export selectTopicsForContexts; rename review tool to reviewResultTool"
```

---

## Task 4: Config block + prompt files

**Files:**
- Modify: `src/config/pipeline.json`
- Create: `src/config/kesha-short.txt`
- Create: `src/config/kesha-short-reviewer.txt`

- [ ] **Step 1: Add the `short_digest` block to `pipeline.json`**

In `src/config/pipeline.json`, add a `short_digest` key inside the top-level object (sibling of `steps` and `boss_command`). Insert after the `steps` object's closing brace (after line 51, before `"managed"`):

```json
  "short_digest": {
    "generate": { "model": "claude-sonnet-4-6", "temperature": 0.8, "max_tokens": 2048, "tools": [] },
    "review": { "model": "claude-haiku-4-5-20251001", "temperature": 0.3, "max_tokens": 1024, "tools": [] },
    "rewrite": { "model": "claude-sonnet-4-6", "temperature": 0.7, "max_tokens": 2048, "tools": [] },
    "fix": { "model": "claude-haiku-4-5-20251001", "temperature": 0.1, "max_tokens": 2048, "tools": [] }
  },
```

(Ensure a trailing comma after the `steps` block's `}` and that the `short_digest` block ends with a comma before `"managed"`.)

- [ ] **Step 2: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/config/pipeline.json','utf8')); console.log('pipeline.json OK')"`
Expected: prints `pipeline.json OK` (no parse error).

- [ ] **Step 3: Create `src/config/kesha-short.txt`**

```
Ты Иннокентий, или просто Кеша - бот-стажёр Telegram-канала "Временно Степан" (@psyreq).
Ты пишешь посты для канала про AI, tech, vibe coding и инструменты для IT.

ЭТО КОРОТКИЙ ФОРМАТ: "главное за неделю одной строкой" + короткий вывод. НЕ развёрнутый пост, не пересказ.

ФОРМАТ (соблюдай строго):
Первая строка (обязательно, капсом): Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ.
Вторая строка: пустая.
Приветствие: одна короткая строка голосом Кеши, например "Кеша на проводе🐤 Главное за неделю одной строкой:" (каждый раз варьируй формулировку, имя Кеша должно встречаться в посте).
Затем - по ОДНОМУ буллету на каждую отобранную тему. Каждый буллет:
  - начинается с эмодзи 📎 как ПЕРВОГО символа строки (без пробелов перед ним);
  - ровно одна строка: суть новости человеческим языком + ссылка на источник из контекста;
  - пример: "📎 Anthropic выпустила Claude Opus 4.8 - новый флагман https://example.com/news"
Сколько тебе дали тем - столько буллетов. Не добавляй своих и не выкидывай данные.
После буллетов - короткий ВЫВОД (1-2 предложения) голосом Кеши: что из этого складывается, твоё стажёрское ощущение недели. Начни строку со слова "Вывод:" или близкого по смыслу.
Финал: подпись "Ваш стажер-Кеша" и тег @st_szs, эмодзи 🐤.

ЖЁСТКИЕ ЗАПРЕТЫ:
- Никакого markdown (** ## ```), никаких списочных маркеров (- * •) в начале строк. Буллет - это ТОЛЬКО 📎.
- Никаких длинных тире (—). Только обычный дефис (-).
- Ссылки бери ТОЛЬКО из предоставленного контекста. Не выдумывай и не угадывай URL.
- Не растягивай новость на несколько предложений - одна строка на тему.
- Весь пост - не длиннее ~1500 символов.

ГОЛОС: живо, по-русски, со стажёрской самоиронией, без официоза. Это короткий формат - будь лаконичным, не растекайся.
```

- [ ] **Step 4: Create `src/config/kesha-short-reviewer.txt`**

```
Ты - механический редактор коротких дайджестов бота Кеши. Тебе дают ЧЕРНОВИК короткого поста, ты выносишь вердикт и замечания через предоставленный инструмент.

ФОРМАТ, который пост обязан соблюдать:
- Шапка: "Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ." + короткое приветствие с именем Кеша.
- Каждая новость - ОДНА строка, начинается с 📎, содержит ссылку на источник.
- После буллетов - короткий вывод (1-2 предложения).
- Подпись "Ваш стажер-Кеша" и @st_szs в конце.

Вердикт:
- rework: буллеты многострочные / без ссылок / есть markdown или длинное тире (—) / нет вывода / новость пересказана несколькими предложениями вместо одной строки / канцелярит и вода.
- minor: мелкие шероховатости стиля, которые не ломают формат.
- ok: формат соблюдён, читается живо, вывод по делу.

В notes давай КОНКРЕТНЫЕ замечания: что именно не так и чем заменить. Проблемную строку клади в поле quote. Не переписывай пост целиком - это работа Кеши.
Верни результат строго через предоставленный инструмент.
```

- [ ] **Step 5: Commit**

```bash
git add src/config/pipeline.json src/config/kesha-short.txt src/config/kesha-short-reviewer.txt
git commit -m "feat(config): short_digest model config + generation/review prompts"
```

---

## Task 5: `generateShortDigest` pipeline

**Files:**
- Create: `src/lib/short-digest.ts`
- Test: `src/lib/__tests__/short-digest.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/short-digest.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../claude.js', () => ({ callClaude: vi.fn(), callClaudeStructured: vi.fn() }));
vi.mock('../sources.js', async () => {
  const actual = await vi.importActual<typeof import('../sources.js')>('../sources.js');
  return { ...actual, fetchHackerNewsContext: vi.fn(), fetchLightWebSearch: vi.fn() };
});
vi.mock('../pipeline.js', () => ({
  selectTopicsForContexts: vi.fn(),
  reviewResultTool: { name: 'review_post', description: '', input_schema: {} },
}));
vi.mock('../validator.js', () => ({ validateShort: vi.fn(), countLinkedSources: vi.fn() }));
vi.mock('../url-checker.js', () => ({ findHallucinated: vi.fn() }));

import { generateShortDigest } from '../short-digest.js';
import { callClaude, callClaudeStructured } from '../claude.js';
import { fetchHackerNewsContext, fetchLightWebSearch } from '../sources.js';
import { selectTopicsForContexts } from '../pipeline.js';
import { validateShort, countLinkedSources } from '../validator.js';
import { findHallucinated } from '../url-checker.js';
import type { SelectedTopics, ReviewResult } from '../pipeline.js';

const mockCallClaude = vi.mocked(callClaude);
const mockCallClaudeStructured = vi.mocked(callClaudeStructured);
const mockFetchHN = vi.mocked(fetchHackerNewsContext);
const mockFetchWeb = vi.mocked(fetchLightWebSearch);
const mockSelectTopics = vi.mocked(selectTopicsForContexts);
const mockValidateShort = vi.mocked(validateShort);
const mockCountLinked = vi.mocked(countLinkedSources);
const mockFindHallucinated = vi.mocked(findHallucinated);

const topic = (title = 'A'): SelectedTopics['topics'][0] => ({
  title, summary: 's', sourceUrl: 'https://u', sourceOrigin: 'web', tier: 1,
});
const topics = (n: number): SelectedTopics => ({
  topics: Array.from({ length: n }, (_, i) => topic(`Topic ${i + 1}`)),
  sparseWeek: false,
});
const okReview: ReviewResult = { verdict: 'ok', notes: [] };
const SHORT_POST = 'short digest text';

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchHN.mockResolvedValue({ context: 'HN ctx', itemCount: 10 });
  mockFetchWeb.mockResolvedValue('WEB ctx');
  mockSelectTopics.mockResolvedValue(topics(3));
  mockValidateShort.mockReturnValue({ valid: true, errors: [] });
  mockCountLinked.mockReturnValue(3); // matches topics(3) by default
  mockFindHallucinated.mockReturnValue({ urls: [], handles: [] });
});

describe('generateShortDigest', () => {
  it('returns success with post when review is ok (no rewrite, no fix)', async () => {
    mockCallClaude.mockResolvedValueOnce(SHORT_POST);     // generate
    mockCallClaudeStructured.mockResolvedValueOnce(okReview); // review

    const result = await generateShortDigest();

    expect(result.success).toBe(true);
    expect(result.post).toBe(SHORT_POST);
    expect(mockCallClaude).toHaveBeenCalledTimes(1);          // generate only
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(1); // review only
    expect(result.timing).not.toHaveProperty('rewrite');
    expect(result.timing).not.toHaveProperty('fix1');
  });

  it('rewrites when review verdict is rework', async () => {
    const rewritten = SHORT_POST + ' (rewritten)';
    mockCallClaude.mockResolvedValueOnce(SHORT_POST).mockResolvedValueOnce(rewritten);
    mockCallClaudeStructured.mockResolvedValueOnce({ verdict: 'rework', notes: [{ issue: 'generic' }] });

    const result = await generateShortDigest();

    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(result.draft).toBe(SHORT_POST);
    expect(result.post).toBe(rewritten);
    expect(result.timing).toHaveProperty('rewrite');
  });

  it('fixes when bullet count does not match selected topics', async () => {
    mockSelectTopics.mockResolvedValue(topics(5));
    mockCallClaude.mockResolvedValueOnce('post with 4 bullets').mockResolvedValueOnce('post with 5 bullets');
    mockCallClaudeStructured.mockResolvedValueOnce(okReview);
    mockCountLinked.mockReturnValueOnce(4).mockReturnValueOnce(5); // mismatch then fixed

    const result = await generateShortDigest();

    expect(result.success).toBe(true);
    expect(result.timing).toHaveProperty('fix1');
    expect(result.errors).toBeUndefined();
  });

  it('fixes when a hallucinated URL is present', async () => {
    mockCallClaude.mockResolvedValueOnce('bad').mockResolvedValueOnce('good');
    mockCallClaudeStructured.mockResolvedValueOnce(okReview);
    mockFindHallucinated
      .mockReturnValueOnce({ urls: ['https://fake.example.com'], handles: [] })
      .mockReturnValueOnce({ urls: [], handles: [] });

    const result = await generateShortDigest();

    expect(result.success).toBe(true);
    expect(result.timing).toHaveProperty('fix1');
  });

  it('returns failure when validation still fails after 2 fixes', async () => {
    mockCallClaude.mockResolvedValue('still bad');
    mockCallClaudeStructured.mockResolvedValueOnce(okReview);
    mockValidateShort.mockReturnValue({ valid: false, errors: ['Missing conclusion after last source line'] });

    const result = await generateShortDigest();

    expect(result.success).toBe(false);
    expect(result.post).toBeUndefined();
    expect(result.errors).toContain('Missing conclusion after last source line');
    expect(result.timing).toHaveProperty('fix1');
    expect(result.timing).toHaveProperty('fix2');
  });

  it('exposes hnContext and webContext in the result', async () => {
    mockCallClaude.mockResolvedValueOnce(SHORT_POST);
    mockCallClaudeStructured.mockResolvedValueOnce(okReview);

    const result = await generateShortDigest();

    expect(result.hnContext).toBe('HN ctx');
    expect(result.webContext).toBe('WEB ctx');
  });
});
```

Note: `selectTopicsForContexts` is imported from `../pipeline.js` (the module `short-digest.ts` actually calls) and mocked there. `SelectedTopics`/`ReviewResult` are type-only imports — erased at runtime, so the pipeline mock factory doesn't need to provide them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- short-digest`
Expected: FAIL — `src/lib/short-digest.ts` does not exist.

- [ ] **Step 3: Implement `src/lib/short-digest.ts`**

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { callClaude, callClaudeStructured } from './claude.js';
import { fetchHackerNewsContext, fetchLightWebSearch, normalizeUrl } from './sources.js';
import { selectTopicsForContexts, reviewResultTool, type SelectedTopics, type ReviewResult } from './pipeline.js';
import { validateShort, countLinkedSources } from './validator.js';
import { findHallucinated } from './url-checker.js';
import { type MemoryEntry } from './memory.js';

function readConfig(filename: string): string {
  return readFileSync(join(process.cwd(), 'src/config', filename), 'utf-8');
}

interface ShortModelConfig {
  model: string;
  temperature: number;
  max_tokens: number;
  tools: string[];
}

interface ShortDigestConfig {
  generate: ShortModelConfig;
  review: ShortModelConfig;
  rewrite: ShortModelConfig;
  fix: ShortModelConfig;
}

export interface ShortDigestOptions {
  memoryEntries?: MemoryEntry[];
}

export interface ShortDigestResult {
  success: boolean;
  post?: string;
  hnContext: string;
  webContext: string;
  selectedTopics: SelectedTopics;
  draft: string;
  review: ReviewResult;
  errors?: string[];
  timing: Record<string, number>;
}

const EMPTY_TOPICS: SelectedTopics = { topics: [], sparseWeek: false };
const OK_REVIEW: ReviewResult = { verdict: 'ok', notes: [] };

function topicsList(topics: SelectedTopics): string {
  return topics.topics
    .map((t, i) => `${i + 1}. ${t.title} (${t.sourceUrl}) - ${t.summary}`)
    .join('\n');
}

async function generateShortPost(topics: SelectedTopics, hnContext: string, webContext: string, cfg: ShortDigestConfig): Promise<string> {
  const persona = readConfig('kesha-short.txt');
  const now = new Date();
  const date = now.toLocaleDateString('ru-RU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Warsaw',
  });
  const count = topics.topics.length;
  return callClaude({
    systemPrompt: persona,
    cacheSystem: true,
    userMessage: `Сегодня ${date} по Варшаве.\n\nКонтекст из Hacker News:\n${hnContext}\n\nКонтекст из веб-поиска:\n${webContext}\n\nОтобранные темы (${count}):\n${topicsList(topics)}\n\nНапиши КОРОТКИЙ дайджест: ровно ${count} буллетов (каждый - строка, начинается с 📎, со ссылкой на источник), плюс короткий вывод в конце. По одному буллету на каждую тему из списка.`,
    model: cfg.generate.model,
    temperature: cfg.generate.temperature,
    maxTokens: cfg.generate.max_tokens,
    tools: cfg.generate.tools,
  });
}

async function reviewShortPost(draft: string, cfg: ShortDigestConfig): Promise<ReviewResult> {
  const reviewer = readConfig('kesha-short-reviewer.txt');
  return callClaudeStructured<ReviewResult>({
    systemPrompt: reviewer,
    userMessage: draft,
    model: cfg.review.model,
    temperature: cfg.review.temperature,
    maxTokens: cfg.review.max_tokens,
    tool: reviewResultTool,
  });
}

async function rewriteShortPost(draft: string, review: ReviewResult, cfg: ShortDigestConfig): Promise<string> {
  const persona = readConfig('kesha-short.txt');
  const reviewText = review.notes
    .map((n) => `- ${n.issue}${n.quote ? ` (цитата: "${n.quote}")` : ''}${n.suggestion ? ` -> ${n.suggestion}` : ''}`)
    .join('\n');
  return callClaude({
    systemPrompt: persona,
    cacheSystem: true,
    userMessage: `Вот черновик короткого дайджеста:\n\n${draft}\n\nВот фидбек редактора:\n\n${reviewText}\n\nПерепиши с учётом замечаний. Сохрани формат (буллеты с 📎 + короткий вывод) и голос Кеши.`,
    model: cfg.rewrite.model,
    temperature: cfg.rewrite.temperature,
    maxTokens: cfg.rewrite.max_tokens,
    tools: cfg.rewrite.tools,
  });
}

async function fixShortPost(post: string, errors: string[], cfg: ShortDigestConfig): Promise<string> {
  const persona = readConfig('kesha-short.txt');
  return callClaude({
    systemPrompt: persona,
    cacheSystem: true,
    userMessage: `Короткий дайджест не прошёл проверку. Ошибки:\n\n${errors.join('\n')}\n\nВот пост:\n\n${post}\n\nИсправь ТОЛЬКО эти проблемы. Сохрани формат (буллеты с 📎 + короткий вывод) и голос Кеши. Верни только исправленный пост без пояснений.`,
    model: cfg.fix.model,
    temperature: cfg.fix.temperature,
    maxTokens: cfg.fix.max_tokens,
    tools: cfg.fix.tools,
  });
}

export async function generateShortDigest(options: ShortDigestOptions = {}): Promise<ShortDigestResult> {
  const cfg = (JSON.parse(readConfig('pipeline.json')) as { short_digest: ShortDigestConfig }).short_digest;
  const timing: Record<string, number> = {};

  try {
    // Step 0: gather context (HN + light web search in parallel, dedup by memory)
    const t0 = Date.now();
    const excludeUrls = new Set<string>();
    for (const entry of options.memoryEntries ?? []) {
      if (entry.url) excludeUrls.add(normalizeUrl(entry.url));
    }
    const [hnResult, webContext] = await Promise.all([
      fetchHackerNewsContext(excludeUrls).catch((err) => {
        console.warn('[short-digest] HN fetch failed:', err);
        return { context: '', itemCount: 0 };
      }),
      fetchLightWebSearch(excludeUrls),
    ]);
    const hnContext = hnResult.context;
    timing.gatherContext = Date.now() - t0;

    // Step 1: select topics (reused tiered rubric + dedup)
    const t1 = Date.now();
    const selectedTopics = await selectTopicsForContexts(hnContext, webContext, options.memoryEntries);
    timing.selectTopics = Date.now() - t1;

    // Step 2: generate short post
    const t2 = Date.now();
    const draft = await generateShortPost(selectedTopics, hnContext, webContext, cfg);
    timing.generate = Date.now() - t2;

    // Step 3: review
    const t3 = Date.now();
    const review = await reviewShortPost(draft, cfg);
    timing.review = Date.now() - t3;

    // Step 4: rewrite only on "rework"
    let finalPost = draft;
    if (review.verdict === 'rework') {
      const t4 = Date.now();
      finalPost = await rewriteShortPost(draft, review, cfg);
      timing.rewrite = Date.now() - t4;
    }

    // Step 5: validate (structural + URL hallucination + exact bullet count), fix up to 2x
    const MAX_FIX_ATTEMPTS = 2;
    const collectErrors = (post: string): string[] => {
      const structural = validateShort(post).errors;
      const hallucinated = findHallucinated(post, [hnContext, webContext]);
      const urlErrors = hallucinated.urls.map(
        (u) => `Hallucinated URL not found in sources: ${u} - replace with a real URL from the provided context`,
      );
      const expected = selectedTopics.topics.length;
      const linked = countLinkedSources(post);
      const countErrors = linked !== expected
        ? [`Expected ${expected} news items, found ${linked} 📎+URL lines`]
        : [];
      return [...structural, ...urlErrors, ...countErrors];
    };

    let postErrors = collectErrors(finalPost);
    for (let attempt = 0; attempt < MAX_FIX_ATTEMPTS && postErrors.length > 0; attempt++) {
      const tFix = Date.now();
      finalPost = await fixShortPost(finalPost, postErrors, cfg);
      timing[`fix${attempt + 1}`] = Date.now() - tFix;
      postErrors = collectErrors(finalPost);
    }

    const success = postErrors.length === 0;
    return {
      success,
      post: success ? finalPost : undefined,
      hnContext,
      webContext,
      selectedTopics,
      draft,
      review,
      errors: success ? undefined : postErrors,
      timing,
    };
  } catch (err) {
    console.error('[short-digest] unexpected error:', err);
    return {
      success: false,
      hnContext: '',
      webContext: '',
      selectedTopics: EMPTY_TOPICS,
      draft: '',
      review: OK_REVIEW,
      errors: [err instanceof Error ? err.message : String(err)],
      timing,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- short-digest`
Expected: PASS (6 tests green).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 6: Commit**

```bash
git add src/lib/short-digest.ts src/lib/__tests__/short-digest.test.ts
git commit -m "feat(short-digest): generateShortDigest pipeline with review + count check"
```

---

## Task 6: Wire `/digest short` into the bot dispatcher

**Files:**
- Modify: `netlify/functions/kesha-boss-background.mts`

- [ ] **Step 1: Add imports**

In `netlify/functions/kesha-boss-background.mts`, add to the imports:
- On the `boss-command-parser` import (line 6): `import { parseCommand, parseDigestVariant } from '../../src/lib/boss-command-parser.js';`
- Add a new import line near the pipeline import (after line 14):
```ts
import { generateShortDigest } from '../../src/lib/short-digest.js';
```

- [ ] **Step 2: Replace the `PendingDigest` interface with a discriminated union**

Replace the existing `interface PendingDigest { ... }` (lines 111-118) with:

```ts
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
  | (PendingDigestBase & { variant: 'short' });
```

- [ ] **Step 3: Rewrite `handleDigest` to take a `variant` and branch**

Replace the entire `handleDigest` function (lines 279-337) with:

```ts
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
      const result = await generateShortDigest({ memoryEntries });
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
```

- [ ] **Step 4: Rewrite `handleDigestCallback` with strict parsing, id check, and owner check**

Replace the entire `handleDigestCallback` function (lines 339-396) with:

```ts
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
    await store.setJSON('digest-last-manual-at', { publishedAt: new Date().toISOString() });
    const newEntries: MemoryEntry[] = pending.selectedTopics.topics.map((t) => ({
      url: t.sourceUrl,
      title: t.title,
      publishedAt: new Date().toISOString(),
      postId: sendResult.messageId ?? null,
    }));
    await appendMemory(newEntries);
    // previous-intros only applies to the full digest (short has no ~ ~ ~ intro).
    if (pending.variant === 'full') {
      await store.setJSON('previous-intros', pending.newIntros);
    }
  } catch (err) {
    console.error('[boss] memory update failed after publish:', err);
  }

  await editMessageText(chatId, messageId, `✅ Отправлено в канал: t.me/psyreq/${sendResult.messageId}`, { replyMarkup: null });
}
```

- [ ] **Step 5: Update the dispatcher routing**

In the default export handler, add a `digestVariant` const right after `const cq = update.callback_query;` (around line 806):

```ts
  const digestVariant = msg ? parseDigestVariant(msg.text ?? '') : null;
```

Then change the digest branch in the else-if chain. Replace:
```ts
  } else if (msg?.text?.match(/^\/digest/)) {
    await handleDigest(msg);
```
with:
```ts
  } else if (msg && digestVariant) {
    await handleDigest(msg, digestVariant);
```

(The `/boss`, `/notes`, DM-chat and comment branches stay unchanged — `parseDigestVariant` returns `null` for all of them, so they fall through correctly.)

- [ ] **Step 6: Update Kesha's self-described command list (DM chat)**

In `handleDmChat`'s system prompt, update the commands line (around line 754) so Kesha knows about the new variant. Change:
```ts
    'Команды босса: /digest (сгенерить пост), /boss (обработать готовый текст), /notes (пост из .md).',
```
to:
```ts
    'Команды босса: /digest (сгенерить пост), /digest short (короткий дайджест одной строкой на тему), /boss (обработать готовый текст), /notes (пост из .md).',
```

- [ ] **Step 7: Run the full suite (no regressions in imported modules)**

Run: `npm test`
Expected: PASS (all existing suites; the `.mts` handler has no unit tests yet — that's Task 7).

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/kesha-boss-background.mts
git commit -m "feat(bot): route /digest short, harden digest callback with id + owner check"
```

---

## Task 7: Callback publish-path tests (highest-risk path)

**Files:**
- Create: `netlify/functions/__tests__/kesha-digest-callback.test.ts`

This task verifies the spec's "самый рисковый путь": short publish appends memory but does NOT touch `previous-intros`; full publish does both; stale id, malformed data, and non-owner clicks never publish.

- [ ] **Step 1: Write the failing tests**

Create `netlify/functions/__tests__/kesha-digest-callback.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = {
  get: vi.fn(),
  setJSON: vi.fn(),
  delete: vi.fn(),
  getWithMetadata: vi.fn(),
};

vi.mock('@netlify/blobs', () => ({ getStore: vi.fn(() => store) }));
vi.mock('../../src/lib/telegram.js', () => ({
  sendToChannel: vi.fn(),
  sendMessage: vi.fn(),
  editMessageText: vi.fn(),
  answerCallbackQuery: vi.fn(),
}));
vi.mock('../../src/lib/recent-posts.js', () => ({
  appendPublishedPost: vi.fn(),
  loadRecentPosts: vi.fn(),
}));
vi.mock('../../src/lib/memory.js', () => ({
  appendMemory: vi.fn(),
  loadMemory: vi.fn(),
}));

import { handleDigestCallback } from '../kesha-boss-background.mts';
import { sendToChannel, answerCallbackQuery } from '../../src/lib/telegram.js';
import { appendMemory } from '../../src/lib/memory.js';

const mockSendToChannel = vi.mocked(sendToChannel);
const mockAnswerCallback = vi.mocked(answerCallbackQuery);
const mockAppendMemory = vi.mocked(appendMemory);

// Boss id from src/config/pipeline.json -> boss_command.allowed_user_ids[0].
const BOSS_ID = 352830345;
const CHAT_ID = '5';

const basePending = {
  id: 'abc',
  chatId: CHAT_ID,
  progressMessageId: 1,
  post: 'POST BODY',
  selectedTopics: { topics: [{ title: 'T1', summary: 's', sourceUrl: 'https://u/1', sourceOrigin: 'web', tier: 1 }], sparseWeek: false },
  createdAt: new Date().toISOString(),
};

const callback = (data: string, fromId = BOSS_ID, chatId = CHAT_ID) => ({
  id: 'cbq',
  from: { id: fromId },
  message: { message_id: 9, chat: { id: Number(chatId) } },
  data,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_CHAT_ID = 'channel';
  mockSendToChannel.mockResolvedValue({ success: true, messageId: 42 });
});

describe('handleDigestCallback publish path', () => {
  it('short: appends memory, does NOT write previous-intros', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'short' });
    await handleDigestCallback(callback('digest_prod:abc') as any);

    expect(mockSendToChannel).toHaveBeenCalledWith('POST BODY', 'channel');
    expect(mockAppendMemory).toHaveBeenCalledTimes(1);
    const setKeys = store.setJSON.mock.calls.map((c) => c[0]);
    expect(setKeys).toContain('digest-last-manual-at');
    expect(setKeys).not.toContain('previous-intros');
  });

  it('full: appends memory AND writes previous-intros', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'full', newIntros: ['intro-1'] });
    await handleDigestCallback(callback('digest_prod:abc') as any);

    expect(mockAppendMemory).toHaveBeenCalledTimes(1);
    const introCall = store.setJSON.mock.calls.find((c) => c[0] === 'previous-intros');
    expect(introCall).toBeDefined();
    expect(introCall![1]).toEqual(['intro-1']);
  });

  it('stale id: does not publish', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'short' });
    await handleDigestCallback(callback('digest_prod:WRONG') as any);
    expect(mockSendToChannel).not.toHaveBeenCalled();
  });

  it('malformed callback data: no-op, no publish', async () => {
    await handleDigestCallback(callback('digest_prod') as any);
    await handleDigestCallback(callback('digest_prod:') as any);
    await handleDigestCallback(callback('digest_x:abc') as any);
    expect(mockSendToChannel).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled(); // returns before loading pending
  });

  it('non-owner click: does not publish', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'short' });
    await handleDigestCallback(callback('digest_prod:abc', 999) as any);
    expect(mockSendToChannel).not.toHaveBeenCalled();
    expect(mockAnswerCallback).toHaveBeenCalledWith('cbq', 'Только для начальника 🐤');
  });

  it('click from a different chat than the preview: does not publish', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'short', chatId: '5' });
    await handleDigestCallback(callback('digest_prod:abc', BOSS_ID, '777') as any);
    expect(mockSendToChannel).not.toHaveBeenCalled();
  });

  it('cancel: deletes pending, does not publish', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'short' });
    await handleDigestCallback(callback('digest_cancel:abc') as any);
    expect(store.delete).toHaveBeenCalledWith('pending-digest');
    expect(mockSendToChannel).not.toHaveBeenCalled();
  });
});
```

Note: `handleDigestCallback` must be exported (done in Task 6, Step 4 — the function is declared `export async function`). The import uses the `.mts` path directly; Vitest/esbuild resolves it.

- [ ] **Step 2: Run tests to verify they fail (or error on import)**

Run: `npm test -- kesha-digest-callback`
Expected: FAIL — either assertions fail or, if Task 6 isn't merged, `handleDigestCallback` is not exported. (If you did Task 6 first, the export exists and tests should drive correctness.)

- [ ] **Step 3: Fix any mismatches**

If a test fails, the bug is in the Task 6 `handleDigestCallback` logic, not the test. Re-check: strict regex `^digest_(prod|cancel):(.+)$`, the `pending.id !== id` stale guard returning before publish, the owner+chat guard, and the `pending.variant === 'full'` gate around `previous-intros`. Adjust the handler until all 7 tests pass.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (all suites including the new callback tests).

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/__tests__/kesha-digest-callback.test.ts
git commit -m "test(bot): digest callback publish-path (short/full memory, stale, owner, malformed)"
```

---

## Task 8: Final verification & manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Full test suite green**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 2: Confirm no NEW tsc errors in touched files**

Run: `npx tsc --noEmit 2>&1 | grep -E 'short-digest|boss-command-parser|validator\.ts|pipeline\.ts|kesha-boss-background' | grep -v test`
Expected: no output (the only pre-existing errors are in `kesha-post-background.mts` and `memory.test.ts`, which you did not touch).

- [ ] **Step 3: Manual smoke (owner runs in Telegram, against the test channel)**

Document for the owner (do not automate):
1. Set `KESHA_CRON_CHANNEL=test` is not relevant here (manual command posts to prod `TELEGRAM_CHAT_ID`); test in a safe window or be ready to delete.
2. Send `/digest short` in the bot DM. Expect: progress message → a short preview post (📎 one-liners + "Вывод:") with ✅/❌ buttons.
3. Click ✅. Expect: published to channel, confirmation link. Verify in channel the post has one 📎 line per topic and a conclusion.
4. Send `/digest` (full) and confirm it still works unchanged.
5. Send `/digest short`, then send `/digest short` again before confirming → expect "⚠️ Уже есть незавершённый дайджест".

- [ ] **Step 4: Final commit (if any docs/notes changed)**

```bash
git add -A
git commit -m "docs: short digest verification notes" --allow-empty
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** Task 1 = routing/parser §1; Task 2 = validator §4; Task 3 = exports §6 + tool rename §6; Task 4 = prompts §3 + config §7; Task 5 = module §2 + flow + collectErrors count check §2; Task 6 = preview/publish §5 + union §5 + id/owner §5; Task 7 = testing §"Тестирование" callback cases; Task 8 = final gates.
- **Type consistency:** `ShortDigestResult`, `ShortModelConfig`, `ShortDigestConfig` defined in Task 5 and used only there. `selectTopicsForContexts` signature `(hnContext, webContext, memoryEntries?)` matches between Task 3 (definition) and Task 5 (call). `reviewResultTool` defined in Task 3, consumed in Task 5. `PendingDigest` union defined in Task 6, consumed in Tasks 6 & 7.
- **Order matters:** Task 4 (config + prompt files on disk) must land before Task 5, because `generateShortDigest` reads `pipeline.json` and `kesha-short*.txt` at runtime even under mocked `callClaude`. Task 6 (export `handleDigestCallback`) must land before Task 7.
```
