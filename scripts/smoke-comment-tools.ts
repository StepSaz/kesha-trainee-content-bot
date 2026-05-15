/**
 * Smoke test for the tool-use comment-reply experiment.
 *
 * Runs callClaudeWithTools against the real Anthropic API with the real
 * extract_url executor (calls Tavily). view_image is mocked with a hardcoded
 * small image so we don't need Telegram credentials.
 *
 * Required env: ANTHROPIC_API_KEY, TAVILY_API_KEY
 *
 *   npx tsx scripts/smoke-comment-tools.ts
 *
 * Optional: pass a URL as first arg to test extract_url with that URL.
 *   npx tsx scripts/smoke-comment-tools.ts https://www.anthropic.com/news/claude-haiku-4-5
 */
import { readFileSync, existsSync } from 'fs';
import { callClaudeWithTools, type ToolResult } from '../src/lib/claude.js';
import { COMMENT_TOOLS, makeExecuteTool } from '../src/lib/comment-tools.js';
import { tavilyExtract } from '../src/lib/tavily.js';

const TEST_URL = process.argv[2] ?? 'https://www.anthropic.com/news/claude-haiku-4-5';
const TEST_IMAGE_PATH = process.env.KESHA_SMOKE_IMAGE;

function checkEnv(): void {
  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!process.env.TAVILY_API_KEY) missing.push('TAVILY_API_KEY');
  if (missing.length > 0) {
    console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const SYSTEM_PROMPT = [
  'Ты Кеша - бот-стажёр. Отвечаешь в комментариях канала @psyreq, кратко (3-4 предложения), по-русски, без markdown.',
  'У тебя есть инструменты view_image (посмотреть прикреплённую картинку) и extract_url (открыть ссылку из поста).',
  'Используй их только если содержимое реально нужно для ответа.',
].join(' ');

async function scenarioA(): Promise<void> {
  console.log('\n=== Сценарий A: пост со ссылкой, без картинки ===\n');
  const userMessage = [
    'Контекст текущего поста:',
    'Anthropic выкатили новый Haiku. Якобы быстрый и дешёвый.',
    'Тип поста: только текст (картинок нет).',
    `Ссылки в посте: ${TEST_URL}. Если читателю важно узнать, что по конкретной ссылке — вызови extract_url(url).`,
    '',
    'Комментарий Стёпа: "что там по факту в анонсе? стоит ли мне на Haiku 4.5 переезжать?"',
    '',
    'Стёпа написал комментарий к посту. Ответь по делу, в своём стиле стажёра.',
  ].join('\n');

  const executeTool = makeExecuteTool({}); // no photo available
  const t0 = Date.now();
  const response = await callClaudeWithTools({
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    model: 'claude-haiku-4-5-20251001',
    temperature: 0.7,
    maxTokens: 300,
    tools: COMMENT_TOOLS,
    executeTool,
    maxIterations: 3,
  });
  const elapsed = Date.now() - t0;

  console.log(`\n--- Ответ Кеши (${elapsed}ms) ---`);
  console.log(response);
  console.log('-------------------------\n');
}

async function scenarioB(): Promise<void> {
  if (!TEST_IMAGE_PATH || !existsSync(TEST_IMAGE_PATH)) {
    console.log('\n=== Сценарий B: пропущен (нет KESHA_SMOKE_IMAGE с путём к jpeg) ===\n');
    return;
  }
  console.log(`\n=== Сценарий B: пост с картинкой (${TEST_IMAGE_PATH}) ===\n`);

  const imageBytes = readFileSync(TEST_IMAGE_PATH);
  const base64 = imageBytes.toString('base64');
  const ext = TEST_IMAGE_PATH.toLowerCase().split('.').pop();
  const mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' =
    ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : 'image/jpeg';

  let imageLoaded = false;
  const executeTool = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    if (name === 'view_image') {
      if (imageLoaded) return 'уже смотрел эту картинку, добавить нечего';
      imageLoaded = true;
      console.log('[smoke] view_image called → returning local image');
      return { kind: 'image', base64, mediaType };
    }
    if (name === 'extract_url') {
      const url = typeof input.url === 'string' ? input.url : '';
      console.log(`[smoke] extract_url called → ${url}`);
      const content = await tavilyExtract(url);
      return content || 'не смог открыть ссылку';
    }
    return `неизвестный инструмент: ${name}`;
  };

  const userMessage = [
    'Контекст текущего поста:',
    'Очередной мем про vibe coding.',
    'Тип поста: текст с одной картинкой. Чтобы посмотреть её содержимое — вызови view_image().',
    '',
    'Комментарий Аня: "что там на картинке?"',
    '',
    'Аня попросила объяснить. Ответь по делу, в своём стиле стажёра.',
  ].join('\n');

  const t0 = Date.now();
  const response = await callClaudeWithTools({
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    model: 'claude-haiku-4-5-20251001',
    temperature: 0.7,
    maxTokens: 300,
    tools: COMMENT_TOOLS,
    executeTool,
    maxIterations: 3,
  });
  const elapsed = Date.now() - t0;

  console.log(`\n--- Ответ Кеши (${elapsed}ms) ---`);
  console.log(response);
  console.log('-------------------------\n');
}

async function scenarioC(): Promise<void> {
  console.log('\n=== Сценарий C: коммент не требует ни одного инструмента ===\n');
  const userMessage = [
    'Контекст текущего поста:',
    'Сегодня обсуждаем prompt engineering.',
    'Тип поста: только текст (картинок нет).',
    '',
    'Комментарий Илья: "привет, кеша, как дела?"',
    '',
    'Илья написал комментарий к посту. Ответь по делу, в своём стиле стажёра.',
  ].join('\n');

  const executeTool = makeExecuteTool({});
  const t0 = Date.now();
  const response = await callClaudeWithTools({
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    model: 'claude-haiku-4-5-20251001',
    temperature: 0.7,
    maxTokens: 300,
    tools: COMMENT_TOOLS,
    executeTool,
    maxIterations: 3,
  });
  const elapsed = Date.now() - t0;

  console.log(`\n--- Ответ Кеши (${elapsed}ms) ---`);
  console.log(response);
  console.log('-------------------------\n');
}

async function main(): Promise<void> {
  checkEnv();
  console.log(`Тестовая ссылка: ${TEST_URL}`);
  await scenarioA();
  await scenarioB();
  await scenarioC();
}

main().catch(err => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
