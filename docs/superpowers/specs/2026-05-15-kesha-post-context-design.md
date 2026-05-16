# Kesha: Post Context in Comment Replies

**Status:** Design approved 2026-05-15. Implementation pending.
**Type:** Experiment — tool-use agentic loop (Option C, not deterministic).

## Problem

When the boss posts to the @psyreq channel and a reader tags Kesha in comments
under that post, Kesha currently only sees `reply_to_message.text`. For posts
that contain images, captions, or links, this fallback returns
`'[текст поста недоступен]'` and Kesha responds without understanding what the
post was about.

Source of the bug: [netlify/functions/kesha-boss-background.mts:467](netlify/functions/kesha-boss-background.mts:467).

## Scope

In scope:
- Single-image posts (one photo + caption) — Kesha can see the image via vision
- URLs in post text/caption — Kesha can fetch their content via Tavily
- Media groups (2+ photos in one post) — Kesha sees only one image and
  **must honestly say so** if asked about the rest. No hallucinations.

Out of scope:
- Buffering full media groups (would require storing every channel auto-forward
  in Blobs keyed by `media_group_id`)
- Video / GIF / video notes content analysis (Kesha gets only the caption,
  acknowledges "there's a video" without analyzing)
- Telegram link preview content (the `link_preview_options` field is ignored;
  URL extraction is sufficient)

## Approach: Tool Use (agentic loop)

Kesha decides at runtime whether to look at the image or extract a URL. The bot
is given two tools and an initial prompt with metadata about what's available.
Cost is ~3× vs deterministic prefetch; latency ~2-3×. Treated as an experiment
to evaluate whether agentic decision-making improves comment quality.

### Tools

```
extract_url(url: string) → string
  Calls Tavily Extract API. Returns first ~3000 chars of main article text.
  On failure / non-2xx / timeout (>10s): returns "не смог открыть ссылку: {host}".

view_image() → image
  Returns the photo from reply_to_message.photo[] as an image content block
  (base64-encoded, with detected media type) in the tool_result.
  If no photo present: returns text "под комментом нет картинки".
  May be called at most once per loop — second call returns
  "уже смотрел эту картинку" without re-uploading bytes.
```

### Loop

1. Webhook receives a comment in a discussion thread, mention check passes.
2. Gather post metadata from `reply_to_message`:
   - `text` or `caption` (whichever is present)
   - Whether `photo[]` is present
   - Whether `media_group_id` is present (signals partial visibility)
   - HTTPS URLs from `entities` + `caption_entities` of type `url` or `text_link`
3. Build initial user message containing metadata (NOT raw bytes), e.g.:
   ```
   Контекст поста: {caption or text or '[без текста]'}
   В посте: {фото есть/нет} {если media_group — "это часть медиагруппы, видишь только одну картинку"}
   Ссылки в посте: [url1, url2]  (если есть)

   Комментарий {userName}: "{user text}"
   {intent instruction based on parseCommentIntent}

   Доступные инструменты: view_image, extract_url. Используй только если контент нужен для ответа.
   ```
4. Call `callClaudeWithTools` (new function in `src/lib/claude.ts`):
   - Send to Haiku 4.5 with tool definitions.
   - If `stop_reason === 'tool_use'`: execute tool(s), send `tool_result` back, loop.
   - If `stop_reason === 'end_turn'`: return final text.
   - Hard cap: **3 iterations**. On exceeding: final call with `tools: undefined`
     so Claude is forced to answer.
5. Reply to reader's message with the final text.

### History

In Blobs (`comment-history:${chatId}:${threadId}:user:${userId}`) we store only
final turns:
- `{ role: 'user', content: userMessage }` (the initial composed message,
  NOT tool roundtrips)
- `{ role: 'assistant', content: finalText }`

Tool calls and tool results are NOT persisted. Trade-off: if reader follow-ups
require the same URL, Kesha re-fetches. Accepted cost of the experiment.

## Components

### New files

- `src/lib/comment-tools.ts` — tool definitions (Anthropic `ToolDef[]`) and
  pure executor functions `executeExtractUrl(url)` and `executeViewImage(photo)`.
  Includes a top comment marking this as the experiment entry point.

### Modified files

- `src/lib/tavily.ts` — add `tavilyExtract(url: string): Promise<string>` that
  calls `POST https://api.tavily.com/extract`. Returns raw content trimmed to
  3000 chars. Logs at info level; on error returns empty string and caller
  formats the user-facing fallback.

- `src/lib/telegram.ts` — add `getFileAsBase64(fileId: string):
  Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }>`.
  Uses `getFile` to resolve `file_path`, then downloads from
  `https://api.telegram.org/file/bot{token}/{file_path}`. Media type derived
  from file extension; defaults to `image/jpeg`. 8s timeout.

- `src/lib/claude.ts` — add `callClaudeWithTools(params)`. Wraps the existing
  Anthropic SDK call with an iteration loop that processes `tool_use` blocks
  via a provided `executeTool(name, input)` callback. Caps iterations at a
  passed-in `maxIterations` (boss handler passes 3). One-line comment at the
  top of the function marks the experiment.

- `netlify/functions/kesha-boss-background.mts`:
  - Extend `TelegramMessage` interface and `reply_to_message` field with
    `caption?`, `caption_entities?`, `entities?`, `photo?: PhotoSize[]`,
    `media_group_id?`.
  - Rewrite `handleCommentReply` to use the tool loop instead of a single
    `callClaude` invocation.
  - Keep all existing pre-checks (per-user rate, per-thread rate, mute, history
    loading) untouched.

- `CLAUDE.md` — add `## Эксперименты` section noting the start date, the
  approach, cost multiplier, and the "review after one month" exit condition.

## Error handling

| Source | Behavior |
|---|---|
| Tavily 5xx / timeout >10s | Tool returns `"не смог открыть ссылку: {host}"`. Loop continues. |
| `getFile` 4xx/5xx | `view_image` returns `"не смог скачать картинку"`. Loop continues. |
| Anthropic API error | Caught at handler level; reader receives `"что-то я завис, попробуй ещё раз 🐤"`. Existing pattern. |
| Loop exceeds 3 iterations | Final retry call with `tools: undefined`. Forces an answer from what's already in context. |
| `view_image` called when no photo | Tool returns `"под комментом нет картинки"`. |
| `view_image` called twice in one loop | Second call returns `"уже смотрел эту картинку"` to prevent duplicate base64 upload. |
| URL is not `https://` | Skipped at metadata-collection stage. Not surfaced to Claude. |

## Edge cases

1. **Media group:** `reply_to_message.media_group_id` present → metadata line
   states `"это часть медиагруппы — ты видишь только одну картинку"`. Kesha is
   instructed (in the system prompt addition) to say so honestly if the reader
   asks about the rest.
2. **Text-only post (no caption, no photo):** metadata says `"подпись
   отсутствует, только картинка"` — Claude likely calls `view_image`.
3. **Long post text (>4000 chars):** Telegram caps it anyway; pass through.
4. **Many URLs (5+):** All passed in metadata. System prompt instructs Claude
   to call `extract_url` only when the reader explicitly asks about a link.
   Hard cap of 3 loop iterations bounds the worst case.
5. **Repeat URL extraction:** A per-loop `Map<string, string>` caches
   `extract_url` results inside one comment response so a repeated call returns
   the cached value without re-hitting Tavily.
6. **`reply_to_message` absent** (reader tagged Kesha not as a reply): existing
   fallback `'[текст поста недоступен]'` is kept. Tools are **not** offered in
   this case (`tools: undefined`).
7. **Bot / channel taggers:** Already filtered by the per-user rate limit. No
   change.

## Limits

- Tool loop iterations: **3** max per comment.
- `view_image` calls: **1** per loop.
- `extract_url` content size: trimmed to **3000 chars**.
- `max_tokens` on final answer: **300** (unchanged).
- External timeouts: Tavily **10s**, Telegram `getFile` **8s**.

## Cost

- Haiku 4.5: $1/MTok input, $5/MTok output.
- Deterministic equivalent (single pass): ~$0.005-0.007 per comment.
- Tool-use loop (this design): ~$0.012-0.020 per comment (~3× more, ~2-3×
  slower).
- At current traffic (~50 comments/week): expected ~$0.50-1/week.
- Hard budget alarm (manual): if log inspection shows >$5/week, treat as
  spam or Kesha looping. Monitoring instrumentation is out of scope for v1;
  rely on counters in existing log lines.

## Experiment evaluation (review at 2026-06-15)

Two signals, both qualitative:

1. **Tool call utility ratio** — manually inspect logs: how often did Kesha
   call a tool, and was the call useful for the answer? Counted via existing
   `console.log` traces.
2. **Reader / boss feedback** — complaints, drop-off, or boss noting Kesha
   feels smarter/dumber.

If neither shows meaningful improvement over what a deterministic prefetch
would have given, revert to Option B (extract URLs and load image
unconditionally before the single Claude call).

## Testing strategy

- **Unit tests** in `src/lib/__tests__/`:
  - `comment-tools.test.ts`: each tool executor with happy path + error cases
    (Tavily 5xx, missing photo, second `view_image` call).
  - `tavily.test.ts`: extend with `tavilyExtract` happy path and error.
  - `telegram.test.ts`: `getFileAsBase64` happy path and 4xx.
- **No new integration test** for the full boss handler loop — existing tests
  cover the surrounding rate-limit / history logic. The tool loop itself is
  unit-tested via `comment-tools.test.ts` and a small `claude.test.ts` case
  that exercises `callClaudeWithTools` with a mocked Anthropic client.

## Out of design (explicitly deferred)

- Persisting tool results across comment turns
- Prompt caching to reduce tool-use cost
- Buffering full media groups
- Video / audio understanding
- Automatic budget monitoring with alerting
