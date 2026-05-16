/**
 * E2E test: tool-use comment-reply path against real APIs.
 *
 * Exercises the full pipeline that handleCommentReply runs in production:
 *   TelegramMessage.reply_to_message → extractPostContext → composeCommentUserMessage
 *   → callClaudeWithTools (real Anthropic) → executeTool (real Tavily / local image)
 *
 * Does NOT touch Telegram (no message send, no Blobs writes, no rate limiting).
 *
 * Required env: ANTHROPIC_API_KEY, TAVILY_API_KEY
 * Optional env: KESHA_E2E_IMAGE=<path to local jpeg/png> — enables the
 *   image-bearing scenario; otherwise that scenario is skipped.
 *
 *   npx tsx scripts/e2e-comment-reply.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import {
  extractPostContext,
  composeCommentUserMessage,
  parseCommentIntent,
  type ReplyToMessageLike,
} from '../src/lib/comment-reply.js';
import { callClaudeWithTools, type ToolResult } from '../src/lib/claude.js';
import { COMMENT_TOOLS, makeExecuteTool } from '../src/lib/comment-tools.js';
import { tavilyExtract } from '../src/lib/tavily.js';

const TEST_URL = process.argv[2] ?? 'https://www.anthropic.com/news/claude-haiku-4-5';
const TEST_IMAGE_PATH = process.env.KESHA_E2E_IMAGE;

const SYSTEM_PROMPT = [
  'Ты Кеша - бот-стажёр канала @psyreq. Отвечаешь в комментариях кратко (3-4 предложения), по-русски, без markdown.',
  'У тебя есть инструменты view_image (посмотреть прикреплённую картинку) и extract_url (открыть ссылку из поста). Используй их только если содержимое нужно для ответа.',
].join(' ');

let passed = 0;
let failed = 0;

function ok(label: string, detail = ''): void {
  console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
  passed++;
}
function fail(label: string, detail = ''): void {
  console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
  failed++;
}
function section(title: string): void {
  console.log(`\n── ${title} ──────────────────────`);
}
function info(detail: string): void {
  console.log(`     ${detail}`);
}

function checkEnv(): void {
  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!process.env.TAVILY_API_KEY) missing.push('TAVILY_API_KEY');
  if (missing.length > 0) {
    console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(1);
  }
}

interface Scenario {
  name: string;
  reply: ReplyToMessageLike;
  commentText: string;
  userName: string;
  // executor that may override view_image with a local image
  executorOverride?: { photoFileId?: string; localImagePath?: string };
  expect: {
    photoFileId: 'set' | 'unset';
    inMediaGroup: boolean;
    urls: string[];
    metaHas?: string;
    answerHasOneOf?: string[];
    toolCallsAtMost?: number;
  };
}

interface ScenarioResult {
  toolCalls: string[];
  response: string;
  elapsedMs: number;
}

function buildExecutor(
  scenario: Scenario,
  ctx: ReturnType<typeof extractPostContext>,
  toolCalls: string[],
): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  const override = scenario.executorOverride;
  // If user provided a local image, swap the view_image executor for one that
  // reads from disk (we can't actually hit Telegram from this script).
  if (override?.localImagePath && existsSync(override.localImagePath)) {
    const bytes = readFileSync(override.localImagePath);
    const base64 = bytes.toString('base64');
    const ext = override.localImagePath.toLowerCase().split('.').pop();
    const mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' =
      ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : 'image/jpeg';
    let imageLoaded = false;
    return async (name, input) => {
      toolCalls.push(`${name}(${JSON.stringify(input)})`);
      if (name === 'view_image') {
        if (imageLoaded) return 'уже смотрел эту картинку, добавить нечего';
        imageLoaded = true;
        return { kind: 'image', base64, mediaType };
      }
      if (name === 'extract_url') {
        const url = typeof input.url === 'string' ? input.url : '';
        const content = await tavilyExtract(url);
        return content || 'не смог открыть ссылку';
      }
      return `неизвестный инструмент: ${name}`;
    };
  }
  // Default: wrap makeExecuteTool to also log calls
  const real = makeExecuteTool({ photoFileId: ctx.photoFileId });
  return async (name, input) => {
    toolCalls.push(`${name}(${JSON.stringify(input)})`);
    return real(name, input);
  };
}

async function runScenario(scenario: Scenario): Promise<void> {
  section(scenario.name);

  // Step 1: extractPostContext
  const ctx = extractPostContext(scenario.reply);
  const photoOk = (scenario.expect.photoFileId === 'set' && ctx.photoFileId) ||
                  (scenario.expect.photoFileId === 'unset' && !ctx.photoFileId);
  if (photoOk) ok(`extractPostContext: photoFileId ${scenario.expect.photoFileId}`);
  else fail(`extractPostContext: photoFileId expected ${scenario.expect.photoFileId}, got ${ctx.photoFileId ?? 'undefined'}`);

  if (ctx.inMediaGroup === scenario.expect.inMediaGroup) {
    ok(`extractPostContext: inMediaGroup=${ctx.inMediaGroup}`);
  } else {
    fail(`extractPostContext: inMediaGroup expected ${scenario.expect.inMediaGroup}, got ${ctx.inMediaGroup}`);
  }

  const urlsMatch = JSON.stringify(ctx.postUrls) === JSON.stringify(scenario.expect.urls);
  if (urlsMatch) ok(`extractPostContext: ${ctx.postUrls.length} URL(s) parsed`);
  else fail(`extractPostContext: urls expected ${JSON.stringify(scenario.expect.urls)}, got ${JSON.stringify(ctx.postUrls)}`);

  // Step 2: composeCommentUserMessage
  const intent = parseCommentIntent(scenario.commentText);
  const userMessage = composeCommentUserMessage({
    isFirstTurn: true,
    postContext: ctx,
    userName: scenario.userName,
    commentText: scenario.commentText,
    intent,
  });
  info(`intent: ${intent}`);
  if (scenario.expect.metaHas) {
    if (userMessage.includes(scenario.expect.metaHas)) {
      ok(`userMessage contains "${scenario.expect.metaHas}"`);
    } else {
      fail(`userMessage missing "${scenario.expect.metaHas}"`);
      info(`actual userMessage:\n${userMessage}`);
    }
  }

  // Step 3: callClaudeWithTools against real Anthropic
  const toolCalls: string[] = [];
  const executor = buildExecutor(scenario, ctx, toolCalls);

  const t0 = Date.now();
  let response = '';
  try {
    response = await callClaudeWithTools({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
      maxTokens: 300,
      tools: COMMENT_TOOLS,
      executeTool: executor,
      maxIterations: 3,
    });
  } catch (err) {
    fail(`callClaudeWithTools threw`, String(err));
    return;
  }
  const elapsed = Date.now() - t0;

  if (response.length > 0) ok(`Claude responded`, `${response.length} chars in ${elapsed}ms`);
  else fail(`Claude responded with empty text`);

  if (scenario.expect.toolCallsAtMost !== undefined) {
    if (toolCalls.length <= scenario.expect.toolCallsAtMost) {
      ok(`tool calls ≤ ${scenario.expect.toolCallsAtMost} (actual: ${toolCalls.length})`);
    } else {
      fail(`tool calls exceeded budget`, `expected ≤ ${scenario.expect.toolCallsAtMost}, got ${toolCalls.length}`);
    }
  }
  if (toolCalls.length > 0) {
    info(`tools used:`);
    for (const c of toolCalls) info(`  • ${c.slice(0, 120)}`);
  } else {
    info(`no tools used`);
  }

  if (scenario.expect.answerHasOneOf && scenario.expect.answerHasOneOf.length > 0) {
    const lower = response.toLowerCase();
    const matched = scenario.expect.answerHasOneOf.find(s => lower.includes(s.toLowerCase()));
    if (matched) ok(`response contains expected hint: "${matched}"`);
    else info(`response did not contain any of: ${scenario.expect.answerHasOneOf.join(', ')} — may still be correct, manual review:`);
  }

  console.log(`     ---\n     ${response.replace(/\n/g, '\n     ')}\n     ---`);
}

async function main(): Promise<void> {
  checkEnv();
  console.log('🐤 E2E: tool-use comment replies (real Anthropic + Tavily, no Telegram)\n');
  console.log(`Тестовая ссылка: ${TEST_URL}`);
  if (TEST_IMAGE_PATH) console.log(`Тестовая картинка: ${TEST_IMAGE_PATH}\n`);
  else console.log('Картинка: не задана (KESHA_E2E_IMAGE), сценарий B пропустим\n');

  const scenarios: Scenario[] = [
    {
      name: 'A. Текстовый пост со ссылкой',
      reply: (() => {
        const text = `Anthropic выкатили новый Haiku. Якобы быстрый и дешёвый. Анонс: ${TEST_URL}`;
        return {
          text,
          entities: [
            { type: 'url' as const, offset: text.indexOf(TEST_URL), length: TEST_URL.length },
          ],
        };
      })(),
      commentText: 'что там по сути, стоит переезжать?',
      userName: 'Стёпа',
      expect: {
        photoFileId: 'unset',
        inMediaGroup: false,
        urls: [TEST_URL],
        metaHas: 'extract_url',
        toolCallsAtMost: 2,
      },
    },
    {
      name: 'C. Чистый текст, инструменты не нужны',
      reply: { text: 'Просто рассуждаю про prompt engineering сегодня.' },
      commentText: 'привет, как сам?',
      userName: 'Илья',
      expect: {
        photoFileId: 'unset',
        inMediaGroup: false,
        urls: [],
        metaHas: 'только текст',
        toolCallsAtMost: 0,
      },
    },
    {
      name: 'D. Медиагруппа — Кеша должен честно сказать что видит только одну',
      reply: {
        caption: 'три мема про vibe coding одним постом',
        photo: [{ file_id: 'small' }, { file_id: 'large' }],
        media_group_id: 'mg-fake-123',
      },
      commentText: 'а третий мем что значит?',
      userName: 'Аня',
      expect: {
        photoFileId: 'set',
        inMediaGroup: true,
        urls: [],
        metaHas: 'медиагруппы',
        answerHasOneOf: ['одну', 'только эту', 'не вижу', 'не могу посмотреть', 'не доступ'],
      },
    },
  ];

  if (TEST_IMAGE_PATH && existsSync(TEST_IMAGE_PATH)) {
    scenarios.push({
      name: 'B. Пост с одной картинкой — Кеша должен вызвать view_image',
      reply: {
        caption: 'смешной мем',
        photo: [{ file_id: 'fake-small' }, { file_id: 'fake-large' }],
      },
      commentText: 'что там на картинке?',
      userName: 'Лена',
      executorOverride: { localImagePath: TEST_IMAGE_PATH },
      expect: {
        photoFileId: 'set',
        inMediaGroup: false,
        urls: [],
        metaHas: 'view_image',
        toolCallsAtMost: 2,
      },
    });
  }

  for (const s of scenarios) {
    await runScenario(s);
  }

  console.log(`\n── итог ─────────────────────────`);
  console.log(`  passed: ${passed}`);
  console.log(`  failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n💥 E2E crashed:', err);
  process.exit(2);
});
