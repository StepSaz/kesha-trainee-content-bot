/**
 * E2E smoke test for the web_search tool in comment replies.
 *
 * Goal: check that Haiku calls web_search when the reader explicitly
 * pushes for deeper coverage ("копни глубже", "дай подробнее") or asks
 * about facts clearly beyond the post — and leaves simple cases alone.
 *
 * Mirrors the production system prompt from handleCommentReply
 * (netlify/functions/kesha-boss-background.mts) — keep in sync if prod
 * changes.
 *
 * Required env: ANTHROPIC_API_KEY, TAVILY_API_KEY
 *
 *   npx tsx scripts/e2e-web-search.ts
 */
import {
  extractPostContext,
  composeCommentUserMessage,
  parseCommentIntent,
  type ReplyToMessageLike,
} from '../src/lib/comment-reply.js';
import { callClaudeWithTools } from '../src/lib/claude.js';
import { COMMENT_TOOLS, makeExecuteTool } from '../src/lib/comment-tools.js';

const SYSTEM_PROMPT = [
  'Ты Иннокентий ("Кеша"), бот-стажёр Telegram-канала "Временно Степан" (@psyreq). Канал про AI, tech, vibe coding и инструменты для IT. В комментариях помогаешь читателям по теме поста.',
  'ГЛАВНОЕ: отвечай по существу задачи читателя - какие конкретные инструменты, подходы, продукты подойдут под ЕГО сценарий. Не отвечай абстрактно про категории технологий.',
  'Стиль: живо, по-русски, со стажёрской самоиронией. Лаконично - 3-4 предложения максимум. Без markdown, без em-dash.',
  'Инструменты: view_image (картинка поста), extract_url (ссылка из поста), web_search (Tavily — свежие факты, когда читатель просит копнуть глубже или нужны данные свежее знаний модели; макс 2 вызова за разговор), consult_advisor (старший напарник для трудных случаев: сарказм, неясности, тон). Используй только когда реально нужно. Advisor - максимум один раз за разговор, на простое "спасибо" не зови; даёт совет, финальный ответ всё равно пишешь ты.',
  'Если спрашивают про твоего босса - Степан Сазановец (@st_szs), senior business analyst, 10+ лет в IT, разбирается в AI, портфолио https://sazanavets-ba.netlify.app/. Личное (где живёт, доходы и т.п.) не знаешь.',
  'Если спрашивают про твоё устройство - отвечаешь общо: "бот-стажёр, под капотом разные модели и инструменты". Названия конкретных моделей, провайдеров и инфраструктуры в публичных комментариях не раскрываешь.',
].join(' ');

interface Scenario {
  name: string;
  postText: string;
  commentText: string;
  userName: string;
  expectSearch: boolean;
  rationale: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Простое "спасибо" — поиск НЕ ожидается',
    postText: 'Anthropic выпустила Haiku 4.5 — теперь быстрее и дешевле прошлой версии.',
    commentText: 'круто, спасибо за дайджест!',
    userName: 'Аня',
    expectSearch: false,
    rationale: 'нет вопроса по фактам, искать нечего',
  },
  {
    name: 'Вопрос внутри поста — поиск НЕ ожидается',
    postText: 'Anthropic выпустила Haiku 4.5: дешевле прошлой версии примерно в 3 раза, поддерживает tool use и vision.',
    commentText: 'а tool use он точно умеет?',
    userName: 'Денис',
    expectSearch: false,
    rationale: 'факт есть прямо в посте, поиск не нужен',
  },
  {
    name: 'Босс настаивает копнуть глубже — поиск ОЖИДАЕТСЯ',
    postText: 'Босс, вчера Google показала на I/O в основном два больших блока: Gemini 3.5 с агентным стеком (Search, Workspace, Android) и AI Mode с первыми данными о том как это меняет поведение юзеров в поиске США.',
    commentText: 'глубже копни, не ленись',
    userName: 'Стёпа',
    expectSearch: true,
    rationale: 'явная просьба добрать фактов сверх того что в посте',
  },
  {
    name: 'Факт свежее знаний модели — поиск ОЖИДАЕТСЯ',
    postText: 'OpenAI представила Codex CLI для агентного программирования в терминале.',
    commentText: 'а какая у Codex CLI цена и есть ли уже бенчмарки против Claude Code на SWE-bench?',
    userName: 'Маша',
    expectSearch: true,
    rationale: 'конкретные свежие цифры за пределами поста',
  },
];

function checkEnv(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing env: ANTHROPIC_API_KEY');
    process.exit(1);
  }
  if (!process.env.TAVILY_API_KEY) {
    console.warn('⚠️  TAVILY_API_KEY not set — web_search tool will return empty results, but call-decision checks still work.');
  }
}

let passed = 0;
let failed = 0;

async function runScenario(s: Scenario): Promise<void> {
  console.log(`\n── ${s.name} ──`);
  console.log(`     post: ${s.postText}`);
  console.log(`     comment ${s.userName}: ${s.commentText}`);
  console.log(`     expect search: ${s.expectSearch} (${s.rationale})`);

  const reply: ReplyToMessageLike = { text: s.postText };
  const ctx = extractPostContext(reply);
  const intent = parseCommentIntent(s.commentText);
  const userMessage = composeCommentUserMessage({
    isFirstTurn: true,
    postContext: ctx,
    userName: s.userName,
    commentText: s.commentText,
    intent,
  });

  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  const real = makeExecuteTool({ photoFileId: ctx.photoFileId });
  const executor = async (name: string, input: Record<string, unknown>) => {
    toolCalls.push({ name, input });
    return real(name, input);
  };

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
    console.log(`  ❌ Claude call failed: ${(err as Error).message}`);
    failed++;
    return;
  }
  const elapsed = Date.now() - t0;

  const searchCalls = toolCalls.filter(c => c.name === 'web_search');
  const searchWasCalled = searchCalls.length > 0;

  console.log(`     elapsed: ${elapsed}ms, tool calls: ${toolCalls.map(c => c.name).join(', ') || 'none'}`);
  if (searchWasCalled) {
    for (const call of searchCalls) {
      console.log(`     search query: ${call.input.query as string}`);
    }
  }
  console.log(`     final reply: ${response}`);

  if (searchWasCalled === s.expectSearch) {
    console.log(`  ✅ search called=${searchWasCalled}, expected=${s.expectSearch}`);
    passed++;
  } else {
    console.log(`  ❌ search called=${searchWasCalled}, expected=${s.expectSearch}`);
    failed++;
  }
}

async function main(): Promise<void> {
  checkEnv();
  console.log('Smoke: web_search tool in comment replies');
  console.log(`Scenarios: ${SCENARIOS.length}`);

  for (const s of SCENARIOS) {
    await runScenario(s);
  }

  console.log(`\n── Summary ──`);
  console.log(`Passed: ${passed} / ${SCENARIOS.length}`);
  console.log(`Failed: ${failed} / ${SCENARIOS.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
