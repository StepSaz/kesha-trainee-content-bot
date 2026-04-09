import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

interface Result {
  status: 'running' | 'ok' | 'failed' | 'error';
  startedAt?: string;
  finishedAt?: string;
  mode?: string;
  post?: string;
  errors?: string[];
  timing?: Record<string, number>;
  sendResult?: { success: boolean; messageId?: number; error?: string } | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderPost(post: string): string {
  return escapeHtml(post).replace(/\n/g, '<br>');
}

function timingTable(timing: Record<string, number>): string {
  const rows = Object.entries(timing)
    .map(([k, v]) => `<tr><td>${k}</td><td>${(v / 1000).toFixed(1)}s</td></tr>`)
    .join('');
  return `<table class="timing"><tbody>${rows}</tbody></table>`;
}

function renderPage(result: Result | null, secret: string): string {
  const triggerUrl = `/.netlify/functions/kesha-test-background?secret=${secret}&mode=pipeline&channel=test`;

  let statusBadge = '';
  let body = '';

  if (!result) {
    statusBadge = '<span class="badge grey">нет данных</span>';
    body = '<p class="hint">Нажми «Запустить тест», подожди 1-2 минуты, обнови страницу.</p>';
  } else if (result.status === 'running') {
    statusBadge = '<span class="badge yellow">⏳ генерирует...</span>';
    body = `<p class="hint">Началось в ${result.startedAt ?? ''}. Обнови страницу через минуту.</p>
    <script>setTimeout(()=>location.reload(), 15000);</script>`;
  } else if (result.status === 'ok' && result.post) {
    const sent = result.sendResult?.success ? '✅ отправлено в Telegram' : '⚠️ не отправлено в Telegram';
    statusBadge = `<span class="badge green">✅ готово</span> <span class="meta">${sent}</span>`;
    body = `
      <div class="post">${renderPost(result.post)}</div>
      ${result.timing ? timingTable(result.timing) : ''}
    `;
  } else {
    statusBadge = '<span class="badge red">❌ ошибка</span>';
    const errs = (result.errors ?? []).map(e => `<li>${escapeHtml(e)}</li>`).join('');
    body = `<ul class="errors">${errs}</ul>`;
  }

  const finishedAt = result?.finishedAt
    ? `<span class="meta">завершено: ${result.finishedAt}</span>`
    : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Кеша — тест</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 32px 16px; }
  .card { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.08); padding: 28px; max-width: 640px; width: 100%; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: .875rem; margin-bottom: 20px; }
  .status-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .badge { border-radius: 8px; padding: 4px 12px; font-size: .875rem; font-weight: 600; }
  .badge.green { background: #e6f4ea; color: #1a7f3c; }
  .badge.yellow { background: #fff8e1; color: #b45309; }
  .badge.red { background: #fce8e6; color: #c62828; }
  .badge.grey { background: #f1f3f4; color: #5f6368; }
  .meta { color: #888; font-size: .8rem; }
  .post { background: #f7f8fa; border-left: 4px solid #229ed9; border-radius: 8px; padding: 16px 20px; line-height: 1.6; font-size: .95rem; white-space: pre-wrap; word-break: break-word; margin-bottom: 20px; }
  .hint { color: #555; font-size: .9rem; margin-bottom: 20px; }
  .errors { color: #c62828; font-size: .875rem; padding-left: 20px; margin-bottom: 20px; }
  .timing { border-collapse: collapse; font-size: .8rem; color: #555; margin-top: 8px; }
  .timing td { padding: 2px 12px 2px 0; }
  .btn { display: inline-block; background: #229ed9; color: #fff; border: none; border-radius: 10px; padding: 10px 22px; font-size: .95rem; font-weight: 600; cursor: pointer; text-decoration: none; margin-top: 8px; }
  .btn:hover { background: #1a86bb; }
  .btn.secondary { background: #f1f3f4; color: #333; margin-left: 8px; }
  .btn.secondary:hover { background: #e2e5e9; }
</style>
</head>
<body>
<div class="card">
  <h1>🐤 Кеша — тест поста</h1>
  <p class="subtitle">Последний запуск · mode: ${result?.mode ?? '—'}</p>
  <div class="status-row">${statusBadge} ${finishedAt}</div>
  ${body}
  <div>
    <a class="btn" href="${triggerUrl}" onclick="this.textContent='⏳ запущено…'">▶ Запустить тест</a>
    <a class="btn secondary" href="?secret=${secret}">↻ Обновить</a>
  </div>
</div>
</body>
</html>`;
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? '';

  if (!secret || secret !== process.env.TEST_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const store = getStore('kesha');
  const result = await store.get('latest-result', { type: 'json' }) as Result | null;

  return new Response(renderPage(result, secret), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
};

export const config: Config = {};
