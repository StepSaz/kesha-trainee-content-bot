# Digest Cron Suppression — Design Spec

**Date:** 2026-05-07
**Status:** Approved

---

## Scope

Two related changes:

- **Simplify `/digest` keyboard** — remove 🧪 В тест button; the command always publishes to prod. Callback `digest_test` is removed.
- **Cron suppression** — if a manual `/digest` was published to prod within the last 7 days, the Thursday cron skips that run entirely.

---

## Architecture

### Modified files

```
netlify/functions/kesha-boss-background.mts   — remove digest_test branch, write suppression blob on prod publish
netlify/functions/kesha-post-background.mts   — read suppression blob at startup, skip if within 7 days
```

### New blob key

```
digest-last-manual-at   — { publishedAt: ISO string }
```

Written in `kesha-boss-background.mts` after a successful prod publish. Read in `kesha-post-background.mts` before any work starts.

No new dependencies. No schema changes to memory or any other blob.

---

## `/digest` Keyboard Change

### Before

```
[ 🧪 В тест ] [ 📢 В прод ] [ ❌ Отмена ]
```

Callbacks: `digest_test`, `digest_prod`, `digest_cancel`

### After

```
[ ✅ Опубликовать ] [ ❌ Отмена ]
```

Callbacks: `digest_prod`, `digest_cancel`

`handleDigestCallback` drops the `digest_test` branch entirely. `targetChatId` is always `TELEGRAM_CHAT_ID`. The label in the confirmation message changes from "тест"/"прод" to just "канал".

---

## Suppression Blob Write

In `handleDigestCallback`, after `sendToChannel` succeeds and `data === 'digest_prod'`, before the memory/intros update:

```typescript
await store.setJSON('digest-last-manual-at', { publishedAt: new Date().toISOString() });
```

If `sendToChannel` fails, the blob is not written (no suppression for failed sends).

---

## Cron Skip Logic

In `kesha-post-background.mts`, immediately after the `KESHA_ENABLED` check:

```typescript
const lastManual = await store.get('digest-last-manual-at', { type: 'json' }) as { publishedAt: string } | null;
if (lastManual) {
  const age = Date.now() - new Date(lastManual.publishedAt).getTime();
  if (age < 7 * 24 * 60 * 60 * 1000) {
    console.log(`[kesha-post] skipping cron — manual digest published ${Math.round(age / 3600000)}h ago`);
    return new Response('skipped (manual digest)', { status: 200 });
  }
}
```

The check happens before `latest-result` is written, so a skipped run leaves no trace in `latest-result`. The log line is the only record.

---

## Error Handling

- Blob read fails → treat as "no manual digest" (do not suppress). Log the error, continue with cron.
- Blob write fails after successful send → log error, do not throw (send already succeeded).

---

## Out of Scope

- Resetting the suppression blob manually (can be done via Netlify blob explorer if needed)
- Notifying Stepan that the cron was suppressed (log only)
- Configurable suppression window (hardcoded 7 days)
