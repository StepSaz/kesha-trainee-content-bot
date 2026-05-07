# Notes Command & Command Menu — Design Spec

**Date:** 2026-05-07
**Status:** Approved

---

## Scope

Two related changes:

- **Command menu** — register `/digest` and `/notes` in Telegram's bot command list via `setMyCommands`
- **`/notes` feature** — user attaches an `.md` file with caption `/notes`; bot generates a Kesha-style post from the notes and shows a preview with approve/cancel buttons

---

## Command Menu

`scripts/setup-boss-webhook.ts` is updated to register three commands:

```
/boss    — Опубликовать пост (только для начальника)
/digest  — Сгенерировать дайджест
/notes   — Пост из митинг нотсов / стрима
```

The script must be re-run once after deploy with `TELEGRAM_BOT_TOKEN` and `NETLIFY_SITE_URL` set. No code changes to the webhook or background function.

---

## Architecture

### New files

```
src/config/notes-persona.txt     — Claude prompt: convert raw notes to Kesha post
```

### Modified files

```
netlify/functions/kesha-boss-background.mts   — TelegramMessage extension, handleNotes, router
scripts/setup-boss-webhook.ts                 — setMyCommands: add /digest and /notes
```

### No new dependencies, no new blob keys, no new callback handlers

The existing `PendingPreview` blob shape and `handleCallback` (confirm/cancel) are reused without changes.

---

## Trigger

Stepan attaches an `.md` file and types `/notes` as the caption — one message, no state required.

Router addition in `export default`:

```typescript
} else if (msg?.caption?.startsWith('/notes') && msg.document) {
  await handleNotes(msg);
}
```

Priority order (full updated router):
1. `callback_query` with `digest_` prefix → `handleDigestCallback`
2. `callback_query` → `handleCallback`
3. `/digest` text → `handleDigest`
4. `/boss` text → `handleCommand`
5. `/notes` caption + document → `handleNotes`
6. `/notes` text without document → send usage hint: "Прикрепи .md файл и напиши /notes в подписи к нему"
7. reply from Stepan → `handleCommentReply`

Case 6 handles the common scenario where Stepan taps `/notes` in the command menu (Telegram sends it as a plain text message with no attachment).

---

## TelegramMessage Interface Extension

```typescript
interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  reply_to_message?: { message_id: number; text?: string };
}
```

---

## handleNotes Flow

```
1. Auth: allowed_user_ids check → reject if not allowed
2. Send progress: "📝 Читаю нотсы..."  (save progressMessageId)
3. Validate document: file_name ends with .md (case-insensitive)
4. getFile(file_id) → file_path from Telegram API
5. Download file content: GET https://api.telegram.org/file/bot{TOKEN}/{file_path}
6. Size guard: content > 50 000 chars → reject with message
7. callClaude(notes-persona.txt, content) → generatedPost
8. Validate generatedPost (no em-dash, no markdown, non-empty)
9. Save PendingPreview blob: { userId, chatId, previewMessageId, finalText, channelId, createdAt }
10. editMessage(progressMessageId, "👀 Готово. Превью ниже — подтверди публикацию.")
11. sendMessage(chatId, generatedPost, { replyMarkup: confirm/cancel keyboard })
```

Error handling mirrors `/boss`:
- `getFile` failure → edit progress message with error
- Download failure → edit progress message with error
- Claude returns empty/invalid → edit progress message with error
- All errors logged via `console.error('[notes]')`

---

## File Download

Telegram `getFile` returns a `file_path`. The actual file is downloaded from:

```
https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}
```

No new npm dependencies — `fetch` is available in Node 22.

---

## notes-persona.txt Prompt

Kesha's task: read raw meeting/stream notes and write a Kesha-style post for the channel.

Key constraints:
- All facts, names, numbers, quotes must come only from the notes — no additions
- Structure: дисклеймер (`Я МАЛЕНЬКИЙ БОТ...`) + `Кеша на проводе 🐤` + `~ ~ ~` sections + sign-off with 🐤
- Plain text only, no em-dash, no markdown
- Length: up to 2500 characters; condense if notes are longer, don't pad if shorter
- Attribution: reference the source naturally ("Босс провёл стрим", "На встрече обсудили") using context from the notes themselves — do not invent framing
- Tone: Kesha as a diligent intern summarizing for the channel audience — engaged, lightly self-deprecating, not dry

---

## Validation

Reuse the existing `validateBossPost` from `src/lib/validator.ts`:
- No em-dash (`—`)
- No markdown (`**`, `##`, ` ``` `)
- Length ≤ 4096 characters

No retry loop — if validation fails, report error to Stepan. Notes-to-post is a single Claude call (Sonnet, temp 0.7, max_tokens 2048).

---

## Config

No changes to `pipeline.json`. The notes command uses the same `allowed_user_ids` from `boss_command` config (read via `readBossConfig()`).

Model: `claude-sonnet-4-6`, temperature `0.7`, max_tokens `2048` — hardcoded in `handleNotes`, consistent with rewrite step in boss-pipeline.

---

## Out of Scope

- Multiple file support (one `.md` per `/notes` invocation)
- Non-markdown file formats (PDF, DOCX)
- Editing the generated post before publish
- Storing notes history
- Retry loop on validation failure
