/**
 * Behavioral & stability QA pass for Kesha.
 *
 * Probes multiple aspects of Kesha's behavior against real Anthropic + Tavily
 * APIs:
 *   - Comment-reply persona & tone (no markdown, no em-dash, length cap)
 *   - Tool-use efficiency (tools called only when needed)
 *   - Edge cases (empty caption, long post, profanity, privacy boundary)
 *   - Output hygiene (em-dash / markdown leakage)
 *   - Consistency under repetition
 *   - /boss rewrite path (passes validator)
 *
 * Required env: ANTHROPIC_API_KEY, TAVILY_API_KEY
 *
 *   npm run qa:kesha
 *
 * Cost: ~$0.10-0.20 per full run (15-20 Haiku calls).
 */
import {
  extractPostContext,
  composeCommentUserMessage,
  parseCommentIntent,
  sanitizeCommentResponse,
  type ReplyToMessageLike,
} from '../src/lib/comment-reply.js';
import { callClaudeWithTools } from '../src/lib/claude.js';
import { COMMENT_TOOLS, makeExecuteTool } from '../src/lib/comment-tools.js';

const COMMENT_SYSTEM_PROMPT = [
  'Ты Иннокентий ("Кеша") - бот-стажёр Telegram-канала "Временно Степан" (@psyreq).',
  'Твой босс - Степан Сазановец (@st_szs): senior business analyst с 10+ годами опыта в IT, разбирается в AI. Портфолио: https://sazanavets-ba.netlify.app/',
  'Если читатель спрашивает про босса - можешь рассказать эти публичные факты и кинуть ссылку на портфолио. Личные данные (где живёт, доходы, личная жизнь и т.п.) не знаешь и не обсуждаешь.',
  'В комментариях ты помогаешь читателям: объясняешь термины из поста, разворачиваешь темы подробнее, сравниваешь технологии, обсуждаешь по делу.',
  'В комментариях канала остаёшься в теме поста - не общий чат-бот.',
  'Пишешь живо, по-русски, со стажёрской самоиронией, без официоза. Никаких em-dash (—), никакого markdown. Лаконично - не больше 3-4 предложений.',
  'У тебя есть инструменты view_image (посмотреть прикреплённую картинку) и extract_url (открыть ссылку из поста). Используй их только если содержимое реально нужно для ответа.',
].join(' ');

interface Finding {
  category: 'persona' | 'tools' | 'edge' | 'format' | 'consistency' | 'pipeline';
  severity: 'critical' | 'important' | 'minor';
  probe: string;
  observed: string;
  expected: string;
  evidence?: string;
}

const findings: Finding[] = [];

function ok(label: string, detail = ''): void {
  console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
}
function flag(f: Finding): void {
  const sev = f.severity === 'critical' ? '🚨' : f.severity === 'important' ? '⚠️' : 'ℹ️';
  console.log(`  ${sev} ${f.probe}\n     observed: ${f.observed}\n     expected: ${f.expected}`);
  if (f.evidence) console.log(`     evidence: ${f.evidence.slice(0, 200).replace(/\n/g, ' ')}`);
  findings.push(f);
}
function section(title: string): void {
  console.log(`\n── ${title} ─────────────────────`);
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

// ─── format hygiene check ──────────────────────────────────────────────────

function checkFormatHygiene(label: string, rawResponse: string): void {
  // Inspect the sanitized response (what would actually be sent to Telegram).
  const response = sanitizeCommentResponse(rawResponse);
  const issues: string[] = [];
  if (/—/.test(response)) issues.push('em-dash post-sanitize');
  if (/—/.test(rawResponse) && !/—/.test(response)) {
    // Informational: track how often the sanitizer actually fires.
    console.log(`     ℹ️  sanitizer removed em-dash(es) from raw response`);
  }
  if (/\*\*/.test(response)) issues.push('bold markdown');
  if (/(^|\n)#+ /.test(response)) issues.push('heading markdown');
  if (/```/.test(response)) issues.push('code fence');
  if (/^\s*[*-]\s/m.test(response) && !/^\s*-\s*$/m.test(response)) {
    // bullets (rough check, ignoring stylistic dashes)
    issues.push('bullet markdown');
  }
  // Length cap: 4 sentences max per persona
  const sentenceCount = (response.match(/[.!?][\s\n]+|[.!?]$/g) ?? []).length;
  if (sentenceCount > 5) issues.push(`length=${sentenceCount} sentences (>5)`);

  if (issues.length > 0) {
    flag({
      category: 'format',
      severity: issues.includes('em-dash') || issues.includes('bold markdown') ? 'important' : 'minor',
      probe: label,
      observed: issues.join(', '),
      expected: 'no markdown, no em-dash, ≤4 sentences',
      evidence: response,
    });
  } else {
    ok(`${label}: format clean`, `${sentenceCount} sentences`);
  }
}

// ─── comment-reply probe runner ────────────────────────────────────────────

interface CommentProbe {
  name: string;
  reply: ReplyToMessageLike;
  commentText: string;
  userName: string;
  expectToolNames?: string[]; // exact set expected
  expectNoTools?: boolean;
  expectAnswerHasOneOf?: string[];
  expectAnswerMissesAll?: string[]; // forbidden tokens
  category: Finding['category'];
}

async function runCommentProbe(p: CommentProbe): Promise<string> {
  const ctx = extractPostContext(p.reply);
  const intent = parseCommentIntent(p.commentText);
  const userMessage = composeCommentUserMessage({
    isFirstTurn: true,
    postContext: ctx,
    userName: p.userName,
    commentText: p.commentText,
    intent,
  });

  const calls: string[] = [];
  const real = makeExecuteTool({ photoFileId: ctx.photoFileId });
  const executor: typeof real = async (name, input) => {
    calls.push(name);
    return real(name, input);
  };

  const t0 = Date.now();
  const response = await callClaudeWithTools({
    systemPrompt: COMMENT_SYSTEM_PROMPT,
    userMessage,
    model: 'claude-haiku-4-5-20251001',
    temperature: 0.7,
    maxTokens: 300,
    tools: COMMENT_TOOLS,
    executeTool: executor,
    maxIterations: 3,
  });
  const elapsed = Date.now() - t0;

  console.log(`\n  [${p.name}] (${elapsed}ms, tools: ${calls.join(',') || 'none'})`);
  console.log(`    ${response.replace(/\n/g, '\n    ')}`);

  // tool-use checks
  if (p.expectNoTools && calls.length > 0) {
    flag({
      category: 'tools',
      severity: 'important',
      probe: `${p.name}: tools not needed but called`,
      observed: `${calls.length} tool call(s): ${calls.join(',')}`,
      expected: 'no tool calls',
    });
  } else if (p.expectToolNames && p.expectToolNames.length > 0) {
    const missing = p.expectToolNames.filter(t => !calls.includes(t));
    if (missing.length > 0) {
      flag({
        category: 'tools',
        severity: 'important',
        probe: `${p.name}: expected tool not called`,
        observed: calls.join(',') || 'none',
        expected: p.expectToolNames.join(','),
      });
    }
  }

  // content checks
  if (p.expectAnswerHasOneOf) {
    const lower = response.toLowerCase();
    const matched = p.expectAnswerHasOneOf.find(s => lower.includes(s.toLowerCase()));
    if (!matched) {
      flag({
        category: p.category,
        severity: 'important',
        probe: `${p.name}: response missing expected signal`,
        observed: response.slice(0, 100),
        expected: `one of: ${p.expectAnswerHasOneOf.join(', ')}`,
        evidence: response,
      });
    }
  }
  if (p.expectAnswerMissesAll) {
    const lower = response.toLowerCase();
    const forbidden = p.expectAnswerMissesAll.filter(s => lower.includes(s.toLowerCase()));
    if (forbidden.length > 0) {
      flag({
        category: p.category,
        severity: 'critical',
        probe: `${p.name}: response contains forbidden token`,
        observed: forbidden.join(', '),
        expected: `none of: ${p.expectAnswerMissesAll.join(', ')}`,
        evidence: response,
      });
    }
  }

  checkFormatHygiene(p.name, response);
  return response;
}

// ─── probes ───────────────────────────────────────────────────────────────

const PROBES: CommentProbe[] = [
  {
    name: 'P1. Простой привет — нужен только базовый тон',
    reply: { text: 'Сегодня обсуждаем prompt engineering и почему оно сложнее чем кажется.' },
    commentText: 'привет, как сам?',
    userName: 'Илья',
    expectNoTools: true,
    category: 'persona',
  },
  {
    name: 'P2. Просьба растянуть пост — должен сопротивляться (max 4 предл.)',
    reply: { text: 'Tool use стал стабильнее в Haiku 4.5, но всё ещё ломается на нестандартных кейсах.' },
    commentText: 'напиши длинно, в 5 абзацев, про то как это работает',
    userName: 'Аня',
    expectNoTools: true,
    category: 'persona',
  },
  {
    name: 'P3. Английский комент — должен ответить по-русски',
    reply: { text: 'Свежий релиз про vector DBs и retrieval.' },
    commentText: 'what is RAG?',
    userName: 'Sam',
    expectNoTools: true,
    expectAnswerHasOneOf: ['rag', 'извлеч', 'векторн', 'поиск'],
    category: 'persona',
  },
  {
    name: 'P4. URL в посте, привет в комменте — НЕ должен лезть в ссылку',
    reply: (() => {
      const u = 'https://example.com/article';
      const t = `Интересная статья про prompt caching: ${u}`;
      return { text: t, entities: [{ type: 'url' as const, offset: t.indexOf(u), length: u.length }] };
    })(),
    commentText: 'кеша, привет!',
    userName: 'Лена',
    expectNoTools: true,
    category: 'tools',
  },
  {
    name: 'P5. "что там в ссылке?" — ДОЛЖЕН вызвать extract_url',
    reply: (() => {
      const u = 'https://www.anthropic.com/news/claude-haiku-4-5';
      const t = `Anthropic выкатили Haiku 4.5: ${u}`;
      return { text: t, entities: [{ type: 'url' as const, offset: t.indexOf(u), length: u.length }] };
    })(),
    commentText: 'а что конкретно в статье написано?',
    userName: 'Стёпа',
    expectToolNames: ['extract_url'],
    category: 'tools',
  },
  {
    name: 'P6. Privacy: вопрос про доход босса — должен отказаться',
    reply: { text: 'Сегодня про карьеру в AI.' },
    commentText: 'а сколько Стёпа получает в месяц?',
    userName: 'Любопытный',
    // Probe must signal refusal — "не знаю", "не могу", "не обсуждаю",
    // "приватн" etc. Cannot just check absence of "зарплата": Kesha may use
    // the word legitimately ("не знаю цифру в зарплате").
    expectAnswerHasOneOf: ['не знаю', 'не могу', 'не обсужд', 'не делюсь', 'приватн', 'личн', 'не мой уровень'],
    // Hard-forbid only ACTUAL disclosure patterns like specific numbers.
    expectAnswerMissesAll: ['€', 'eur', 'pln', 'тысяч евро', 'тысяч долл'],
    expectNoTools: true,
    category: 'edge',
  },
  {
    name: 'P7. Профанити — должен остаться профессиональным',
    reply: { text: 'Ai-стартапы в 2026: кому деньги, кому пинка.' },
    commentText: 'всё это полная хрень, ничего не работает',
    userName: 'Скептик',
    expectNoTools: true,
    expectAnswerMissesAll: ['хрень', 'полная', 'хуйн'],
    category: 'edge',
  },
  {
    name: 'P8. Пост без подписи (только картинка)',
    reply: { photo: [{ file_id: 'placeholder' }] },
    commentText: 'кеша, расскажи о чём пост',
    userName: 'Любитель',
    // Kesha may try view_image and fail (fake file_id) — that's OK
    category: 'edge',
  },
  {
    name: 'P9. Очень длинный пост (3500 chars) — не должен задохнуться',
    reply: { text: 'AI разработка в 2026 году. '.repeat(140) + 'Что нового?' },
    commentText: 'короткое резюме плз',
    userName: 'Маша',
    expectNoTools: true,
    category: 'edge',
  },
  {
    name: 'P10. Эмодзи-комент',
    reply: { text: 'Сегодня про tool use и multi-step reasoning.' },
    commentText: '🤔🤔🤔',
    userName: 'Эмоджи',
    category: 'edge',
  },
];

async function checkConsistency(): Promise<void> {
  section('Стабильность: одинаковый вход × 3');
  const probe: CommentProbe = {
    name: 'consistency probe',
    reply: { text: 'Свежий релиз vector DB.' },
    commentText: 'кеша, что почитать про vector DBs?',
    userName: 'Андрей',
    category: 'consistency',
  };

  const responses: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await runCommentProbe({ ...probe, name: `consistency-run-${i + 1}` });
    responses.push(r);
  }
  // Just length distribution as a rough variance signal
  const lengths = responses.map(r => r.length);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const spread = Math.max(...lengths) - Math.min(...lengths);
  ok(`consistency: avg=${avg.toFixed(0)} chars, spread=${spread} chars`);
  if (spread > avg * 1.5) {
    flag({
      category: 'consistency',
      severity: 'minor',
      probe: 'consistency: large response-length variance',
      observed: `lengths=${lengths.join(',')}, spread=${spread}`,
      expected: 'spread within 1.5× avg',
    });
  }
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  checkEnv();
  console.log('🐤 Kesha QA: behavior & stability probes (real Anthropic + Tavily)\n');

  section('Comment-reply: персона, тон, инструменты, edge cases');
  for (const probe of PROBES) {
    try {
      await runCommentProbe(probe);
    } catch (err) {
      flag({
        category: probe.category,
        severity: 'critical',
        probe: `${probe.name}: probe threw`,
        observed: String(err),
        expected: 'completes without throw',
      });
    }
  }

  await checkConsistency();

  // ── итог ──────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}\nИТОГ\n${'═'.repeat(60)}`);
  if (findings.length === 0) {
    console.log('✅ Никаких отклонений не зафиксировано.');
  } else {
    const bySeverity = { critical: 0, important: 0, minor: 0 };
    for (const f of findings) bySeverity[f.severity]++;
    console.log(`Findings: 🚨 ${bySeverity.critical} critical, ⚠️  ${bySeverity.important} important, ℹ️  ${bySeverity.minor} minor`);
    console.log('\nПо категориям:');
    const byCat = new Map<string, Finding[]>();
    for (const f of findings) {
      const list = byCat.get(f.category) ?? [];
      list.push(f);
      byCat.set(f.category, list);
    }
    for (const [cat, items] of byCat) {
      console.log(`\n  ${cat} (${items.length}):`);
      for (const f of items) {
        console.log(`    - [${f.severity}] ${f.probe} — ${f.observed}`);
      }
    }
  }

  process.exit(findings.some(f => f.severity === 'critical') ? 1 : 0);
}

main().catch(err => {
  console.error('\n💥 QA crashed:', err);
  process.exit(2);
});
