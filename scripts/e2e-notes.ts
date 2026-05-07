import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callClaude } from '../src/lib/claude.js';
import { validateNotes } from '../src/lib/validator.js';

function ok(label: string, detail = '') {
  console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
}
function fail(label: string, detail = '') {
  console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
}
function section(title: string) {
  console.log(`\n── ${title} ──────────────────────`);
}

const SAMPLE_NOTES = `
# Митинг 2026-05-07 — Ревью спринта

Участники: Степан (лид), Наташа (дизайн), Антон (бэкенд)
Продолжительность: 45 минут

## Что сделано за спринт

Антон: завершил рефакторинг API авторизации. Убрали 3 устаревших эндпоинта.
Перешли на JWT с RSA-256 вместо HS256. Время ответа улучшилось с 120мс до 40мс.

Наташа: завершила макеты для мобильного онбординга. 7 экранов, 3 флоу.
Figma-ссылка: https://figma.com/file/abc123/onboarding-v2

## Проблемы

Задержка с интеграцией Stripe — ждём доступ к sandbox от Антона.
Дедлайн по платежам сдвигается на 2 недели: с 20 мая на 3 июня.

## Планы на следующий спринт

1. Антон: Stripe integration (webhook + checkout)
2. Наташа: передаёт макеты в разработку, начинает дашборд
3. Степан: технический долг — обновить зависимости, настроить CI для preview-деплоев

## Следующий митинг

Четверг 14 мая, 15:00 по Варшаве.
`.trim();

async function main() {
  console.log('🐤 E2E test: /notes command (Claude API)\n');

  section('notes-persona.txt — load');
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(join(process.cwd(), 'src/config/notes-persona.txt'), 'utf-8');
    ok('Loaded persona prompt', `${systemPrompt.length} chars`);
  } catch (err) {
    fail('Failed to load persona prompt', String(err));
    process.exit(1);
  }

  section('Claude call (claude-sonnet-4-6, ~10-30s)');
  const t0 = Date.now();
  let post: string | null;
  try {
    post = await callClaude({
      systemPrompt,
      userMessage: SAMPLE_NOTES,
      model: 'claude-sonnet-4-6',
      temperature: 0.7,
      maxTokens: 2048,
    });
  } catch (err) {
    fail('callClaude threw', String(err));
    process.exit(1);
  }
  ok(`Claude responded in ${Date.now() - t0}ms`);

  if (!post) {
    fail('Claude returned empty response');
    process.exit(1);
  }
  ok('Non-empty response', `${post.length} chars`);

  section('validateStream');
  const result = validateNotes(post);
  if (result.valid) {
    ok('Validation passed');
  } else {
    fail('Validation failed', result.errors.join(', '));
  }

  console.log('\n' + '─'.repeat(60));
  console.log('GENERATED POST:');
  console.log('─'.repeat(60));
  console.log(post);
  console.log('─'.repeat(60));

  if (!result.valid) process.exit(1);
  console.log('\n🐤 E2E notes done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
