# Kesha Bot — Project Instructions

## Project Conventions
- Cron schedule is weekly (every Thursday 16:00 Warsaw / 14:00 UTC) — news window is last 7 days
- Any additional triggers (ad-hoc runs, tests) should use the manual HTTP trigger endpoint, not the cron
- Apply content filters (date range, relevance) at the data-gathering step (fetchWebContext), not only in the persona prompt — the prompt is a safety net, the source is the primary filter

## Netlify Background Functions
- Background functions (named `*-background.mts`) have 202 returned to callers automatically at the Netlify infrastructure level — before the function code even runs
- Always `await` handlers inside background functions. Never use `void handler()` fire-and-forget — it kills async work as soon as the handler returns a Response

## Claude API
- Claude may wrap JSON responses in markdown code blocks (` ```json ... ``` `) even when prompted for raw JSON. Always strip code fences before `JSON.parse`
- For review steps that return `corrected_text` (full post), set `max_tokens` to at least 4096 — 1024 truncates long posts
- `callClaude()` uses camelCase params (`maxTokens`, `systemPrompt`) — config JSON uses snake_case; map explicitly when passing config values
- TypeScript files import each other with `.js` extension (ESM): `import { x } from './module.js'`, not `.ts`

## Experiments

### Tool-use comment replies (started 2026-05-15)

- **What:** `handleCommentReply` uses `callClaudeWithTools` (agentic loop) instead of a single Claude call. Kesha decides at runtime whether to call `view_image()` (see the post's photo via vision) or `extract_url(url)` (fetch link content via Tavily).
- **Code entry points:** [src/lib/comment-tools.ts](src/lib/comment-tools.ts), `callClaudeWithTools` in [src/lib/claude.ts](src/lib/claude.ts), `handleCommentReply` in [netlify/functions/kesha-boss-background.mts](netlify/functions/kesha-boss-background.mts). All carry an `// EXPERIMENT (2026-05-15)` marker.
- **Cost/latency:** ~×3 cost and ~×2-3 latency vs deterministic prefetch (extract URLs + load image unconditionally before one Claude call).
- **Limits:** 3 tool-loop iterations max per comment, 1 `view_image` call per loop, Tavily extract trimmed to 3000 chars.
- **Evaluation gate (2026-06-15):** review logs for (1) tool-call utility ratio — did the call actually inform the answer; (2) reader/boss feedback — quality up or down. If neither shows improvement, revert to deterministic prefetch (Option B in the design doc).
- **Design doc:** [docs/superpowers/specs/2026-05-15-kesha-post-context-design.md](docs/superpowers/specs/2026-05-15-kesha-post-context-design.md)
