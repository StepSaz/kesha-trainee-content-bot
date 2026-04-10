# Tiered Topic Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat INCLUDE/SKIP rubric in `selectTopics` with a three-tier priority system and explicit selection algorithm.

**Architecture:** Prompt-only change in `pipeline.ts`. No new files, no pipeline steps, no code logic changes. The tiered rubric gives the model a deterministic decision sequence instead of a list of hints.

**Tech Stack:** TypeScript, Vitest (existing tests cover SPARSE_WEEK behavior — no new tests needed since `callClaude` is mocked and prompt content is not tested)

---

### Task 1: Replace selectTopics prompt with tiered rubric

**Files:**
- Modify: `src/lib/pipeline.ts` — `selectTopics` function, `systemPrompt` and `userMessage` strings

- [ ] **Step 1: Replace the system prompt**

In `src/lib/pipeline.ts`, replace the entire `systemPrompt` constant inside `selectTopics`:

```typescript
  const systemPrompt = `You are a content curator for a Russian-language Telegram channel about AI and tech. Audience: IT analysts, product managers, and a broad tech audience. Practical impact and ecosystem significance matter more than technical depth.

Select topics using this tiered rubric:

TIER 1 - Always include (if within 2-week window):
Any public-facing announcement, product launch, or strategic move from the four major AI vendors: Anthropic, OpenAI, Google, Meta. If it is from one of these four and it is public, it belongs in the digest.

TIER 2 - Include if there is room (fill up to 5 topics):
- Ecosystem milestones - install/user milestones, ownership changes, acquisitions, large partnerships
- New tools that change daily workflows for analysts, PMs, or developers
- Strategic moves by other AI companies - funding rounds, pivots, open-sourcing, restricted previews signalling direction
- Widely discussed events - trending across tech media, HN, Twitter/X

TIER 3 - Only if total is fewer than 3:
- Developer frameworks, SDKs, open-source libraries
- Technical releases without direct end-user product impact

SKIP - Never include:
- Arxiv preprints and academic papers, even from major labs
- Minor version bumps, patches, changelogs
- Narrow benchmarks without a practical "so what"
- Technical RFCs and internal standards
- ML research without direct user impact (KV-cache optimizations, quantization methods, architectural improvements)

SELECTION ALGORITHM - follow this sequence exactly:
1. Collect all Tier 1 candidates. If Tier 1 alone exceeds 5, pick the 5 most significant.
2. Fill up to 5 topics by adding the best Tier 2 candidates.
3. If total is still fewer than 3, add the best available from Tier 3.
4. If final total is exactly 3, append SPARSE_WEEK on its own line at the very end.
5. With 4 or 5 topics, never append SPARSE_WEEK.`;
```

- [ ] **Step 2: Replace the user message**

Still inside `selectTopics`, replace the `userMessage` constant:

```typescript
  const userMessage = `Here is this week's content:\n\nRSS feed:\n${rssContext}\n\nWeb search findings:\n${webContext}\n\nSelect 3-5 topics using the tiered rubric. Number each topic (1. 2. 3. etc). For each: topic name, source, and why it is interesting for IT analysts/PMs (1-2 sentences in Russian). Follow the selection algorithm — Tier 1 first, then Tier 2, Tier 3 only if needed. SPARSE_WEEK only if exactly 3 topics total.`;
```

- [ ] **Step 3: Run the full test suite**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && npx vitest run
```

Expected: all 36 tests pass. The SPARSE_WEEK guard test and pipeline tests are not affected since `callClaude` is mocked.

- [ ] **Step 4: Commit and push**

```bash
cd /Users/stepansazanavets/Projects/kesha-trainee-content-bot && git add src/lib/pipeline.ts && git commit -m "feat: replace flat rubric with tiered topic selection (Tier 1: major vendors always first)" && git push
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Covered |
|---|---|
| Tier 1: Anthropic/OpenAI/Google/Meta always included | Step 1 system prompt |
| Tier 2: ecosystem, tools, strategic moves | Step 1 system prompt |
| Tier 3: SDKs/frameworks only if <3 total | Step 1 system prompt |
| SKIP list preserved | Step 1 system prompt |
| Explicit selection algorithm | Step 1 system prompt |
| Tier 1 cap at 5 if overflow | Step 1 system prompt (point 1 of algorithm) |
| SPARSE_WEEK only if exactly 3 | Step 1 system prompt (point 4) |
| User message references tiered rubric | Step 2 |

**Placeholder scan:** No TBDs. All code is complete.

**Type consistency:** No new types. Existing `systemPrompt` and `userMessage` string variables replaced in-place.
