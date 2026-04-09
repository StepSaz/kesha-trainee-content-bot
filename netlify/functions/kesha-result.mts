import type { Config } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

interface StoredResult {
  status: 'running' | 'ok' | 'failed' | 'error';
  startedAt?: string;
  finishedAt?: string;
  mode?: string;
  channel?: string;
  // pipeline-specific
  rssContext?: string;
  webContext?: string;
  selectedTopics?: string;
  draft?: string;
  review?: string;
  reviewVerdict?: string;
  rewrote?: boolean;
  // shared
  post?: string;
  errors?: string[];
  timing?: Record<string, number>;
  sendResult?: { success: boolean; messageId?: number; error?: string } | null;
}

function e(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function section(id: string, label: string, badge: string, content: string, open = false): string {
  return `
<details class="section" ${open ? 'open' : ''}>
  <summary><span class="sec-label">${label}</span> <span class="sec-badge">${badge}</span></summary>
  <pre class="sec-body">${content}</pre>
</details>`;
}

function timingRows(timing: Record<string, number>): string {
  return Object.entries(timing)
    .map(([k, v]) => `<tr><td>${k}</td><td class="num">${(v / 1000).toFixed(1)}s</td></tr>`)
    .join('');
}

function renderPage(result: StoredResult | null, secret: string): string {
  const triggerUrlTest = `/.netlify/functions/kesha-test-background?secret=${secret}&mode=pipeline&channel=test`;
  const triggerUrlMain = `/.netlify/functions/kesha-test-background?secret=${secret}&mode=pipeline&channel=main`;

  let statusBadge = '<span class="badge grey">нет данных</span>';
  let sections = '';
  let timingHtml = '';

  if (!result) {
    sections = '<p class="hint">Нажми кнопку запуска, подожди 1-2 минуты, обнови страницу.</p>';
  } else if (result.status === 'running') {
    statusBadge = '<span class="badge yellow">⏳ генерирует…</span>';
    sections = `<p class="hint">Началось в ${result.startedAt ?? ''}. Страница обновится автоматически.</p>
<script>setTimeout(()=>location.reload(),15000);</script>`;
  } else {
    if (result.status === 'ok') {
      statusBadge = '<span class="badge green">✅ готово</span>';
    } else {
      statusBadge = '<span class="badge red">❌ ошибка</span>';
    }

    // Errors
    if (result.errors?.length) {
      sections += `<div class="error-box">${result.errors.map(err => `<div>${e(err)}</div>`).join('')}</div>`;
    }

    // Pipeline debug sections
    if (result.mode !== 'managed') {
      const rssLines = result.rssContext ? result.rssContext.split('\n').length : 0;
      const webLines = result.webContext ? result.webContext.split('\n').length : 0;

      sections += section('rss', '📡 RSS контекст', `${rssLines} строк`,
        e(result.rssContext ?? '(пусто)'));

      sections += section('web', '🌐 Web поиск', `${webLines} строк`,
        e(result.webContext ?? '(пусто)'));

      sections += section('topics', '🎯 Выбранные темы', '',
        e(result.selectedTopics ?? '(пусто)'), true);

      const reviewVerdict = result.reviewVerdict ?? '';
      const reviewBadge = reviewVerdict.toLowerCase().startsWith('хорошо')
        ? '✅ хорошо — перезапись пропущена'
        : result.rewrote
          ? `⚠️ "${e(reviewVerdict)}" — перезаписан`
          : `⚠️ "${e(reviewVerdict)}"`;

      sections += section('draft', '✏️ Черновик', '',
        e(result.draft ?? '(пусто)'));

      sections += section('review', '👁️ Ревью редактора', reviewBadge,
        e(result.review ?? '(пусто)'), true);
    }

    // Final post
    if (result.post) {
      const sent = result.sendResult?.success
        ? '✅ отправлено в Telegram'
        : result.sendResult
          ? `❌ не отправлено: ${e(result.sendResult.error ?? '')}`
          : '— не отправлялось';
      sections += `
<details class="section post-section" open>
  <summary><span class="sec-label">📨 Финальный пост</span> <span class="sec-badge">${sent}</span></summary>
  <div class="post-body">${e(result.post).replace(/\n/g, '<br>')}</div>
</details>`;
    }

    // Timing
    if (result.timing) {
      const total = Object.values(result.timing).reduce((a, b) => a + b, 0);
      timingHtml = `
<table class="timing">
  <thead><tr><th>шаг</th><th>время</th></tr></thead>
  <tbody>${timingRows(result.timing)}<tr class="total"><td>итого</td><td class="num">${(total / 1000).toFixed(1)}s</td></tr></tbody>
</table>`;
    }
  }

  const finishedAt = result?.finishedAt
    ? `<span class="meta">завершено: ${result.finishedAt}</span>`
    : result?.startedAt
      ? `<span class="meta">начато: ${result.startedAt}</span>`
      : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Кеша — тест</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f0f2f5;min-height:100vh;padding:24px 16px}
.card{background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.08);padding:24px;max-width:780px;margin:0 auto}
h1{font-size:1.3rem;margin-bottom:3px}
.subtitle{color:#888;font-size:.8rem;margin-bottom:16px}
.status-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.badge{border-radius:8px;padding:3px 11px;font-size:.82rem;font-weight:700}
.badge.green{background:#e6f4ea;color:#1a7f3c}
.badge.yellow{background:#fff8e1;color:#b45309}
.badge.red{background:#fce8e6;color:#c62828}
.badge.grey{background:#f1f3f4;color:#5f6368}
.meta{color:#aaa;font-size:.78rem}
.hint{color:#666;font-size:.88rem;margin-bottom:16px}
.error-box{background:#fce8e6;border-radius:8px;padding:12px 16px;font-size:.82rem;color:#b71c1c;margin-bottom:14px;word-break:break-word}
.section{border:1px solid #e8eaed;border-radius:10px;margin-bottom:10px;overflow:hidden}
.section summary{cursor:pointer;padding:10px 14px;background:#f8f9fa;display:flex;align-items:center;gap:8px;user-select:none;list-style:none}
.section summary::-webkit-details-marker{display:none}
.section[open] summary{border-bottom:1px solid #e8eaed}
.sec-label{font-weight:600;font-size:.88rem}
.sec-badge{color:#555;font-size:.78rem;margin-left:auto}
.sec-body{padding:12px 14px;font-size:.78rem;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow-y:auto;color:#333;background:#fff}
.post-section .post-body{padding:14px 16px;line-height:1.65;font-size:.9rem;background:#f7fbff;border-left:4px solid #229ed9;word-break:break-word}
.timing{border-collapse:collapse;font-size:.78rem;color:#555;margin-top:14px;width:100%}
.timing th{text-align:left;padding:4px 10px;border-bottom:1px solid #e8eaed;color:#888;font-weight:600}
.timing td{padding:3px 10px}
.timing tr.total td{font-weight:700;border-top:1px solid #e8eaed;color:#333}
.num{text-align:right;font-variant-numeric:tabular-nums}
.actions{margin-top:18px;display:flex;gap:10px;flex-wrap:wrap}
.btn{border:none;border-radius:10px;padding:9px 20px;font-size:.9rem;font-weight:600;cursor:pointer}
.btn.primary{background:#229ed9;color:#fff}
.btn.primary:hover{background:#1a86bb}
.btn.primary:disabled{background:#a0c4dc;cursor:not-allowed}
.btn.secondary{background:#f1f3f4;color:#333;text-decoration:none;display:inline-flex;align-items:center}
.btn.secondary:hover{background:#e2e5e9}
.btn.prod{background:#e8f5e9;color:#1b5e20;border:1.5px solid #a5d6a7}
.btn.prod:hover{background:#c8e6c9}
.btn.prod:disabled{background:#e8f5e9;color:#aaa;border-color:#ddd;cursor:not-allowed}
</style>
</head>
<body>
<div class="card">
  <h1>🐤 Кеша — тест поста</h1>
  <p class="subtitle">mode: ${result?.mode ?? '—'} · pipeline debug</p>
  <div class="status-row">${statusBadge} ${finishedAt}</div>
  ${sections}
  ${timingHtml}
  <div class="actions">
    <button class="btn primary" id="btn-test" onclick="runKesha('test')">▶ Тест</button>
    <button class="btn prod" id="btn-main" onclick="runKesha('main')">🚀 В прод</button>
    <a class="btn secondary" href="?secret=${secret}">↻ Обновить</a>
  </div>
</div>
<script>
const URLS = { test: '${triggerUrlTest}', main: '${triggerUrlMain}' };
async function runKesha(channel) {
  const btn = document.getElementById('btn-' + channel);
  const other = document.getElementById(channel === 'test' ? 'btn-main' : 'btn-test');
  btn.disabled = true;
  other.disabled = true;
  btn.textContent = '⏳ запущено…';
  try {
    const r = await fetch(URLS[channel]);
    if (r.status === 401) { btn.textContent = '❌ неверный секрет'; btn.disabled = false; other.disabled = false; return; }
    btn.textContent = '✅ запущено, жди 1-2 мин';
    setTimeout(() => location.reload(), 90000);
  } catch(err) {
    btn.textContent = '❌ ошибка сети';
    btn.disabled = false;
    other.disabled = false;
  }
}
</script>
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
  const result = await store.get('latest-result', { type: 'json' }) as StoredResult | null;

  return new Response(renderPage(result, secret), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
};

export const config: Config = {};
