# Tiered Topic Selection Design

**Date:** 2026-04-10  
**Status:** Approved

## Problem

The flat INCLUDE/SKIP rubric in `selectTopics` leaves too much room for inconsistent LLM judgment. Observed failures:
- High-priority vendor news missed (Anthropic Managed Agents, Anthropic Mythos Preview)
- Low-priority developer SDKs included (Microsoft Agent Framework)
- No explicit ordering when candidates exceed 5 slots

## Goal

Replace flat INCLUDE/SKIP lists with a three-tier priority system and an explicit selection algorithm so the LLM has a deterministic decision process rather than a list of hints.

## Audience

IT analysts, product managers, broad tech audience. Practical impact matters more than technical depth. Major vendor moves (Anthropic, OpenAI, Google, Meta) are always relevant to this audience.

## Approach

Prompt-only change in `selectTopics` system prompt (`pipeline.ts`). No new pipeline steps, no new files, no code changes beyond the prompt strings.

## Tiered Rubric

### Tier 1 — Always include (if within 2-week window)
Any public-facing announcement, product launch, or strategic move from the four major AI vendors: **Anthropic, OpenAI, Google, Meta**. If it's from one of these four and it's public, it belongs in the digest.

### Tier 2 — Include if there is room (fill up to 5 topics)
- Ecosystem milestones — install/user milestones, ownership changes, acquisitions, large partnerships
- New tools that change daily workflows for analysts, PMs, or developers
- Strategic moves by other AI companies — funding rounds, pivots, open-sourcing, restricted previews signalling direction
- Widely discussed events — trending across tech media, HN, Twitter/X

### Tier 3 — Only if total is fewer than 3
- Developer frameworks, SDKs, open-source libraries
- Technical releases without direct end-user product impact

### Skip — Never include
- Arxiv preprints and academic papers, even from major labs
- Minor version bumps, patches, changelogs
- Narrow benchmarks without a practical "so what"
- Technical RFCs and internal standards
- ML research without direct user impact (KV-cache optimizations, quantization methods, architectural improvements)

## Selection Algorithm

The prompt instructs the model to follow this sequence explicitly:

1. Collect all Tier 1 candidates from the provided content. If Tier 1 alone exceeds 5, pick the 5 most significant.
2. Fill up to 5 topics by adding the best Tier 2 candidates
3. If total is still fewer than 3 — add the best available from Tier 3
4. If final total is exactly 3 — append `SPARSE_WEEK` on the last line

## Changes Required

### 1. `selectTopics` system prompt (`pipeline.ts`)
Replace current INCLUDE/SKIP + Normally/Count logic with the tiered rubric and explicit algorithm above.

### 2. `selectTopics` user message (`pipeline.ts`)
Update to reference the tier system ("using the tiered rubric") instead of generic "using the rubric".

## Out of Scope

- Code changes to pipeline logic
- New pipeline steps
- Human-in-the-loop topic approval
- External config file for the rubric
