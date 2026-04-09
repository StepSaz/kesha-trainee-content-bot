# Topic Scoring & Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit rubric to `selectTopics` so important ecosystem events always appear and overly technical content is filtered out, with graceful sparse-week handling.

**Architecture:** Rubric embedded directly in the `selectTopics` system prompt (no new files or pipeline steps). `SPARSE_WEEK` string appended to output when fewer than 3 qualifying topics are found — detected by `generatePost` to write a 2-topic post with an in-character remark. Validator minimum lowered from 3 to 2 to allow sparse-week posts to pass.

**Tech Stack:** TypeScript, Vitest, existing `callClaude` abstraction

---

### Task 1: Lower validator minimum from 3 to 2

**Files:**
- Modify: `src/lib/validator.ts:37-39`
- Modify: `src/lib/__tests__/validator.test.ts`

- [ ] **Step 1: Write the failing test for min=2 boundary**

Add two tests to `src/lib/__tests__/validator.test.ts` — one verifying that exactly 2 sources passes, and one verifying that 1 source still fails. Add them after the existing `'passes with exactly 3 news items'` test:

```typescript
it('passes with exactly 2 news items (sparse week)', () => {
  const post = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ. 🐤\n\nКеша тут🐤\n\nНовость 1.\n📎 источник: https://example.com/1\n\n~ ~ ~\n\nНовость 2.\n📎 источник: https://example.com/2\n\nВаш стажер-Кеша @st_szs 🐤`;
  expect(validatePost(post).errors.some(e => e.includes('Too few news items'))).toBe(false);
});

it('fails with only 1 news item', () => {
  const post = `Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ. 🐤\n\nКеша тут🐤\n\nНовость 1.\n📎 источник: https://example.com/1\n\nВаш стажер-Кеша @st_szs 🐤`;
  const result = validatePost(post);
  expect(result.valid).toBe(false);
  expect(result.errors.some(e => e.includes('Too few news items'))).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && npx vitest run src/lib/__tests__/validator.test.ts
```

Expected: `passes with exactly 2 news items (sparse week)` FAILS — because the current threshold is 3.

- [ ] **Step 3: Update the existing "fails with fewer than 3 news items" test**

The old test name says "fewer than 3" but after this change the threshold is 2. Rename and adjust to test 1 source (which still fails):

In `src/lib/__tests__/validator.test.ts`, change:

```typescript
it('fails with fewer than 3 news items', () => {
  const post = VALID_POST.replace(/📎 источник: https:\/\/example\.com\/3\n\n~ ~ ~\n\n/, '');
  const result = validatePost(post);
  expect(result.valid).toBe(false);
  expect(result.errors.some(e => e.includes('Too few news items'))).toBe(true);
});
```

to:

```typescript
it('fails with fewer than 2 news items', () => {
  const post = VALID_POST
    .replace(/📎 источник: https:\/\/example\.com\/3\n\n~ ~ ~\n\n/, '')
    .replace(/📎 источник: https:\/\/example\.com\/2\n\n~ ~ ~\n\n/, '');
  const result = validatePost(post);
  expect(result.valid).toBe(false);
  expect(result.errors.some(e => e.includes('Too few news items'))).toBe(true);
});
```

Also update the "passes with exactly 3" test name to "passes with exactly 3 news items" — it stays correct since 3 ≥ 2 (no change needed to that test body).

- [ ] **Step 4: Update the validator threshold**

In `src/lib/validator.ts`, change lines 37-39:

```typescript
  const sourceCount = (text.match(/📎/g) ?? []).length;
  if (sourceCount < 2) {
    errors.push(`Too few news items: ${sourceCount} source(s) found (min 2 required)`);
  }
```

- [ ] **Step 5: Run all validator tests and verify they pass**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && npx vitest run src/lib/__tests__/validator.test.ts
```

Expected: all 15 tests pass (13 original + 2 new).

- [ ] **Step 6: Commit**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && git add src/lib/validator.ts src/lib/__tests__/validator.test.ts && git commit -m "feat: lower validator min sources from 3 to 2 for sparse week support"
```

---

### Task 2: Add scoring rubric and SPARSE_WEEK signal to selectTopics

**Files:**
- Modify: `src/lib/pipeline.ts:56-65` (the `selectTopics` function)

- [ ] **Step 1: Replace the selectTopics system prompt and user message**

In `src/lib/pipeline.ts`, replace the entire `selectTopics` function body:

```typescript
async function selectTopics(rssContext: string, webContext: string, cfg: PipelineConfig): Promise<string> {
  const systemPrompt = `You are a content curator for a Russian-language Telegram channel about AI and tech. Audience: IT analysts, product managers, and a broad tech audience. Practical impact and ecosystem significance matter more than technical depth.

INCLUDE (high priority):
- Major product launches — new models (GPT-5, Claude 4), GA releases, major versions with user-facing changes
- Ecosystem milestones — install/user milestones, ownership changes (MCP → Linux Foundation), acquisitions, large partnerships
- New tools that change daily workflows for analysts, PMs, or developers
- Strategic moves by major AI companies — funding rounds, pivots, open-sourcing
- Widely discussed events — trending across tech media, HN, Twitter/X

SKIP (low priority):
- ML research without direct user impact — KV-cache optimizations, quantization methods, architectural improvements
- Arxiv preprints and academic papers, even from major labs
- Minor version bumps, patches, changelogs
- Narrow benchmarks without a practical "so what"
- Technical RFCs and internal standards

If fewer than 3 topics qualify under the rubric above, select the best available (minimum 2) and append SPARSE_WEEK on a new line at the very end of your response.`;

  const userMessage = `Here is this week's content:\n\nRSS feed:\n${rssContext}\n\nWeb search findings:\n${webContext}\n\nSelect 3-5 topics using the rubric. For each: topic name, source URL, and why it's interesting for IT analysts/PMs (1-2 sentences in Russian). If qualifying topics are fewer than 3, select the best 2 and append SPARSE_WEEK at the end.`;

  return callClaude({
    systemPrompt,
    userMessage,
    model: cfg.steps.selectTopics.model,
    temperature: cfg.steps.selectTopics.temperature,
    maxTokens: cfg.steps.selectTopics.max_tokens,
    tools: cfg.steps.selectTopics.tools,
  });
}
```

- [ ] **Step 2: Verify pipeline still compiles**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && git add src/lib/pipeline.ts && git commit -m "feat: add topic scoring rubric and SPARSE_WEEK signal to selectTopics"
```

---

### Task 3: Handle SPARSE_WEEK in generatePost

**Files:**
- Modify: `src/lib/pipeline.ts:67-86` (the `generatePost` function)
- Modify: `src/lib/__tests__/pipeline.test.ts`

- [ ] **Step 1: Write the failing pipeline test for SPARSE_WEEK**

Add this test to the `generatePipelinePost` describe block in `src/lib/__tests__/pipeline.test.ts`:

```typescript
it('passes SPARSE_WEEK hint to generatePost when selectTopics includes it', async () => {
  const sparseTopics = 'Topic 1\nTopic 2\nSPARSE_WEEK';
  mockCallClaude
    .mockResolvedValueOnce('web context')          // fetchWebContext
    .mockResolvedValueOnce(sparseTopics)            // selectTopics
    .mockResolvedValueOnce(VALID_POST)              // generatePost
    .mockResolvedValueOnce('хорошо');              // reviewPost

  await generatePipelinePost();

  // The third callClaude call is generatePost — check its userMessage argument
  const generateCall = mockCallClaude.mock.calls[2];
  const userMessage = generateCall[0].userMessage as string;
  expect(userMessage).toContain('SPARSE_WEEK');
  expect(userMessage).toContain('2 темы');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && npx vitest run src/lib/__tests__/pipeline.test.ts
```

Expected: the new SPARSE_WEEK test FAILS.

- [ ] **Step 3: Update generatePost to handle SPARSE_WEEK**

In `src/lib/pipeline.ts`, update the `generatePost` function:

```typescript
async function generatePost(
  rssContext: string,
  webContext: string,
  selectedTopics: string,
  cfg: PipelineConfig
): Promise<string> {
  const persona = readConfig('kesha-persona.txt');
  const date = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const isSparseWeek = selectedTopics.includes('SPARSE_WEEK');
  const sparseNote = isSparseWeek
    ? '\n\nВНИМАНИЕ: эта неделя скудная — найдено только 2 темы (SPARSE_WEEK). Напиши пост на 2 темы и добавь естественную реплику от Кеши о том, что на этой неделе негусто, например: «Честно, на этой неделе негусто — нашёл только два повода написать».'
    : '';

  return callClaude({
    systemPrompt: persona,
    userMessage: `Сегодня ${date}.\n\nКонтекст из RSS:\n${rssContext}\n\nКонтекст из веб-поиска:\n${webContext}\n\nОтобранные темы:\n${selectedTopics}${sparseNote}\n\nНапиши пост для Telegram-канала @psyreq в своём стиле.`,
    model: cfg.steps.generate.model,
    temperature: cfg.steps.generate.temperature,
    maxTokens: cfg.steps.generate.max_tokens,
    tools: cfg.steps.generate.tools,
  });
}
```

- [ ] **Step 4: Run all pipeline tests and verify they pass**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && npx vitest run src/lib/__tests__/pipeline.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Run the full test suite**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && git add src/lib/pipeline.ts src/lib/__tests__/pipeline.test.ts && git commit -m "feat: handle SPARSE_WEEK in generatePost for sparse week remark"
```

---

### Task 4: Push and verify

- [ ] **Step 1: Push to main**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && git push
```

- [ ] **Step 2: Confirm Netlify deploy triggered**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && git log --oneline -4
```

Expected: 3 new commits visible (validator, selectTopics, generatePost+tests).

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered |
|---|---|
| Replace generic selectTopics system prompt with rubric | Task 2 |
| INCLUDE list (major launches, ecosystem milestones, tools, strategic moves, trending) | Task 2 |
| SKIP list (ML research, arxiv, minor bumps, narrow benchmarks, RFCs) | Task 2 |
| Append SPARSE_WEEK when fewer than 3 qualifying topics | Task 2 |
| generatePost detects SPARSE_WEEK and adds in-character remark | Task 3 |
| Validator min 📎 lowered from 3 to 2 | Task 1 |
| validator.test.ts updated for new min | Task 1 |
| pipeline.test.ts SPARSE_WEEK test added | Task 3 |

**Placeholder scan:** No TBDs, all code blocks are complete.

**Type consistency:** `selectedTopics: string` used consistently across all call sites. No new types introduced.
