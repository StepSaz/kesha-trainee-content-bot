# Light Web Search — Always-On Parallel Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `fetchLightWebSearch()` — 4 parallel Haiku web-search queries that always run alongside HN fetch — replacing the never-firing threshold-based fallback.

**Architecture:** Add config keys (`light_web_queries`, `gatherLightWeb`), implement `fetchLightWebSearch()` in `sources.ts`, then update `pipeline.ts` to run both fetches in `Promise.all` and remove the threshold logic.

**Tech Stack:** TypeScript ESM, Node.js 22, `@anthropic-ai/sdk` via `callClaude`, Vitest

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/config/sources.json` | modify | Add `light_web_queries` array |
| `src/config/pipeline.json` | modify | Add `gatherLightWeb` step config |
| `src/lib/sources.ts` | modify | Add `fetchLightWebSearch()` function |
| `src/lib/__tests__/sources.test.ts` | modify | Add 4 unit tests for `fetchLightWebSearch` |
| `src/lib/pipeline.ts` | modify | Parallel fetch, remove threshold fallback |
| `src/lib/__tests__/pipeline.test.ts` | modify | Update sources mock, fix stale comment |

---

## Task 1: Add config keys

**Files:**
- Modify: `src/config/sources.json`
- Modify: `src/config/pipeline.json`

No tests needed for config changes — these are static JSON files read by the functions under test.

- [ ] **Step 1.1: Add `light_web_queries` to `sources.json`**

Add after the `"search_queries"` array:

```json
  "light_web_queries": [
    "AI model release announcement {MONTH} {YEAR}",
    "AI developer tools coding assistant IDE news {MONTH} {YEAR}",
    "AI product launch business integration {MONTH} {YEAR}",
    "AI regulation safety policy news {MONTH} {YEAR}"
  ]
```

Full resulting file:

```json
{
  "hackernews_api": {
    "url": "https://shir-man.com/api/feed?sort=week",
    "max_items": 15,
    "fallback_threshold": 8,
    "keywords": [
      "AI", "LLM", "GPT", "Claude", "Anthropic", "OpenAI", "ChatGPT",
      "Gemini", "Google DeepMind", "Meta AI", "Llama", "Mistral",
      "agent", "coding assistant", "Copilot", "Cursor", "model"
    ]
  },
  "priority_sources": [
    "https://www.anthropic.com/news.rss",
    "https://openai.com/news/rss.xml",
    "https://techcrunch.com/tag/artificial-intelligence/feed/",
    "https://blog.google/technology/ai/rss/"
  ],
  "search_queries": [
    "AI news this week",
    "new AI tools released this week",
    "Claude Anthropic updates",
    "ChatGPT OpenAI updates",
    "Gemini Google updates",
    "vibe coding news",
    "Cursor IDE updates",
    "AI developer tools new"
  ],
  "light_web_queries": [
    "AI model release announcement {MONTH} {YEAR}",
    "AI developer tools coding assistant IDE news {MONTH} {YEAR}",
    "AI product launch business integration {MONTH} {YEAR}",
    "AI regulation safety policy news {MONTH} {YEAR}"
  ]
}
```

- [ ] **Step 1.2: Add `gatherLightWeb` step to `pipeline.json`**

Add inside `"steps"` after `"gatherWeb"`:

```json
    "gatherLightWeb": {
      "model": "claude-haiku-4-5-20251001",
      "temperature": 0.3,
      "max_tokens": 1024,
      "tools": ["web_search"]
    },
```

- [ ] **Step 1.3: Verify JSON is valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('src/config/sources.json','utf8')); console.log('sources.json ok')"
node -e "JSON.parse(require('fs').readFileSync('src/config/pipeline.json','utf8')); console.log('pipeline.json ok')"
```

Expected: both print "ok"

- [ ] **Step 1.4: Commit**

```bash
git add src/config/sources.json src/config/pipeline.json
git commit -m "feat(digest): add light_web_queries config and gatherLightWeb step"
```

---

## Task 2: `fetchLightWebSearch()` in `sources.ts` + unit tests

**Files:**
- Modify: `src/lib/sources.ts`
- Modify: `src/lib/__tests__/sources.test.ts`

- [ ] **Step 2.1: Write failing tests first**

Open `src/lib/__tests__/sources.test.ts`.

Add at the top (after the existing `vi.mock('@netlify/blobs', ...)` block):

```typescript
vi.mock('../claude.js', () => ({ callClaude: vi.fn() }));
```

Add imports at the top of the import section:

```typescript
import { fetchSourceContext, fetchLightWebSearch } from '../sources.js';
import { callClaude } from '../claude.js';
```

Replace the existing `import { fetchSourceContext } from '../sources.js';` line with the combined import above.

Then add the `callClaude` mock reference after existing mock variables (or near them):

```typescript
const mockCallClaude = vi.mocked(callClaude);
```

Add the following `describe` block at the end of the file (after the existing HN/RSS tests):

```typescript
describe('fetchLightWebSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('concatenates results from all 4 queries', async () => {
    mockCallClaude
      .mockResolvedValueOnce('result A')
      .mockResolvedValueOnce('result B')
      .mockResolvedValueOnce('result C')
      .mockResolvedValueOnce('result D');

    const result = await fetchLightWebSearch();

    expect(mockCallClaude).toHaveBeenCalledTimes(4);
    expect(result).toContain('result A');
    expect(result).toContain('result B');
    expect(result).toContain('result C');
    expect(result).toContain('result D');
  });

  it('returns empty string when all queries fail', async () => {
    mockCallClaude.mockRejectedValue(new Error('network error'));

    const result = await fetchLightWebSearch();

    expect(result).toBe('');
  });

  it('returns partial results when some queries fail', async () => {
    mockCallClaude
      .mockResolvedValueOnce('result A')
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('result C')
      .mockRejectedValueOnce(new Error('fail'));

    const result = await fetchLightWebSearch();

    expect(result).toContain('result A');
    expect(result).toContain('result C');
    expect(result).not.toContain('result B');
  });

  it('injects current month and year into queries', async () => {
    mockCallClaude.mockResolvedValue('some result');

    await fetchLightWebSearch();

    const year = new Date().getFullYear().toString();
    const calls = mockCallClaude.mock.calls;
    expect(calls.length).toBe(4);
    calls.forEach(([args]) => {
      expect(args.userMessage).toContain(year);
    });
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
npx vitest run src/lib/__tests__/sources.test.ts
```

Expected: FAIL — "fetchLightWebSearch is not a function" or similar.

- [ ] **Step 2.3: Implement `fetchLightWebSearch()` in `sources.ts`**

Add `callClaude` to the imports at the top of `src/lib/sources.ts`:

```typescript
import { callClaude } from './claude.js';
```

Add the following function at the end of `src/lib/sources.ts`:

```typescript
// ── Light web search ──────────────────────────────────────────────────────────

export async function fetchLightWebSearch(): Promise<string> {
  const sourcesPath = join(process.cwd(), 'src/config/sources.json');
  const pipelinePath = join(process.cwd(), 'src/config/pipeline.json');
  const sources = JSON.parse(readFileSync(sourcesPath, 'utf-8')) as {
    light_web_queries?: string[];
  };
  const pipeline = JSON.parse(readFileSync(pipelinePath, 'utf-8')) as {
    steps: {
      gatherLightWeb: { model: string; temperature: number; max_tokens: number; tools: string[] };
    };
  };

  const queries = sources.light_web_queries ?? [];
  if (queries.length === 0) return '';

  const cfg = pipeline.steps.gatherLightWeb;
  const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const results = await Promise.all(
    queries.map((query, i) => {
      const expanded = query.replace('{MONTH} {YEAR}', monthYear);
      return callClaude({
        systemPrompt:
          'Find 5 recent AI news items matching this query. For each item return: headline (one sentence), source URL, publication date. Return plain text, no markdown. Focus on items from the last 7 days.',
        userMessage: expanded,
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.max_tokens,
        tools: cfg.tools,
      }).catch(err => {
        console.warn(`[sources] light web query ${i + 1} failed:`, err);
        return '';
      });
    })
  );

  return results.filter(Boolean).join('\n\n');
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
npx vitest run src/lib/__tests__/sources.test.ts
```

Expected: all tests pass (existing 8 + new 4 = 12 total in this file).

- [ ] **Step 2.5: Run full suite to check for regressions**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 2.6: Commit**

```bash
git add src/lib/sources.ts src/lib/__tests__/sources.test.ts
git commit -m "feat(digest): add fetchLightWebSearch() with 4 parallel Haiku queries"
```

---

## Task 3: Update `pipeline.ts` to use parallel fetch + update tests

**Files:**
- Modify: `src/lib/pipeline.ts`
- Modify: `src/lib/__tests__/pipeline.test.ts`

- [ ] **Step 3.1: Update the `PipelineConfig` interface in `pipeline.ts`**

Find the `PipelineConfig` interface (lines 13-22):

```typescript
interface PipelineConfig {
  steps: {
    gatherWeb: { model: string; temperature: number; max_tokens: number; tools: string[] };
    selectTopics: { model: string; temperature: number; max_tokens: number; tools: string[] };
    generate: { model: string; temperature: number; max_tokens: number; tools: string[] };
    review: { model: string; temperature: number; max_tokens: number; tools: string[] };
    rewrite: { model: string; temperature: number; max_tokens: number; tools: string[] };
    fix: { model: string; temperature: number; max_tokens: number; tools: string[] };
  };
}
```

Replace with:

```typescript
interface PipelineConfig {
  steps: {
    gatherWeb: { model: string; temperature: number; max_tokens: number; tools: string[] };
    gatherLightWeb: { model: string; temperature: number; max_tokens: number; tools: string[] };
    selectTopics: { model: string; temperature: number; max_tokens: number; tools: string[] };
    generate: { model: string; temperature: number; max_tokens: number; tools: string[] };
    review: { model: string; temperature: number; max_tokens: number; tools: string[] };
    rewrite: { model: string; temperature: number; max_tokens: number; tools: string[] };
    fix: { model: string; temperature: number; max_tokens: number; tools: string[] };
  };
}
```

- [ ] **Step 3.2: Update the import line for `sources.js`**

Find line 4:

```typescript
import { fetchHackerNewsContext } from './sources.js';
```

Replace with:

```typescript
import { fetchHackerNewsContext, fetchLightWebSearch } from './sources.js';
```

- [ ] **Step 3.3: Replace the threshold block with parallel `Promise.all`**

Find the Step 0 block (lines ~339-367):

```typescript
    // Step 0: Gather context — HN first, web search only as fallback
    const t0 = Date.now();
    const sources = JSON.parse(readConfig('sources.json')) as SourcesConfig;
    const threshold = sources.hackernews_api?.fallback_threshold ?? 8;

    let hnContext = '';
    let webContext = '';
    let hnOk = false;
    let hnItemCount = 0;
    try {
      const hn = await fetchHackerNewsContext();
      hnContext = hn.context;
      hnItemCount = hn.itemCount;
      hnOk = true;
    } catch (err) {
      console.warn('[pipeline] hackernews fetch failed, will fall back to web search:', err);
    }

    if (!hnOk) {
      console.log('[pipeline] running web search (HN unavailable)');
      webContext = await fetchWebContext(cfg);
    } else if (hnItemCount < threshold) {
      console.log(`[pipeline] running web search (sparse HN: ${hnItemCount} < ${threshold})`);
      webContext = await fetchWebContext(cfg);
    } else {
      console.log(`[pipeline] skipping web search (HN has ${hnItemCount} items, threshold ${threshold})`);
    }
    timing.gatherContext = Date.now() - t0;
    console.log(`[pipeline] context gathered in ${timing.gatherContext}ms`);
```

Replace with:

```typescript
    // Step 0: Gather context — HN + light web search in parallel
    const t0 = Date.now();

    const [hnResult, webContext] = await Promise.all([
      fetchHackerNewsContext().catch(err => {
        console.warn('[pipeline] HN fetch failed:', err);
        return { context: '', itemCount: 0 };
      }),
      fetchLightWebSearch(),
    ]);
    const hnContext = hnResult.context;
    timing.gatherContext = Date.now() - t0;
    console.log(`[pipeline] context gathered in ${timing.gatherContext}ms`);
```

- [ ] **Step 3.4: Update `pipeline.test.ts` sources mock**

Find line 4:

```typescript
vi.mock('../sources.js', () => ({ fetchHackerNewsContext: vi.fn() }));
```

Replace with:

```typescript
vi.mock('../sources.js', () => ({ fetchHackerNewsContext: vi.fn(), fetchLightWebSearch: vi.fn() }));
```

Find line 13:

```typescript
import { fetchHackerNewsContext } from '../sources.js';
```

Replace with:

```typescript
import { fetchHackerNewsContext, fetchLightWebSearch } from '../sources.js';
```

Add after `const mockFetchHackerNewsContext = vi.mocked(fetchHackerNewsContext);`:

```typescript
const mockFetchLightWebSearch = vi.mocked(fetchLightWebSearch);
```

In the `beforeEach` block, add:

```typescript
  mockFetchLightWebSearch.mockResolvedValue('');
```

Find the stale comment on line 58:

```typescript
// Default: HN returns enough items to skip web search fallback (threshold=8 in sources.json)
```

Replace with:

```typescript
// Default: HN returns 10 items, light web search returns '' (empty mock)
```

Find the test that checks `result.webContext === ''` (lines 151-162):

```typescript
  it('exposes hnContext, webContext, selectedTopics in result', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.hnContext).toBe('HN context');
    expect(result.webContext).toBe(''); // HN above threshold → web skipped
    expect(result.selectedTopics).toMatchObject({ topics: expect.any(Array), sparseWeek: false });
  });
```

Replace with:

```typescript
  it('exposes hnContext, webContext, selectedTopics in result', async () => {
    mockCallClaudeStructured
      .mockResolvedValueOnce(okTopics(1))
      .mockResolvedValueOnce(okReview);
    mockCallClaude.mockResolvedValueOnce(VALID_POST);

    const result = await generatePipelinePost();

    expect(result.hnContext).toBe('HN context');
    expect(result.webContext).toBe(''); // light web search mock returns ''
    expect(result.selectedTopics).toMatchObject({ topics: expect.any(Array), sparseWeek: false });
  });
```

- [ ] **Step 3.5: Run tests to verify they pass**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 3.6: Commit**

```bash
git add src/lib/pipeline.ts src/lib/__tests__/pipeline.test.ts
git commit -m "feat(digest): run light web search in parallel with HN, remove threshold fallback"
```

---

## Manual Verification (post-deploy)

After deploying:

1. Trigger a manual pipeline run via the HTTP trigger endpoint.
2. Check function logs for `[pipeline] context gathered in Xms` — should be ~5-8s (parallel), not 1.8s.
3. Check that web context from the 4 Haiku queries appears in `latest-result` blob.
4. Verify the digest post covers topics beyond what shir-man.com curates.
