# Kesha Bot — Project Instructions

## Workflow
- Владелец (@st_szs) — не разработчик и PR не ревьюит. Делай саморевью перед пушем, не жди апрува
- После пуша сразу мерджи PR в `main` (squash merge), чтобы фикс попал на прод. Не оставляй PR висеть в draft
- Если есть сомнения в корректности — спроси у владельца до пуша, а не после

## Project Conventions
- Weekly cron is DISABLED (since 2026-06-11) — channel stats showed the digest doesn't drive growth. The owner publishes digests manually via the `/digest` boss command when the week looks empty; news window is still last 7 days
- Any additional triggers (ad-hoc runs, tests) should use the manual HTTP trigger endpoint
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

### Advisor pattern in comment replies (started 2026-05-18)

- **What:** Haiku-driven `handleCommentReply` gets a third tool `consult_advisor({ question, draft_answer? })` that calls Sonnet (`claude-sonnet-5-20260401`) for a short opinion on hard cases (sarcasm, ambiguous tone, facts beyond the post). The base model stays Haiku; the advisor only fires when Haiku decides it's stuck. Inspired by the Anthropic advisor strategy blog post.
- **Code entry points:** `consult_advisor` in [src/lib/comment-tools.ts](src/lib/comment-tools.ts) (search for `// EXPERIMENT (2026-05-18)`), system-prompt update in `handleCommentReply` in [netlify/functions/kesha-boss-background.mts](netlify/functions/kesha-boss-background.mts).
- **Limits:** max 1 advisor call per comment session, advisor `max_tokens=400`, advisor returns advice (1-3 sentences), not the final reply — Haiku still writes the user-facing text in its own voice.
- **Why only comments, not review/generate:** advisor pattern wins when the base model handles most cases and only sometimes needs help. The pipeline `review`/`generate` steps already always need Sonnet — escalating from Haiku there would just mean ~80% advisor calls + double round-trip.
- **Evaluation gate (2026-06-15, joint with the tool-use experiment):** in logs check (1) advisor call rate per comment, (2) qualitative win when fired — did the advice change the answer in a useful way, (3) cost delta vs flat-Haiku baseline. If advisor fires rarely AND doesn't improve answers, drop the tool.
