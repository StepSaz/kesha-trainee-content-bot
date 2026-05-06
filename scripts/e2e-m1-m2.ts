import { fetchSourceContext } from '../src/lib/sources.js';
import { generatePipelinePost } from '../src/lib/pipeline.js';
import { validatePost } from '../src/lib/validator.js';
import { findHallucinated } from '../src/lib/url-checker.js';

function ok(label: string, detail = '') {
  console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
}
function fail(label: string, detail = '') {
  console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
}
function section(title: string) {
  console.log(`\n── ${title} ──────────────────────`);
}

async function main() {
  console.log('🐤 E2E test: M1 + M2 (no Telegram send)\n');

  // ── 1. Sources (M2) ──────────────────────────────────────────────────────
  section('M2: sources');
  const t0 = Date.now();
  let hnContext = '';
  let webContext = '';
  let sourceItemCount = 0;
  try {
    const { context, itemCount } = await fetchSourceContext();
    hnContext = context;
    sourceItemCount = itemCount;
    ok(`fetchSourceContext`, `${itemCount} items in ${Date.now() - t0}ms`);
    console.log('    preview:', context.slice(0, 300).replace(/\n/g, ' '));
  } catch (err) {
    fail('fetchSourceContext', String(err));
    process.exit(1);
  }

  // ── 2. url-checker (M2) ──────────────────────────────────────────────────
  section('M2: url-checker');
  const badPost = 'Читай на https://real-source.com/news и https://fake-hallucinated.example.com/story';
  const ctx = 'Context: https://real-source.com/news mentioned here';
  const hal = findHallucinated(badPost, [ctx]);
  if (hal.urls.length === 1 && hal.urls[0] === 'https://fake-hallucinated.example.com/story') {
    ok('findHallucinated', `caught: ${hal.urls[0]}`);
  } else {
    fail('findHallucinated', JSON.stringify(hal));
  }
  const clean = findHallucinated('Check https://real-source.com/news', [ctx]);
  if (clean.urls.length === 0) {
    ok('findHallucinated — no false positives');
  } else {
    fail('findHallucinated false positive', JSON.stringify(clean));
  }

  // ── 3. validator composable rules (M1) ───────────────────────────────────
  section('M1: validator');
  const body = 'Хорошая новость из Anthropic - компания выпустила обновление своей языковой модели. Специалисты отмечают улучшение качества ответов и снижение количества ошибок. Это важный шаг для индустрии.';
  const validPost = [
    'Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ. Не бейте.',
    '',
    'Кеша на проводе',
    '',
    `Статья раз: ${body}`,
    '📎 источник: https://example.com/1',
    '',
    '~ ~ ~',
    '',
    `Статья два: OpenAI обновила свои модели - производительность выросла на 30%. ${body}`,
    '📎 источник: https://example.com/2',
    '',
    '~ ~ ~',
    '',
    `Статья три: Google AI выпустила новый инструмент для разработчиков. ${body}`,
    '📎 источник: https://example.com/3',
    '',
    '~ ~ ~',
    '',
    'Ваш стажер-Кеша 🐤',
  ].join('\n');
  const v1 = validatePost(validPost);
  if (v1.valid) {
    ok('validatePost (valid post)');
  } else {
    fail('validatePost (valid post)', v1.errors.join(', '));
  }
  const emPost = validPost.replace('🐤', '🐤').replace('—', '—') + ' — em dash';
  const v2 = validatePost(emPost);
  if (!v2.valid && v2.errors.some(e => e.includes('em-dash'))) {
    ok('validatePost rejects em-dash');
  } else {
    fail('validatePost em-dash check', v2.errors.join(', '));
  }
  const shortPost = '🐤 Кеша говорит.';
  const v3 = validatePost(shortPost);
  if (!v3.valid && v3.errors.length > 0) {
    ok('validatePost rejects invalid post', v3.errors.slice(0, 2).join('; '));
  } else {
    fail('validatePost invalid post not caught');
  }

  // ── 4. Full pipeline (M1 + M2) — real Claude API ─────────────────────────
  section('M1+M2: full pipeline (Claude API)');
  console.log('  Running generatePipelinePost… (60-120s, costs ~$0.5)\n');
  const t1 = Date.now();
  let result;
  try {
    result = await generatePipelinePost();
  } catch (err) {
    fail('generatePipelinePost threw', String(err));
    process.exit(1);
  }
  const elapsed = ((Date.now() - t1) / 1000).toFixed(1);

  console.log(`  timing: ${elapsed}s total`);
  Object.entries(result.timing).forEach(([k, v]) => {
    console.log(`    ${k}: ${(v / 1000).toFixed(1)}s`);
  });

  console.log(`\n  selectedTopics: ${result.selectedTopics.topics.length} topics, sparseWeek=${result.selectedTopics.sparseWeek}`);
  result.selectedTopics.topics.forEach((t, i) => {
    console.log(`    ${i + 1}. [T${t.tier}] ${t.title} (${t.sourceOrigin})`);
  });

  console.log(`\n  review verdict: ${result.review.verdict}`);
  if (result.review.notes.length > 0) {
    result.review.notes.forEach(n => console.log(`    - ${n.issue}`));
  }

  if (result.success && result.post) {
    ok('pipeline success');
    const postLen = result.post.length;
    console.log(`\n  post length: ${postLen} chars`);

    // Verify hallucination check was applied
    const urlsInPost = (result.post.match(/https?:\/\/[^\s)]+/g) ?? []);
    const allContext = result.hnContext + ' ' + result.webContext;
    const halResult = findHallucinated(result.post, [result.hnContext, result.webContext]);
    if (halResult.urls.length === 0) {
      ok('no hallucinated URLs in final post', `${urlsInPost.length} URLs checked`);
    } else {
      fail('hallucinated URLs found in post', halResult.urls.join(', '));
    }

    // Structural validation
    const finalValidation = validatePost(result.post);
    if (finalValidation.valid) {
      ok('final post passes validation');
    } else {
      fail('final post fails validation', finalValidation.errors.join(', '));
    }

    console.log('\n' + '─'.repeat(60));
    console.log('FINAL POST:');
    console.log('─'.repeat(60));
    console.log(result.post);
    console.log('─'.repeat(60));
  } else {
    fail('pipeline failed', (result.errors ?? []).join(', '));
  }

  console.log('\n🐤 E2E done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
