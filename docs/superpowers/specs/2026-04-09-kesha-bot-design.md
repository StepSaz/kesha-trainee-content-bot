# Kesha Bot — Design Spec

**Date:** 2026-04-09  
**Status:** Approved

---

## Overview

Kesha (Иннокентий) is a Telegram bot-intern for the channel @CtrlAltTherapy_test (later @psyreq). It posts AI/tech content bi-weekly on Wednesdays and on manual trigger. Under the hood: Claude API + web search + RSS. Full autopilot — no pre-approval needed.

Two pipeline engines live in one repo, switchable via `KESHA_MODE` env var. Both post to the same Telegram channel. The goal is to run both for 4 weeks and pick the winner.

---

## File Structure

```
kesha-trainee-content-bot/
  netlify/
    functions/
      kesha-post.mts          # Cron bi-weekly Wed 11:00 UTC, routes by KESHA_MODE
      kesha-test.mts          # HTTP GET ?secret=X&mode=pipeline|managed&channel=test|main
  scripts/
    setup-managed-agent.ts    # One-time: creates Managed Agent + Environment, prints IDs
  src/
    config/
      kesha-persona.txt       # System prompt: Kesha character v1 (робкий стажер)
      kesha-reviewer.txt      # System prompt: strict editor, 6-point checklist
      kesha-agent-prompt.txt  # Plan B combined: persona + self-review workflow
      pipeline.json           # Models, temperatures, token limits per step
      sources.json            # RSS feeds + search queries
    lib/
      claude.ts               # Claude API wrapper (Plan A)
      rss.ts                  # Fetch + parse RSS context (Plan A)
      pipeline.ts             # Orchestrator: gather→select→generate→review→rewrite (Plan A)
      managed-agent.ts        # Managed Agents API wrapper (Plan B)
      telegram.ts             # Shared: Telegram Bot API
      validator.ts            # Shared: technical post validation
  netlify.toml
  package.json
  tsconfig.json
  .env.example
  .gitignore
  README.md
```

---

## Stack

- **Runtime:** Node.js + TypeScript
- **Deploy:** Netlify Functions (scheduled + HTTP)
- **AI SDK:** `@anthropic-ai/sdk`
- **Model:** `claude-sonnet-4-6` across all steps
- **RSS parsing:** `fast-xml-parser`
- **Telegram:** native fetch to Bot API

---

## Plan A — Pipeline (3+2 Claude calls)

### Data Flow

```
CRON or HTTP trigger
        │
        ▼
Step 0: gatherContext()
  ├─ fetchRssContext()     ← HTTP fetch RSS feeds → fast-xml-parser → text block
  └─ fetchWebContext()     ← Claude + web_search, queries from sources.json → text block
        │
        ▼
Step 1: selectTopics()
  └─ Claude (low temp 0.3) picks best 3-5 topics from RSS + web context
     returns: structured list { topic, source, why_interesting }
        │
        ▼
Step 2: generatePost()
  └─ Claude (persona, t=0.8, web_search enabled)
     user prompt: date + RSS context + web context + selected topics
        │
        ▼
Step 3: reviewPost()
  └─ Claude (reviewer, t=0.3) → "хорошо" | "нормально" | "нужна переработка"
     + specific quotes and suggested fixes
        │
        ├── "хорошо" ──▶ skip Step 4
        │
        ▼
Step 4: rewritePost()     ← only if not "хорошо"
  └─ Claude (persona, t=0.7, no tools)
     user prompt: draft + reviewer feedback
        │
        ▼
validatePost()
  ├── valid ──▶ sendToChannel()
  └── invalid ──▶ retry full pipeline once
                  ├── valid ──▶ sendToChannel()
                  └── invalid ──▶ log all, do NOT post, exit
```

### pipeline.json

```json
{
  "steps": {
    "gatherWeb":    { "model": "claude-sonnet-4-6", "temperature": 0.3, "max_tokens": 2048, "tools": ["web_search"] },
    "selectTopics": { "model": "claude-sonnet-4-6", "temperature": 0.3, "max_tokens": 1024, "tools": [] },
    "generate":     { "model": "claude-sonnet-4-6", "temperature": 0.8, "max_tokens": 4096, "tools": ["web_search"] },
    "review":       { "model": "claude-sonnet-4-6", "temperature": 0.3, "max_tokens": 2048, "tools": [] },
    "rewrite":      { "model": "claude-sonnet-4-6", "temperature": 0.7, "max_tokens": 4096, "tools": [] }
  },
  "managed": { "model": "claude-sonnet-4-6" },
  "max_review_cycles": 1
}
```

### Cost estimate

Up to 5 Claude calls per post with web search: ~$2–2.5/post, ~$5–10/month at bi-weekly cadence.

---

## Plan B — Managed Agents (1 agent session)

### Data Flow

```
CRON or HTTP trigger
        │
        ▼
runSession(agentId, envId)
  Agent works autonomously:
  1. curl RSS feeds + parse XML
  2. web_search for fresh AI/tech news (queries from sources.json in prompt)
  3. select best 3-5 topics
  4. write draft post as Kesha
  5. self-review against 6-point checklist
  6. rewrite if needed
  7. final format check (no em-dash, no markdown, has 🐤, length ok)
  8. write to /tmp/final_post.txt
        │
        ▼
read /tmp/final_post.txt from container
        │
        ▼
validatePost()
  ├── valid ──▶ sendToChannel()
  └── invalid ──▶ retry with new session
                  ├── valid ──▶ sendToChannel()
                  └── invalid ──▶ log all, do NOT post, exit
```

### Setup (one-time)

Run `npx ts-node scripts/setup-managed-agent.ts` once:
- calls Managed Agents API to create agent (with `kesha-agent-prompt.txt` as system prompt)
- calls API to create environment
- prints `MANAGED_AGENT_ID` and `MANAGED_ENVIRONMENT_ID` → paste into Netlify env vars

Beta header required: `managed-agents-2026-04-01`

### Cost estimate

~$1–2/session (beta pricing), ~$2–4/month at bi-weekly cadence.

---

## Shared Modules

### validator.ts

Checks (no Claude call, pure code):
- Contains "БОТ" or "УЧУСЬ" in uppercase (disclaimer present)
- Contains "Кеша" somewhere
- Contains 🐤 at least once
- No em-dash `—` (U+2014)
- No markdown: `**`, `##`, ` ``` `
- Length ≤ 4000 characters

Returns: `{ valid: boolean, errors: string[] }`

### telegram.ts

`sendToChannel(text, chatId?)` — POST to Telegram Bot API `sendMessage`, no `parse_mode` (plain text). Returns `{ success, messageId?, error? }`.

### rss.ts (Plan A)

`fetchRssContext()` — fetch each RSS feed (5s timeout), parse XML via `fast-xml-parser`, extract title/link/description/pubDate, strip HTML from description, sort by date, take `max_items`, format as text block. Returns empty string on any error.

### claude.ts (Plan A)

`callClaude({ systemPrompt, userMessage, model, temperature, maxTokens, tools? })` — wraps `@anthropic-ai/sdk`. Adds `web_search_20250305` tool if `tools` includes `"web_search"`. Collects text blocks from response. Returns string.

---

## Prompts

### kesha-persona.txt

Stage 1 (робкий стажер). Includes:
- Role: Иннокентий (Кеша), junior content bot, Степан's intern at @psyreq
- Disclaimer: "Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ. Не бейте. 🐤"
- Greeting: "Кеша на проводе🐤"
- Separators: `~ ~ ~`
- Emojis: 🐤 🤖 👀 🫡 📎
- Format rules: plain text, NO em-dash, NO markdown
- Topics: AI news, tech tools, vibe coding, AI for analysts/PMs
- Length: ≤ 2000 chars (max 3500 for longread)
- End with question to audience or @psyreq tag
- Anti-slop rules, self-deprecating bot humor

### kesha-reviewer.txt

Strict editor role. 6-point checklist:
1. ИНТЕРЕС — is this generic or genuinely interesting?
2. ХАРАКТЕР — does it sound like Kesha or a faceless bot?
3. АНТИСЛОП — template phrases, filler, ruble-cut sentences?
4. КОНКРЕТИКА — numbers, names, links?
5. ФОРМАТ — no em-dash, no markdown, disclaimer present?
6. ДЛИНА — no water?

Output format: rating (хорошо/нормально/нужна переработка) + specific quoted fixes, not abstract advice.

### kesha-agent-prompt.txt (Plan B)

Same character as persona.txt plus explicit workflow:
- Step 1: `curl` RSS + parse
- Step 2: web_search for news
- Step 3: select 3-5 best topics
- Step 4: write draft → save to `/tmp/draft.txt`
- Step 5: self-review against 6-point checklist → save to `/tmp/review.txt`
- Step 6: rewrite if needed → save to `/tmp/final_post.txt`
- Step 7: verify final format, fix in place

---

## Entry Points

### kesha-post.mts (cron)

Schedule: `0 11 1-7,15-21 * 3` (bi-weekly: 1st + 3rd Wednesday of month, 11:00 UTC = 12:00 CET)

Logic:
1. Check `KESHA_ENABLED` — if false, log "skipped" and exit
2. Read `KESHA_MODE`
3. Route to `pipeline.ts` or `managed-agent.ts`
4. On success: `sendToChannel(post, TELEGRAM_CHAT_ID)`
5. On failure after retry: log everything, exit without posting

### kesha-test.mts (HTTP)

`GET ?secret=X&mode=pipeline|managed&channel=test|main`

- Validates `secret === TEST_SECRET`
- `mode` overrides `KESHA_MODE` for this run
- `channel=main` uses `TELEGRAM_CHAT_ID`, `channel=test` uses `TELEGRAM_TEST_CHAT_ID`
- Returns full JSON: `{ success, rssContext, webContext, selectedTopics, draft, review, finalPost, validationErrors, timing }`

Use this for: manual "I saw cool news" triggers, debugging, first-week double post.

---

## Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=@CtrlAltTherapy_test        # flip to @psyreq for production
TELEGRAM_TEST_CHAT_ID=@CtrlAltTherapy_test   # or personal chat ID
KESHA_MODE=pipeline                           # pipeline | managed
KESHA_ENABLED=true                            # false = skip cron run
TEST_SECRET=<32+ char random string>
MANAGED_AGENT_ID=                             # filled after setup script
MANAGED_ENVIRONMENT_ID=                       # filled after setup script
```

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| RSS fetch fails | Log, continue with empty RSS context |
| Web gather fails | Log, continue (generate still gets RSS context) |
| Post fails validation | Retry full pipeline once |
| Retry also fails | Log all intermediate results, do NOT post, exit cleanly |
| Managed agent timeout | Retry with new session once |
| `KESHA_ENABLED=false` | Log "skipped", exit immediately |

All errors visible in Netlify Functions tab logs.

---

## Scheduling Summary

| Trigger | When | Channel |
|---------|------|---------|
| Cron (bi-weekly) | 1st + 3rd Wed, 12:00 CET | `TELEGRAM_CHAT_ID` |
| Manual (`?channel=main`) | anytime | `TELEGRAM_CHAT_ID` |
| Manual (`?channel=test`) | anytime | `TELEGRAM_TEST_CHAT_ID` |
