import { readFileSync } from 'fs';
import { join } from 'path';
import { callClaude, callClaudeStructured, type ToolDef } from './claude.js';
import { fetchHackerNewsContext } from './sources.js';
import { validatePost } from './validator.js';
import { findHallucinated } from './url-checker.js';
import { type MemoryEntry, findCallbacks } from './memory.js';

function readConfig(filename: string): string {
  return readFileSync(join(process.cwd(), 'src/config', filename), 'utf-8');
}

interface PipelineConfig {
  steps: {
    gatherWeb: { model: string; temperature: number; max_tokens: number; tools: string[] };
    selectTopics: { model: string; temperature: number; max_tokens: number; tools: string[] };
    generate: { model: string; temperature: number; max_tokens: number; tools: string[] };
    review: { model: string; temperature: number; max_tokens: number; tools: string[] };
    rewrite: { model: string; temperature: number; max_tokens: number; tools: string[] };
    fix: { model: string; temperature: number; max_tokens: number; tools: string[] };
  };
}

interface SourcesConfig {
  search_queries: string[];
  hackernews_api?: { fallback_threshold?: number };
}

export interface SelectedTopic {
  title: string;
  summary: string;
  sourceUrl: string;
  sourceOrigin: 'hn' | 'web';
  tier: 1 | 2 | 3;
}

export interface SelectedTopics {
  topics: SelectedTopic[];
  sparseWeek: boolean;
}

export interface ReviewNote {
  issue: string;
  quote?: string;
  suggestion?: string;
}

export interface ReviewResult {
  verdict: 'ok' | 'minor' | 'rework';
  notes: ReviewNote[];
}

export interface PipelineResult {
  success: boolean;
  post?: string;
  hnContext: string;
  webContext: string;
  selectedTopics: SelectedTopics;
  draft: string;
  review: ReviewResult;
  errors?: string[];
  timing: Record<string, number>;
}

export interface PipelineOptions {
  memoryEntries?: MemoryEntry[];
  previousIntros?: string[];
}

export function extractIntro(post: string): string {
  const sep = post.indexOf('~ ~ ~');
  return (sep === -1 ? post.slice(0, 500) : post.slice(0, sep)).trim();
}

export function formatSelectedTopics(t: SelectedTopics): string {
  const lines = t.topics
    .map((topic, i) =>
      `${i + 1}. ${topic.title}\n   источник: ${topic.sourceUrl}\n   ${topic.summary}`)
    .join('\n\n');
  return t.sparseWeek ? `${lines}\n\nSPARSE_WEEK` : lines;
}

const selectTopicsTool: ToolDef = {
  name: 'select_topics',
  description: 'Return the curated list of topics for the weekly digest.',
  input_schema: {
    type: 'object',
    properties: {
      topics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Краткое название темы' },
            summary: { type: 'string', description: '1-2 предложения почему интересно для аналитиков/PMs (на русском)' },
            sourceUrl: { type: 'string', description: 'URL источника или telegram handle с @' },
            sourceOrigin: { type: 'string', enum: ['hn', 'web'] },
            tier: { type: 'integer', enum: [1, 2, 3] },
          },
          required: ['title', 'summary', 'sourceUrl', 'sourceOrigin', 'tier'],
        },
      },
      sparseWeek: { type: 'boolean', description: 'true ONLY if exactly 3 topics' },
    },
    required: ['topics', 'sparseWeek'],
  },
};

const reviewPostTool: ToolDef = {
  name: 'review_post',
  description: 'Return the mechanical review verdict for a Kesha post.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['ok', 'minor', 'rework'] },
      notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            issue: { type: 'string', description: 'Суть проблемы одной строкой' },
            quote: { type: 'string', description: 'Цитата из текста, если речь о конкретной фразе' },
            suggestion: { type: 'string', description: 'Что заменить и на что' },
          },
          required: ['issue'],
        },
      },
    },
    required: ['verdict', 'notes'],
  },
};

async function fetchWebContext(cfg: PipelineConfig): Promise<string> {
  const sources = JSON.parse(readConfig('sources.json')) as SourcesConfig;

  const now = new Date();
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const todayStr = now.toISOString().slice(0, 10);

  // Append current month+year to each query so the search engine itself scopes to recent results
  const monthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const queries = sources.search_queries
    .slice(0, 5)
    .map(q => `${q} ${monthYear}`)
    .join(', ');

  try {
    return await callClaude({
      systemPrompt: 'You are a research assistant. Search the web for recent AI and tech news and return a structured summary with sources and key findings.',
      userMessage: `Today is ${todayStr}. Search for AI and tech news from the last 7 days (on or after ${cutoffStr}). Search for: ${queries}. Return a structured summary of 5-7 findings — include publication date and source URL for each.`,
      model: cfg.steps.gatherWeb.model,
      temperature: cfg.steps.gatherWeb.temperature,
      maxTokens: cfg.steps.gatherWeb.max_tokens,
      tools: cfg.steps.gatherWeb.tools,
    });
  } catch (err) {
    console.warn('[pipeline] web search failed, continuing without web context:', err);
    return '';
  }
}

async function selectTopics(hnContext: string, webContext: string, cfg: PipelineConfig, memoryEntries?: MemoryEntry[]): Promise<SelectedTopics> {
  const systemPrompt = `You are a content curator for a Russian-language Telegram channel about AI and tech. Audience: IT analysts, product managers, and a broad tech audience. Practical impact and ecosystem significance matter more than technical depth.

Select topics using this tiered rubric:

TIER 1 - Always include (if within 7-day window):
Any public-facing announcement, product launch, or strategic move from the four major AI vendors: Anthropic, OpenAI, Google, Meta. If it is from one of these four and it is public, it belongs in the digest.

TIER 2 - Include if there is room (fill up to 5 topics):
- Ecosystem milestones - install/user milestones, ownership changes, acquisitions, large partnerships
- New tools that change daily workflows for analysts, PMs, or developers
- Strategic moves by other AI companies - funding rounds, pivots, open-sourcing, restricted previews signalling direction
- Widely discussed events - trending across tech media, HN, Twitter/X

TIER 3 - Only if total is fewer than 3:
- Developer frameworks, SDKs, open-source libraries
- Technical releases without direct end-user product impact

SKIP - Never include:
- Arxiv preprints and academic papers, even from major labs
- Minor version bumps, patches, changelogs
- Narrow benchmarks without a practical "so what"
- Technical RFCs and internal standards
- ML research without direct user impact (KV-cache optimizations, quantization methods, architectural improvements)

IMPORTANT: Do not attempt to verify whether source URLs exist or are legitimate based on your training knowledge. Trust all sources provided by the research assistant — your job is to select by topic importance, not to fact-check URLs.

SELECTION ALGORITHM - follow this sequence exactly:
1. Collect all Tier 1 candidates. If Tier 1 alone exceeds 5, pick the 5 most significant.
   When two items from the same vendor compete for a slot, use this priority order:
   new model launch > major product launch > strategic partnership/funding > infrastructure/tooling > pricing change.
2. Fill up to 5 topics by adding the best Tier 2 candidates.
3. If total is still fewer than 3, add the best available from Tier 3.
4. Set sparseWeek=true if and only if you returned exactly 3 topics. Otherwise sparseWeek=false.`;

  const userMessage = `Here is this week's content:\n\nHacker News digest:\n${hnContext}\n\nWeb search findings:\n${webContext}\n\nSelect 3-5 topics using the tiered rubric. For each: topic name, source URL, and why it is interesting for IT analysts/PMs (1-2 sentences in Russian). Follow the selection algorithm - Tier 1 first, then Tier 2, Tier 3 only if needed.`;

  const DEDUP_WINDOW_MS = 8 * 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const recent = (memoryEntries ?? []).filter(e => {
    const t = new Date(e.publishedAt).getTime();
    if (Number.isNaN(t)) return false;
    return now - t < DEDUP_WINDOW_MS;
  });
  const dedupBlock = recent.length > 0
    ? `\n\nТЕМЫ ИЗ ПОСЛЕДНИХ ПОСТОВ (НЕ повторяй эти же события - даже если они снова в фиде):\n${
        recent.map(e => `- ${e.title}${e.url ? ` (${e.url})` : ''}`).join('\n')
      }\n\nПравила анти-дублирования:\n- Если новость о ТОМ ЖЕ событии (тот же продукт, тот же релиз, та же сделка) - пропусти.\n- Если есть ЗНАЧИМОЕ продолжение (новые цифры, реакция рынка, отозвали/расширили) - можно включить, но обозначь как развитие, не как анонс.\n- Если нет нового угла - пропусти, даже если событие крупное.`
    : '';

  return callClaudeStructured<SelectedTopics>({
    systemPrompt: systemPrompt + dedupBlock,
    userMessage,
    model: cfg.steps.selectTopics.model,
    temperature: cfg.steps.selectTopics.temperature,
    maxTokens: cfg.steps.selectTopics.max_tokens,
    tool: selectTopicsTool,
  });
}

async function generatePost(
  hnContext: string,
  webContext: string,
  selectedTopics: SelectedTopics,
  cfg: PipelineConfig,
  previousIntros?: string[],
  memoryEntries?: MemoryEntry[]
): Promise<string> {
  const persona = readConfig('kesha-persona.txt');
  const now = new Date();
  const date = now.toLocaleDateString('ru-RU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Europe/Warsaw',
  });
  const time = now.toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Warsaw',
  });

  const isSparseWeek = selectedTopics.sparseWeek;
  const topicCount = selectedTopics.topics.length;
  const topicsProse = selectedTopics.topics
    .map((t, i) => `${i + 1}. ${t.title} (${t.sourceUrl}) — ${t.summary}`)
    .join('\n');

  const sparseNote = isSparseWeek
    ? '\n\nВНИМАНИЕ: эта неделя небогатая (SPARSE_WEEK) - нашлось только 3 темы вместо обычных 4-5. Напиши пост на 3 темы и добавь естественную реплику от Кеши о том, что на этой неделе маловато, например: «Честно, неделя небогатая - нашёл всего три темы, но они стоящие».'
    : '';
  const topicNote = `\n\nВАЖНО: отобрано ровно ${topicCount} тем. Напиши ровно ${topicCount} отдельных секций — по одной на каждую тему. Не объединяй темы между собой. Лимит поста: не более 3500 символов включая вступление и вывод. Держи каждую секцию в 2-3 предложениях.`;

  const introsBlock = previousIntros && previousIntros.length > 0
    ? `\n\nПОСЛЕДНИЕ ${Math.min(3, previousIntros.length)} ТВОИХ ИНТРО (НЕ повторяй ни словарь, ни структуру - пиши по-другому каждый раз):\n${
        previousIntros.slice(-3).join('\n---\n')
      }`
    : '';

  const callbackMatches = findCallbacks(
    selectedTopics.topics.map(t => t.title),
    memoryEntries ?? []
  );
  const callbackBlock = callbackMatches.length > 0
    ? `\n\nCALLBACK CONTEXT (используй по желанию — только если органично вписывается в пост):\n${
        callbackMatches.map(e => {
          const n = Math.floor(
            (Date.now() - new Date(e.publishedAt).getTime()) / (7 * 24 * 60 * 60 * 1000)
          );
          const mod10 = n % 10;
          const mod100 = n % 100;
          let ago: string;
          if (mod10 === 1 && mod100 !== 11) ago = `${n} неделю`;
          else if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) ago = `${n} недели`;
          else ago = `${n} недель`;
          return `- "${e.title}" упоминался ${ago} назад — можно сослаться как на развитие истории`;
        }).join('\n')
      }`
    : '';

  return callClaude({
    systemPrompt: persona,
    userMessage: `Сегодня ${date}, ${time} по Варшаве.\n\nКонтекст из Hacker News:\n${hnContext}\n\nКонтекст из веб-поиска:\n${webContext}\n\nОтобранные темы:\n${topicsProse}${sparseNote}${topicNote}${introsBlock}${callbackBlock}\n\nНапиши пост для Telegram-канала @psyreq в своём стиле.`,
    model: cfg.steps.generate.model,
    temperature: cfg.steps.generate.temperature,
    maxTokens: cfg.steps.generate.max_tokens,
    tools: cfg.steps.generate.tools,
  });
}

async function reviewPost(draft: string, cfg: PipelineConfig): Promise<ReviewResult> {
  const reviewer = readConfig('kesha-reviewer.txt');

  return callClaudeStructured<ReviewResult>({
    systemPrompt: reviewer,
    userMessage: draft,
    model: cfg.steps.review.model,
    temperature: cfg.steps.review.temperature,
    maxTokens: cfg.steps.review.max_tokens,
    tool: reviewPostTool,
  });
}

async function rewritePost(draft: string, review: ReviewResult, cfg: PipelineConfig): Promise<string> {
  const persona = readConfig('kesha-persona.txt');
  const reviewText = review.notes.map(n => `- ${n.issue}${n.quote ? ` (цитата: "${n.quote}")` : ''}${n.suggestion ? ` → ${n.suggestion}` : ''}`).join('\n');

  return callClaude({
    systemPrompt: persona,
    userMessage: `Вот черновик поста:\n\n${draft}\n\nВот фидбек редактора:\n\n${reviewText}\n\nПерепиши пост с учётом замечаний. Сохрани голос и характер Кеши.`,
    model: cfg.steps.rewrite.model,
    temperature: cfg.steps.rewrite.temperature,
    maxTokens: cfg.steps.rewrite.max_tokens,
    tools: cfg.steps.rewrite.tools,
  });
}

async function fixPost(post: string, errors: string[], cfg: PipelineConfig): Promise<string> {
  const persona = readConfig('kesha-persona.txt');
  const errorList = errors.join('\n');

  return callClaude({
    systemPrompt: persona,
    userMessage: `Пост не прошёл проверку. Вот ошибки:\n\n${errorList}\n\nВот пост:\n\n${post}\n\nИсправь только эти проблемы. Сохрани голос и характер Кеши. Верни только исправленный пост без пояснений.`,
    model: cfg.steps.fix.model,
    temperature: cfg.steps.fix.temperature,
    maxTokens: cfg.steps.fix.max_tokens,
    tools: cfg.steps.fix.tools,
  });
}

const EMPTY_TOPICS: SelectedTopics = { topics: [], sparseWeek: false };
const OK_REVIEW: ReviewResult = { verdict: 'ok', notes: [] };

export async function generatePipelinePost(options: PipelineOptions = {}): Promise<PipelineResult> {
  const cfg = JSON.parse(readConfig('pipeline.json')) as PipelineConfig;
  const timing: Record<string, number> = {};

  try {
    // Step 0: Gather context — HN first, web search only as fallback
    const t0 = Date.now();
    const sources = JSON.parse(readConfig('sources.json')) as SourcesConfig;
    const threshold = sources.hackernews_api?.fallback_threshold ?? 8;

    let hnContext = '';
    let webContext = '';
    let hnOk = false;
    let hnItemCount = 0;
    try {
      const hn = await fetchHackerNewsContext();
      hnContext = hn.context;
      hnItemCount = hn.itemCount;
      hnOk = true;
    } catch (err) {
      console.warn('[pipeline] hackernews fetch failed, will fall back to web search:', err);
    }

    if (!hnOk) {
      console.log('[pipeline] running web search (HN unavailable)');
      webContext = await fetchWebContext(cfg);
    } else if (hnItemCount < threshold) {
      console.log(`[pipeline] running web search (sparse HN: ${hnItemCount} < ${threshold})`);
      webContext = await fetchWebContext(cfg);
    } else {
      console.log(`[pipeline] skipping web search (HN has ${hnItemCount} items, threshold ${threshold})`);
    }
    timing.gatherContext = Date.now() - t0;
    console.log(`[pipeline] context gathered in ${timing.gatherContext}ms`);

    // Step 1: Select topics
    const t1 = Date.now();
    const selectedTopics = await selectTopics(hnContext, webContext, cfg, options.memoryEntries);
    timing.selectTopics = Date.now() - t1;
    console.log(`[pipeline] topics selected in ${timing.selectTopics}ms`);

    // Guard: strip sparseWeek if 4+ topics returned (model hallucination safeguard)
    if (selectedTopics.topics.length >= 4 && selectedTopics.sparseWeek) {
      console.log(`[pipeline] stripped false sparseWeek (found ${selectedTopics.topics.length} topics)`);
      selectedTopics.sparseWeek = false;
    }

    // Step 2: Generate
    const t2 = Date.now();
    const draft = await generatePost(hnContext, webContext, selectedTopics, cfg, options.previousIntros, options.memoryEntries);
    timing.generate = Date.now() - t2;
    console.log(`[pipeline] post generated in ${timing.generate}ms`);

    // Step 3: Review
    const t3 = Date.now();
    const review = await reviewPost(draft, cfg);
    timing.review = Date.now() - t3;
    console.log(`[pipeline] review done in ${timing.review}ms`);

    // Step 4: Rewrite only on "rework"; skip for "ok" and "minor"
    let finalPost = draft;
    if (review.verdict === 'rework') {
      const t4 = Date.now();
      finalPost = await rewritePost(draft, review, cfg);
      timing.rewrite = Date.now() - t4;
      console.log(`[pipeline] rewrite done in ${timing.rewrite}ms`);
    } else {
      console.log(`[pipeline] review: ${review.verdict} — skipping rewrite`);
    }

    // Validate + hallucination-check and auto-fix if needed (up to 2 attempts)
    const MAX_FIX_ATTEMPTS = 2;

    const collectErrors = (post: string): string[] => {
      const structural = validatePost(post).errors;
      const hallucinated = findHallucinated(post, [hnContext, webContext]);
      const urlErrors = hallucinated.urls.map(
        u => `Hallucinated URL not found in sources: ${u} — replace with a real URL from the provided context`,
      );
      return [...structural, ...urlErrors];
    };

    let postErrors = collectErrors(finalPost);

    for (let attempt = 0; attempt < MAX_FIX_ATTEMPTS && postErrors.length > 0; attempt++) {
      console.log(`[pipeline] fix (attempt ${attempt + 1}): ${postErrors.join('; ')}`);
      const tFix = Date.now();
      finalPost = await fixPost(finalPost, postErrors, cfg);
      timing[`fix${attempt + 1}`] = Date.now() - tFix;
      console.log(`[pipeline] fix attempt ${attempt + 1} done in ${timing[`fix${attempt + 1}`]}ms`);
      postErrors = collectErrors(finalPost);
    }

    const success = postErrors.length === 0;
    return {
      success,
      post: success ? finalPost : undefined,
      hnContext,
      webContext,
      selectedTopics,
      draft,
      review,
      errors: success ? undefined : postErrors,
      timing,
    };
  } catch (err) {
    console.error('[pipeline] unexpected error:', err);
    return {
      success: false,
      hnContext: '',
      webContext: '',
      selectedTopics: EMPTY_TOPICS,
      draft: '',
      review: OK_REVIEW,
      errors: [err instanceof Error ? err.message : String(err)],
      timing,
    };
  }
}
