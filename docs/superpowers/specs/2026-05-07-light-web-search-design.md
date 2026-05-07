# Light Web Search — Always-On Parallel Source — Design Spec

**Date:** 2026-05-07
**Status:** Approved

---

## Problem

`fetchWebContext()` (8-query web search) only runs as a fallback when HN returns fewer than 8 items. In practice HN always returns 30 items (shir-man.com curates ~30/week), so web search **never fires**. The digest is entirely dependent on Shir-Man's HN curation + 4 RSS feeds, missing major AI news that doesn't surface in those channels.

---

## Solution

Add `fetchLightWebSearch()` — a lightweight 4-query Haiku web search that always runs in parallel with `fetchSourceContext()`. Results are merged into `webContext` and passed to `selectTopics` as before. The threshold-based `fetchWebContext` call is removed.

---

## Architecture

### Modified files

```
src/lib/sources.ts          — add fetchLightWebSearch()
src/lib/pipeline.ts         — run parallel fetch, remove threshold fallback
src/config/sources.json     — add light_web_queries array
src/config/pipeline.json    — add gatherLightWeb model config
```

### No new dependencies, no schema changes, no new blob keys.

---

## `fetchLightWebSearch()`

Located in `src/lib/sources.ts`. Exported function with no required arguments.

Runs 4 Claude Haiku calls in `Promise.all`, each with `web_search` tool and one query. Month and year are injected dynamically (e.g. `"May 2026"`).

### Queries (stored in `sources.json` as `light_web_queries`)

```json
[
  "AI model release announcement {MONTH} {YEAR}",
  "AI developer tools coding assistant IDE news {MONTH} {YEAR}",
  "AI product launch business integration {MONTH} {YEAR}",
  "AI regulation safety policy news {MONTH} {YEAR}"
]
```

`{MONTH}` and `{YEAR}` are replaced at call time using `new Date()`.

### Per-query system prompt

```
Find 5 recent AI news items matching this query. For each item return:
- headline (one sentence)
- source URL
- publication date

Return plain text, no markdown. Focus on items from the last 7 days.
```

### Return value

String — all 4 results concatenated with newlines. Same shape as the existing `fetchWebContext` return value, so `selectTopics` receives it unchanged as `webContext`.

### Error handling

If an individual query fails (network error, Claude error), catch and log `[sources] light web query N failed: ...`, return empty string for that query. Partial results still flow through. If all 4 fail, return `''` — same as current "no web context" path.

---

## Pipeline Change (`pipeline.ts`)

### Before

```typescript
const { context: hnContext, itemCount } = await fetchSourceContext();
let webContext = '';
if (itemCount < config.fallback_threshold) {
  webContext = await fetchWebContext(...);
}
```

### After

```typescript
const [{ context: hnContext }, webContext] = await Promise.all([
  fetchSourceContext(),
  fetchLightWebSearch(),
]);
```

`fallback_threshold` config key and `fetchWebContext` call are removed from the pipeline hot path. `fetchWebContext` function stays in `sources.ts` but is no longer called — to be cleaned up separately once the new approach is validated in production.

---

## Config (`pipeline.json`)

Add under `models`:

```json
"gatherLightWeb": {
  "model": "claude-haiku-4-5-20251001",
  "temperature": 0.3,
  "maxTokens": 1024
}
```

---

## Cost & Latency

| | Before | After |
|---|---|---|
| Web search calls | 0 (HN always ≥ 8) | 4 Haiku calls always |
| Web search cost | $0 | ~$0.04/run |
| `gatherContext` time | ~1.8s | ~5-8s (parallel with HN) |
| Total pipeline time | ~53s | ~55-58s |

The 4 Haiku calls run in `Promise.all` so they don't add sequential latency. The bottleneck remains `selectTopics` (~14s) and `generate` (~27s).

---

## Out of Scope

- Removing `fetchWebContext` entirely (deferred until production validation)
- Changing `selectTopics` ranking logic or tier system
- Adding more queries (start with 4, tune after observing results)
- Caching web search results (HN context is already cached; web search is fast enough)
