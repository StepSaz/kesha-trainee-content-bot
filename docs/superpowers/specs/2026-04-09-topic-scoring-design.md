# Topic Scoring & Filtering Design

**Date:** 2026-04-09  
**Status:** Approved  

## Problem

The `selectTopics` step currently picks "3-5 most interesting topics" with no criteria. This allows low-value ML research papers and under-the-hood optimizations (e.g. KV-cache compression) to appear in the digest alongside genuinely important ecosystem events (e.g. MCP → Linux Foundation).

## Goal

Give `selectTopics` an explicit rubric so important releases always appear and overly technical content is filtered out. Handle sparse weeks gracefully.

## Audience

IT analysts, product managers, and broad tech audience. Practical impact and ecosystem significance matter more than technical depth.

## Approach

Option A — scoring rubric embedded in the `selectTopics` prompt. No new pipeline steps, no new files.

## Rubric

### Include (high priority)
- Major product launches — new models (GPT-5, Claude 4), GA releases, major versions with user-facing changes
- Ecosystem milestones — install/user milestones, ownership changes (MCP → Linux Foundation), acquisitions, large partnerships
- New tools that change daily workflows for analysts, PMs, or developers
- Strategic moves by major AI companies — funding rounds, pivots, open-sourcing
- Widely discussed events — trending across tech media, HN, Twitter/X

### Skip (low priority)
- ML research without direct user impact — KV-cache optimizations, quantization methods, architectural improvements
- Arxiv preprints and academic papers, even from major labs
- Minor version bumps, patches, changelogs
- Narrow benchmarks without a practical "so what"
- Technical RFCs and internal standards

## Sparse Week Handling

If fewer than 3 qualifying topics are found:
- `selectTopics` selects the best available (minimum 2) and appends `SPARSE_WEEK` to its output
- `generatePost` detects `SPARSE_WEEK` and includes a natural in-character remark, e.g.: _«Честно, на этой неделе негусто — нашёл только два повода написать»_
- The validator minimum is lowered from 3 to 2 source references (📎)

## Changes Required

### 1. `selectTopics` system prompt (`pipeline.ts`)
Replace generic "content curator" instruction with rubric + `SPARSE_WEEK` signal.

### 2. `generatePost` user message (`pipeline.ts`)
Add: if `selectedTopics` contains `SPARSE_WEEK`, write a 2-topic post with an in-character sparse-week remark.

### 3. `validator.ts`
Lower minimum `📎` count from 3 to 2.

### 4. `validator.test.ts` and `pipeline.test.ts`
Update affected tests accordingly.

## Out of Scope

- Visible scoring on the result page
- Separate scoring pipeline step
- External config file for the rubric (can be extracted later if needed)
