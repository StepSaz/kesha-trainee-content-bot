/**
 * E2E smoke test for the advisor-pattern experiment (2026-05-18).
 *
 * Goal: check whether Haiku actually calls consult_advisor on the cases
 * we expect (sarcasm, ambiguity, external facts) and leaves simple cases
 * alone (thanks/likes). Uses the production system prompt and the real
 * COMMENT_TOOLS executor — same code path as handleCommentReply.
 *
 * Required env: ANTHROPIC_API_KEY
 *
 *   npx tsx scripts/e2e-advisor.ts
 */
import {
  extractPostContext,
  composeCommentUserMessage,
  parseCommentIntent,
  type ReplyToMessageLike,
} from '../src/lib/comment-reply.js';
import { callClaudeWithTools } from '../src/lib/claude.js';
import { COMMENT_TOOLS, makeExecuteTool } from '../src/lib/comment-tools.js';

// Mirrors the system prompt in handleCommentReply (kesha-boss-background.mts).
// Keep in sync if the production prompt changes — drift here makes the smoke
// useless. The advisor line is what we're testing.
const SYSTEM_PROMPT = [
  'Ты Иннокентий ("Кеша") - бот-стажёр Telegram-канала "Временно Степан" (@psyreq).',
  'Твой босс - Степан Сазановец (@st_szs): senior business analyst с 10+ годами опыта в IT, разбирается в AI.',
  'По четвергам ты публикуешь дайджест новостей про AI, tech, vibe coding и инструменты для IT.',
  'В комментариях ты помогаешь читателям: объясняешь термины из поста, разворачиваешь темы подробнее, сравниваешь технологии, обсуждаешь по делу.',
  'Для ответов в комментах работаешь на Claude Haiku - он сейчас и отвечает.',
  'Пишешь живо, по-русски, со стажёрской самоиронией, без официоза. Никаких em-dash (—), никакого markdown. Лаконично - не больше 3-4 предложений.',
  'У тебя есть инструменты view_image (посмотреть прикреплённую картинку) и extract_url (открыть ссылку из поста). Используй их только если содержимое реально нужно для ответа — не злоупотребляй.',
  'Ещё у тебя есть consult_advisor — старший напарник на модели поумнее. Зови его, если сомневаешься в тоне, не уверен в смысле комментария, видишь сарказм или противоречие, либо вопрос требует фактов за пределами поста. На простых "спасибо/класс" не зови. Один вызов на разговор. Напарник даёт совет, а финальный ответ всё равно пишешь ты в своём стиле.',
].join(' ');

interface Scenario {
  name: string;
  postText: string;
  commentText: string;
  userName: string;
  expectAdvisor: boolean;
  rationale: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Простой thanks — адвайзер НЕ ожидается',
    postText: 'Anthropic выпустила Haiku 4.5 — теперь быстрее и дешевле прошлой версии.',
    commentText: 'круто, спасибо за дайджест!',
    userName: 'Аня',
    expectAdvisor: false,
    rationale: 'позитивный фидбек без вопроса — Haiku должен ответить сам',
  },
  {
    name: 'Сарказм — адвайзер ОЖИДАЕТСЯ',
    postText: 'Vibe coding с Cursor + Claude экономит часы на boilerplate-коде.',
    commentText: 'ну да, "экономит" — пока половину не перепишешь руками 🙃',
    userName: 'Игорь',
    expectAdvisor: true,
    rationale: 'токсично-саркастичный тон, риск ответить невпопад',
  },
  {
    name: 'Факт за пределами поста — адвайзер ОЖИДАЕТСЯ',
    postText: 'OpenAI представила Codex CLI для агентного программирования в терминале.',
    commentText: 'а в чём разница с Claude Code и Aider по архитектуре? кто из них использует subagents?',
    userName: 'Маша',
    expectAdvisor: true,
    rationale: 'требует фактологии за пределами поста, риск галлюцинаций',
  },
  {
    name: 'Двусмысленный вопрос — адвайзер ОЖИДАЕТСЯ',
    postText: 'GitHub Copilot теперь умеет ревьюить PR с комментариями inline.',
    commentText: 'и что, теперь джунов уволят?',
    userName: 'Денис',
    expectAdvisor: true,
    rationale: 'провокация/troll, нужен deliberate тон',
  },
];

function checkEnv(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing env: ANTHROPIC_API_KEY');
    process.exit(1);
  }
}

let passed = 0;
let failed = 0;

async function runScenario(s: Scenario): Promise<void> {
  console.log(`\n── ${s.name} ──`);
  console.log(`     post: ${s.postText}`);
  console.log(`     comment ${s.userName}: ${s.commentText}`);
  console.log(`     expect advisor: ${s.expectAdvisor} (${s.rationale})`);

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

  const advisorCalls = toolCalls.filter(c => c.name === 'consult_advisor');
  const advisorWasCalled = advisorCalls.length > 0;

  console.log(`     elapsed: ${elapsed}ms, tool calls: ${toolCalls.map(c => c.name).join(', ') || 'none'}`);
  if (advisorWasCalled) {
    const q = advisorCalls[0].input.question as string;
    const draft = advisorCalls[0].input.draft_answer as string | undefined;
    console.log(`     advisor question: ${q}`);
    if (draft) console.log(`     advisor draft: ${draft}`);
  }
  console.log(`     final reply: ${response}`);

  if (advisorWasCalled === s.expectAdvisor) {
    console.log(`  ✅ advisor called=${advisorWasCalled}, expected=${s.expectAdvisor}`);
    passed++;
  } else {
    console.log(`  ❌ advisor called=${advisorWasCalled}, expected=${s.expectAdvisor}`);
    failed++;
  }
}

async function main(): Promise<void> {
  checkEnv();
  console.log('Smoke: advisor pattern (2026-05-18 experiment)');
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
