# Kesha Trainee Content Bot

Кеша (Иннокентий) — бот-стажер Telegram-канала [@psyreq](https://t.me/psyreq).
Постит раз в две недели по средам. Пишет про AI, tech, vibe coding.

Two pipeline engines: Plan A (explicit multi-step) and Plan B (Managed Agents, beta).

## Setup

### 1. Clone and install

```bash
git clone <repo>
cd kesha-trainee-content-bot
npm install
```

### 2. Configure env vars

```bash
cp .env.example .env
```

Fill in:
- `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com)
- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
- `TELEGRAM_CHAT_ID` — `@CtrlAltTherapy_test` (test) or `@psyreq` (prod)
- `TELEGRAM_TEST_CHAT_ID` — your personal Telegram chat ID
- `TEST_SECRET` — run `openssl rand -hex 32`

### 3. Run tests

```bash
npm test
```

### 4. Deploy to Netlify

Connect repo to Netlify. Add env vars in:
**Site settings → Environment variables**

### 5. Test manually

```
GET https://your-site.netlify.app/.netlify/functions/kesha-test?secret=YOUR_SECRET&mode=pipeline&channel=test
```

Response is full JSON with all intermediate results (draft, review, timing, etc).

To post to main channel:
```
?secret=X&channel=main
```

## Pipeline Modes

| Mode | How | Claude calls |
|------|-----|-------------|
| `pipeline` | 5 explicit steps | ~5/post, ~$2-2.5 |
| `managed` | 1 autonomous agent session | ~$1-2/session |

Switch mode: set `KESHA_MODE=pipeline` or `KESHA_MODE=managed` in Netlify env vars.

## Plan B Setup (Managed Agents beta)

Once you have beta access:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run setup:managed
```

Copy the printed IDs to Netlify env vars:
- `MANAGED_AGENT_ID`
- `MANAGED_ENVIRONMENT_ID`

## Schedule

Cron: `0 16 * * 3` — every Wednesday at 16:00 UTC (18:00 Warsaw). A day-of-month
gate inside `kesha-post.mts` limits actual runs to the 1st and 3rd Wednesday of
the month (bi-weekly). Pure cron can't AND day-of-month with day-of-week, so the
gate has to live in code.

To skip a week: set `KESHA_ENABLED=false` in Netlify env vars.

## Architecture

```
kesha-post.mts (cron)
  └─ KESHA_MODE=pipeline → pipeline.ts
       ├─ fetchRssContext() + fetchWebContext() [parallel]
       ├─ selectTopics()
       ├─ generatePost()
       ├─ reviewPost()
       └─ rewritePost() (if review != хорошо)
  └─ KESHA_MODE=managed → managed-agent.ts
       └─ runSession() → autonomous agent → /tmp/final_post.txt

kesha-test.mts (HTTP)
  └─ ?mode=pipeline|managed&channel=test|main
```
