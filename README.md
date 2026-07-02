# Kesha Trainee Content Bot

Kesha (Innokenty) is the Telegram bot/persona behind parts of Stepan's
`@psyreq` workflow.

Current production shape:

- manual digest generation through Telegram boss commands;
- direct boss publishing with `/boss`;
- notes-based posting with `/notes`;
- comment replies in the Telegram discussion group;
- source gathering from RSS/HN/Tavily/Claude web search;
- Netlify Background Functions + Netlify Blobs for runtime state.

The old weekly cron is disabled. Digest publishing is currently manual because
channel stats showed the scheduled digest was not driving growth.

## Repo Status

- Runtime: Node.js 22 on Netlify Functions.
- Main branch: `main`.
- Production site: `kesha-bot` on Netlify.
- Main function: `netlify/functions/kesha-boss-background.mts`.
- Weekly cron function exists but has no active schedule export.
- Managed Agents / Plan B code is historical/frozen unless explicitly revived.

## Commands

Install and test:

```bash
npm install
npm test
npx tsc --noEmit
```

Known caveat: `npm test` is the current green gate. `npx tsc --noEmit` has known
baseline TypeScript errors outside the current production fixes; do not treat it
as green until those are cleaned up intentionally.

Set or refresh the Telegram webhook:

```bash
TELEGRAM_BOT_TOKEN=... \
NETLIFY_SITE_URL=https://kesha-bot.netlify.app \
TELEGRAM_WEBHOOK_SECRET=... \
npm run setup:boss-webhook
```

Production deploys are handled by Netlify from `main`. If using the Netlify CLI,
pass the site explicitly because local Netlify links have drifted before:

```bash
npx netlify deploy --prod --site 375faca2-70d3-4408-9627-2f743a887c55
```

## Environment Variables

Required in production:

- `ANTHROPIC_API_KEY` - Claude API key.
- `TAVILY_API_KEY` - Tavily search/extract key for web context.
- `TELEGRAM_BOT_TOKEN` - bot token from BotFather.
- `TELEGRAM_CHAT_ID` - target channel, currently `@psyreq`.
- `TELEGRAM_TEST_CHAT_ID` - safe test destination.
- `TELEGRAM_WEBHOOK_SECRET` - Telegram `secret_token` used to verify webhook
  updates. Required in production.
- `TELEGRAM_BOSS_USER_IDS` - comma-separated Telegram user IDs allowed to run
  `/boss`, `/digest`, `/short`, and `/notes`.

Optional / legacy:

- `KESHA_ENABLED` - cron guard; mostly irrelevant while cron is disabled.
- `KESHA_MODE` - historical pipeline/managed switch. Production should stay on
  the explicit pipeline unless Plan B is revived.
- `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID` - historical Managed Agents setup.

## Telegram Boss Commands

All boss commands are handled by `kesha-boss-background.mts` and require a sender
ID listed in `TELEGRAM_BOSS_USER_IDS`.

- `/digest` - generate the full weekly-style digest for manual review/publish.
- `/short` or `/digest short` - generate a short digest.
- `/boss <text>` - publish the provided text to the channel as-is, without review
  or rewrite.
- `/notes` - create a post from a Markdown document flow.

Background functions return HTTP 202 at the Netlify infrastructure layer before
the function body finishes. Use function logs and Telegram messages for the real
outcome.

## Comment Reply Agent

Kesha also replies in Telegram discussion threads.

Current behavior:

- skips the boss for rate limits;
- keeps per-user history and previous-post context;
- enforces per-thread and per-user spam limits;
- can inspect attached images through `view_image`;
- can fetch URL content through `extract_url`;
- can ask a Sonnet advisor through `consult_advisor` for hard tone/fact cases.

Experiment gates from 2026-06-15 still need a data review:

- tool-use utility ratio;
- advisor call rate and usefulness;
- cost/latency versus simpler deterministic prefetch.

Until those gates are closed, do not add more comment-agent complexity.

## Pipeline

The explicit digest pipeline is configured in `src/config/pipeline.json`.

Main steps:

1. gather RSS/HN/web context;
2. select topics;
3. generate Stepan/Kesha experience reactions;
4. generate the post;
5. review;
6. rewrite or fix only when needed.

Current model policy:

- Haiku handles cheaper gathering/review/fix work.
- Sonnet handles topic selection, experience, generation, rewrite, and advisor.
- `claude-sonnet-5` is intentionally kept as the canonical Sonnet 5 API id.

## Source And Safety Rules

- Apply date/relevance filtering at source-gathering time, not only in prompts.
- Do not invent links, source names, or channel facts.
- Plain Telegram text only. Do not add Markdown formatting to final posts unless
  a command explicitly expects a Markdown source document.
- Keep long generation/rewrite `max_tokens` high enough; 1024 truncates posts.
- TypeScript ESM imports use `.js` specifiers even when importing `.ts` sources.

## Important Files

- `CLAUDE.md` - current operational rules and experiment notes.
- `src/config/pipeline.json` - model and boss command config.
- `src/lib/pipeline.ts` - digest generation pipeline.
- `src/lib/comment-tools.ts` - comment tools and advisor tool.
- `src/lib/claude.ts` - Claude wrapper, tool loop, usage logging.
- `netlify/functions/kesha-boss-background.mts` - Telegram webhook, boss commands,
  digest callbacks, comment replies.
- `scripts/setup-boss-webhook.ts` - registers the Telegram webhook and command
  menu.
- `netlify/functions/__tests__/` and `src/lib/__tests__/` - current test suite.

## Current Open Work

- Close June experiment gates using Netlify logs and cost/usefulness evidence.
- Decide whether advisor/tool-use comment replies stay, change, or freeze.
- Keep README/CLAUDE.md in sync when command behavior changes.
