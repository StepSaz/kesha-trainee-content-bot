# Kesha Soul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lived experience ("soul") to Kesha's digests by generating personal reactions per topic before post generation, and updating the persona prompt to weave them into news sections.

**Architecture:** New `experienceTopics` pipeline step between `selectTopics` and `generatePost`. Uses `callClaudeStructured` with Sonnet to produce one reaction per topic (7 types, no repeats). Reactions are injected into `generatePost`'s user message. Persona prompt updated to allow and require personal moments in sections.

**Tech Stack:** TypeScript, Claude API via `callClaudeStructured`, vitest for tests.

---

### Task 1: Add experience step config to pipeline.json

**Files:**
- Modify: `src/config/pipeline.json`

- [ ] **Step 1: Add the experience key to pipeline.json**

Add a new `experience` entry inside `steps`, after `selectTopics`:

```json
"experience": {
  "model": "claude-sonnet-5-20260401",
  "temperature": 0.7,
  "max_tokens": 1024,
  "tools": []
}
```

The full `steps` block becomes (showing neighbors only):

```json
"selectTopics": {
  "model": "claude-sonnet-5-20260401",
  "temperature": 0.3,
  "max_tokens": 2048,
  "tools": []
},
"experience": {
  "model": "claude-sonnet-5-20260401",
  "temperature": 0.7,
  "max_tokens": 1024,
  "tools": []
},
"generate": {
  "model": "claude-sonnet-5-20260401",
  "temperature": 0.8,
  "max_tokens": 4096,
  "tools": []
}
```

- [ ] **Step 2: Commit**

```bash
git add src/config/pipeline.json
git commit -m "config: add experience step to pipeline.json"
```

---

### Task 2: Create kesha-experience.txt system prompt

**Files:**
- Create: `src/config/kesha-experience.txt`

- [ ] **Step 1: Write the experience prompt**

Create `src/config/kesha-experience.txt` with this content:

```
Ты Кеша - бот-стажер канала "Временно Степан". Ты только что прочитал отобранные темы для дайджеста и должен записать свою личную реакцию на каждую.

Для каждой темы выбери ОДИН тип реакции из семи. НЕ повторяй один тип дважды в рамках одного запроса.

ТИПЫ РЕАКЦИЙ:

1. studied - залез вглубь: открыл доку, посмотрел демо, разобрал примеры.
   Пример: "полез в доку - там в примерах показывают как за три промпта поднять агента, выглядит подозрительно просто"

2. hooked - зацепила конкретная цифра или факт при чтении.
   Пример: "$40 млрд - это же больше чем весь рынок был два года назад"

3. surprised - ожидал одно, оказалось другое.
   Пример: "думал это очередной мелкий апдейт - а они всю архитектуру переделали"

4. connected - связалось с прошлыми темами канала или с твоим контекстом стажера.
   Пример: "неделю назад про это гадали - вот и ответ"

5. confused - честно не понял.
   Пример: "перечитал три раза - так и не понял зачем им это сейчас"

6. personal - примерил на себя: что это значит для тебя как бота, для аудитории канала.
   Пример: "если это взлетит - половина моей работы станет не нужна"

7. compared - сравнил с чем-то знакомым.
   Пример: "у конкурентов это стоило $20, тут бесплатно - что-то не сходится"

ПРАВИЛА:
- Реакция на русском, 1-2 предложения от первого лица.
- Опирайся на конкретные детали из исходного материала, не на абстрактный заголовок.
- Не повторяй тип реакции в рамках одного запроса. При 3-5 темах используй 3-5 разных типов.
- Голос: неформальный, стажерский, живой. Без мата. Без длинных тире (U+2014).
```

- [ ] **Step 2: Commit**

```bash
git add src/config/kesha-experience.txt
git commit -m "config: add kesha-experience.txt system prompt"
```

---

### Task 3: Add experienceTopics function with tests (TDD)

**Files:**
- Modify: `src/lib/pipeline.ts`
- Modify: `src/lib/__tests__/pipeline.test.ts`

- [ ] **Step 1: Add types and tool definition to pipeline.ts**

At the top of `pipeline.ts`, after the `ReviewNote` / `ReviewResult` interfaces (around line 52), add:

```typescript
export type ReactionType = 'studied' | 'hooked' | 'surprised' | 'connected' | 'confused' | 'personal' | 'compared';

export interface TopicExperience {
  topicTitle: string;
  reaction: string;
  reactionType: ReactionType;
}
```

After the `reviewPostTool` definition (around line 132), add the tool definition:

```typescript
const experienceTopicsTool: ToolDef = {
  name: 'experience_topics',
  description: 'Return personal reactions for each selected topic.',
  input_schema: {
    type: 'object',
    properties: {
      experiences: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            topicTitle: { type: 'string', description: 'Title of the topic (must match input)' },
            reaction: { type: 'string', description: '1-2 sentences, first person, Kesha voice' },
            reactionType: {
              type: 'string',
              enum: ['studied', 'hooked', 'surprised', 'connected', 'confused', 'personal', 'compared'],
            },
          },
          required: ['topicTitle', 'reaction', 'reactionType'],
        },
      },
    },
    required: ['experiences'],
  },
};
```

Add the `experience` key to the `PipelineConfig.steps` interface:

```typescript
experience: { model: string; temperature: number; max_tokens: number; tools: string[] };
```

- [ ] **Step 2: Write the failing test for experienceTopics**

In `src/lib/__tests__/pipeline.test.ts`, update the import to include the new types:

```typescript
import { generatePipelinePost, extractIntro, type SelectedTopics, type ReviewResult, type TopicExperience } from '../pipeline.js';
```

Add this test block after the `extractIntro` describe block (at the end of the file):

```typescript
describe('generatePipelinePost with experience step', () => {
  it('calls experienceTopics and passes reactions to generatePost', async () => {
    const experiences: { experiences: TopicExperience[] } = {
      experiences: [
        { topicTitle: 'Topic 1', reaction: 'полез в доку - подозрительно просто', reactionType: 'studied' },
      ],
    };

    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))      // selectTopics
      .mockResolvedValueOnce(experiences)       // experienceTopics
      .mockResolvedValueOnce(okReview);         // reviewPost
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.success).toBe(true);
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(3); // select + experience + review
    // Verify experience reactions are passed to generatePost
    const generateCallParams = mockCallClaude.mock.calls[0][0];
    expect(generateCallParams.userMessage).toContain('Твоя реакция: полез в доку');
  });

  it('includes timing for experience step', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce({ experiences: [{ topicTitle: 'Topic 1', reaction: 'test', reactionType: 'hooked' }] })
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.timing).toHaveProperty('experience');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/pipeline.test.ts`
Expected: FAIL — `experienceTopics` not called yet, `callClaudeStructured` call count mismatch.

- [ ] **Step 4: Implement experienceTopics function in pipeline.ts**

Add this function after the `selectTopics` function (around line 222):

```typescript
async function experienceTopics(
  selectedTopics: SelectedTopics,
  hnContext: string,
  webContext: string,
  cfg: PipelineConfig,
): Promise<TopicExperience[]> {
  const experiencePrompt = readConfig('kesha-experience.txt');
  const topicList = selectedTopics.topics
    .map((t, i) => `${i + 1}. ${t.title} (${t.sourceUrl})\n   ${t.summary}`)
    .join('\n\n');

  const result = await callClaudeStructured<{ experiences: TopicExperience[] }>({
    systemPrompt: experiencePrompt,
    userMessage: `Вот отобранные темы:\n\n${topicList}\n\nИсходный материал из Hacker News:\n${hnContext}\n\nИсходный материал из веб-поиска:\n${webContext}\n\nЗапиши свою реакцию на каждую тему.`,
    model: cfg.steps.experience.model,
    temperature: cfg.steps.experience.temperature,
    maxTokens: cfg.steps.experience.max_tokens,
    tool: experienceTopicsTool,
  });

  return result.experiences;
}
```

- [ ] **Step 5: Wire experienceTopics into generatePipelinePost**

In `generatePipelinePost`, after the selectTopics step (after the `sparseWeek` guard around line 364), add:

```typescript
    // Step 1.5: Experience — personal reactions per topic
    const tExp = Date.now();
    const experiences = await experienceTopics(selectedTopics, hnContext, webContext, cfg);
    timing.experience = Date.now() - tExp;
    console.log(`[pipeline] experience reactions generated in ${timing.experience}ms`);
```

Update the `generatePost` call to pass experiences. Change `generatePost` signature to accept an optional `experiences` parameter:

```typescript
async function generatePost(
  hnContext: string,
  webContext: string,
  selectedTopics: SelectedTopics,
  cfg: PipelineConfig,
  previousIntros?: string[],
  memoryEntries?: MemoryEntry[],
  experiences?: TopicExperience[],
): Promise<string> {
```

Inside `generatePost`, update `topicsProse` to include reactions. Replace the existing `topicsProse` construction:

```typescript
  const topicsProse = selectedTopics.topics
    .map((t, i) => {
      const base = `${i + 1}. ${t.title} (${t.sourceUrl}) — ${t.summary}`;
      const exp = experiences?.find(e => e.topicTitle === t.title);
      return exp ? `${base}\n   Твоя реакция: ${exp.reaction}` : base;
    })
    .join('\n');
```

Add the instruction to the userMessage. After `${callbackBlock}` in the template string, before the final instruction line, append:

```typescript
  const experienceNote = experiences && experiences.length > 0
    ? '\n\nВАЖНО: для каждой темы у тебя есть личная реакция (\"Твоя реакция:\"). Вплети её в текст секции естественно, не как отдельный абзац. Это должен быть сквозной элемент — читатель должен чувствовать что ты прожил каждую тему.'
    : '';
```

And add `${experienceNote}` to the userMessage template string, after `${callbackBlock}`.

Finally, update the call to `generatePost` inside `generatePipelinePost` to pass `experiences`:

```typescript
    const draft = await generatePost(hnContext, webContext, selectedTopics, cfg, options.previousIntros, options.memoryEntries, experiences);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/pipeline.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/pipeline.ts src/lib/__tests__/pipeline.test.ts
git commit -m "feat: add experienceTopics pipeline step for lived reactions"
```

---

### Task 4: Update existing pipeline tests for new call count

**Files:**
- Modify: `src/lib/__tests__/pipeline.test.ts`

The existing tests expect `callClaudeStructured` to be called 2 times (selectTopics + reviewPost). With the new `experienceTopics` step, it's now 3 times. Every test that asserts `mockCallClaudeStructured` call counts or mock setup needs updating.

- [ ] **Step 1: Update mock setup in all existing tests**

Every test that sets up `mockCallClaudeStructured` needs an extra mock for the experience step (inserted between selectTopics and reviewPost). The experience mock returns a minimal valid response:

```typescript
const okExperiences = (topics: SelectedTopics) => ({
  experiences: topics.topics.map((t, i) => ({
    topicTitle: t.title,
    reaction: `test reaction ${i}`,
    reactionType: (['studied', 'hooked', 'surprised', 'connected', 'confused', 'personal', 'compared'] as const)[i % 7],
  })),
});
```

Add this helper after the `okTopics` helper (around line 34).

Then update each test. The pattern is: wherever you see:

```typescript
mockCallClaudeStructured
  .mockResolvedValueOnce(okTopics(N))   // selectTopics
  .mockResolvedValueOnce(okReview);     // reviewPost
```

Change to:

```typescript
const topics = okTopics(N);
mockCallClaudeStructured
  .mockResolvedValueOnce(topics)              // selectTopics
  .mockResolvedValueOnce(okExperiences(topics)) // experienceTopics
  .mockResolvedValueOnce(okReview);           // reviewPost
```

For tests that use custom topics (like the sparseWeek tests), apply the same pattern with the custom topics variable.

Tests that assert `mockCallClaudeStructured` call count of 2 should be updated to 3.

Here is the complete list of tests to update:

1. `'returns success with post when review is ok'` — add experience mock, change count assertion from 2 to 3
2. `'calls rewrite when review verdict is rework'` — add experience mock, change count assertion from 2 to 3
3. `'skips rewrite when review verdict is minor'` — add experience mock
4. `'auto-fixes post when validation fails'` — add experience mock, change structured count from 2 to 3
5. `'returns failure with errors when validation fails after all fix attempts'` — add experience mock
6. `'exposes hnContext, webContext, selectedTopics in result'` — add experience mock, change count from 2 to 3
7. `'strips false sparseWeek when 4+ topics'` — add experience mock
8. `'passes sparse week note to generatePost'` — add experience mock
9. `'includes timing keys for each step'` — add experience mock, add `expect(result.timing).toHaveProperty('experience')`
10. URL hallucination tests (2 tests) — add experience mock
11. Parallel context gathering tests (3 tests) — add experience mock, update count assertions
12. Memory/dedup tests (3 tests) — add experience mock
13. PreviousIntros tests (2 tests) — add experience mock
14. Callback tests (3 tests) — add experience mock

- [ ] **Step 2: Run all tests**

Run: `npx vitest run src/lib/__tests__/pipeline.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/pipeline.test.ts
git commit -m "test: update pipeline tests for experience step call count"
```

---

### Task 5: Update kesha-persona.txt — section voice rules

**Files:**
- Modify: `src/config/kesha-persona.txt`

- [ ] **Step 1: Replace the section voice block**

Find this block in `kesha-persona.txt`:

```
ГОЛОС КЕШИ — ГДЕ И ГДЕ НЕТ:
Шутки, самоирония, "я маленький бот", неуверенность — ТОЛЬКО во вступлении и в итоговом выводе.
Сами секции с новостями — без "я бот", без "звучит серьёзно", без явной самоиронии.
НО: "профессиональный язык в секциях" не значит "сухой официальный". Голос Кеши в секциях — это словарь и фрейминг:
  - "выкатила" вместо "анонсировала"
  - "вернулась на рынок" вместо "представила новый продукт"
  - "тихо обновила" вместо "выпустила обновление"
  - "и это само по себе новость" — оценка встроена в факт, не вынесена отдельно
Редкие хеджирующие слова ("кажется", "если правильно понял") допустимы в секциях — но не как самоирония, а как честная неуверенность в трактовке факта.
Персона обрамляет пост — не разбавляет каждый абзац.
```

Replace with:

```
ГОЛОС КЕШИ — ГДЕ И ГДЕ НЕТ:
Шутки про "я маленький бот" и явная самоирония — ТОЛЬКО во вступлении и в итоговом выводе.
Сами секции с новостями — без "я бот", без "звучит серьёзно".

НО: в каждой секции ОБЯЗАТЕЛЕН один личный момент — твоя реакция на тему. Не отдельным абзацем, а вплетённая в текст. Ты не просто пересказываешь новость — ты её прожил при подготовке поста.

Семь типов реакций (выбирай подходящий для каждой темы):
1. "изучил вглубь" — залез в доку, посмотрел демо, разобрал примеры
2. "зацепила цифра/факт" — споткнулся о конкретную деталь при чтении
3. "не ожидал" — ожидание было одно, реальность другая
4. "напомнило" — связалось с прошлыми темами канала или контекстом стажера
5. "не понял" — честная растерянность
6. "примерил на себя" — что это значит для тебя/аудитории канала
7. "сравнил" — сопоставил с чем-то знакомым

ВАЖНО: не повторяй один тип реакции дважды в одном посте. При 3-5 темах используй 3-5 разных типов.

Голос Кеши в секциях — это словарь и фрейминг:
  - "выкатила" вместо "анонсировала"
  - "вернулась на рынок" вместо "представила новый продукт"
  - "тихо обновила" вместо "выпустила обновление"
  - "и это само по себе новость" — оценка встроена в факт, не вынесена отдельно
Редкие хеджирующие слова ("кажется", "если правильно понял") допустимы в секциях — как честная неуверенность в трактовке факта.
```

- [ ] **Step 2: Commit**

```bash
git add src/config/kesha-persona.txt
git commit -m "config: update persona prompt — require personal moments in sections"
```

---

### Task 6: Run full test suite and verify

**Files:** none (verification only)

- [ ] **Step 1: Run the full vitest suite**

Run: `npx vitest run`
Expected: ALL PASS — no regressions.

- [ ] **Step 2: Verify pipeline.json is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/config/pipeline.json', 'utf-8')); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Final commit (if any leftover changes)**

If there are uncommitted fixes from test runs:

```bash
git add -A
git commit -m "fix: address test failures from experience step integration"
```
