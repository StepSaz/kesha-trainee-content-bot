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
