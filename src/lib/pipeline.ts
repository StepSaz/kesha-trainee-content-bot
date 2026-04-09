import { readFileSync } from 'fs';
import { join } from 'path';
import { callClaude } from './claude.js';
import { fetchRssContext } from './rss.js';
import { validatePost } from './validator.js';

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
  };
}

interface SourcesConfig {
  search_queries: string[];
}

export interface PipelineResult {
  success: boolean;
  post?: string;
  rssContext: string;
  webContext: string;
  selectedTopics: string;
  draft: string;
  review: string;
  errors?: string[];
  timing: Record<string, number>;
}

async function fetchWebContext(cfg: PipelineConfig): Promise<string> {
  const sources = JSON.parse(readConfig('sources.json')) as SourcesConfig;
  const queries = sources.search_queries.slice(0, 5).join(', ');

  const now = new Date();
  const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const todayStr = now.toISOString().slice(0, 10);

  return callClaude({
    systemPrompt: 'You are a research assistant. Search the web for recent AI and tech news and return a structured summary with sources and key findings.',
    userMessage: `Today is ${todayStr}. Search for AI and tech news published between ${cutoffStr} and ${todayStr} (last 2 weeks only). Focus on: ${queries}. Skip anything older than ${cutoffStr}. Return a structured summary of the 5-7 most interesting findings — include the publication date and source URL for each.`,
    model: cfg.steps.gatherWeb.model,
    temperature: cfg.steps.gatherWeb.temperature,
    maxTokens: cfg.steps.gatherWeb.max_tokens,
    tools: cfg.steps.gatherWeb.tools,
  });
}

async function selectTopics(rssContext: string, webContext: string, cfg: PipelineConfig): Promise<string> {
  const systemPrompt = `You are a content curator for a Russian-language Telegram channel about AI and tech. Audience: IT analysts, product managers, and a broad tech audience. Practical impact and ecosystem significance matter more than technical depth.

INCLUDE (high priority):
- Major product launches - new models (GPT-5, Claude 4), GA releases, major versions with user-facing changes
- Ecosystem milestones - install/user milestones, ownership changes (MCP -> Linux Foundation), acquisitions, large partnerships
- New tools that change daily workflows for analysts, PMs, or developers
- Strategic moves by major AI companies - funding rounds, pivots, open-sourcing
- Widely discussed events - trending across tech media, HN, Twitter/X

SKIP (low priority):
- ML research without direct user impact - KV-cache optimizations, quantization methods, architectural improvements
- Arxiv preprints and academic papers, even from major labs
- Minor version bumps, patches, changelogs
- Narrow benchmarks without a practical "so what"
- Technical RFCs and internal standards

If fewer than 3 topics qualify under the rubric above, select the best available (minimum 2) and append SPARSE_WEEK on a new line at the very end of your response.`;

  const userMessage = `Here is this week's content:\n\nRSS feed:\n${rssContext}\n\nWeb search findings:\n${webContext}\n\nSelect 3-5 topics using the rubric. For each: topic name, source URL, and why it's interesting for IT analysts/PMs (1-2 sentences in Russian). If qualifying topics are fewer than 3, select the best 2 and append SPARSE_WEEK at the end.`;

  return callClaude({
    systemPrompt,
    userMessage,
    model: cfg.steps.selectTopics.model,
    temperature: cfg.steps.selectTopics.temperature,
    maxTokens: cfg.steps.selectTopics.max_tokens,
    tools: cfg.steps.selectTopics.tools,
  });
}

async function generatePost(
  rssContext: string,
  webContext: string,
  selectedTopics: string,
  cfg: PipelineConfig
): Promise<string> {
  const persona = readConfig('kesha-persona.txt');
  const date = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const isSparseWeek = selectedTopics.includes('SPARSE_WEEK');
  const sparseNote = isSparseWeek
    ? '\n\nВНИМАНИЕ: эта неделя скудная - найдено только 2 темы (SPARSE_WEEK). Напиши пост на 2 темы и добавь естественную реплику от Кеши о том, что на этой неделе негусто, например: «Честно, на этой неделе негусто - нашёл только два повода написать».'
    : '';

  return callClaude({
    systemPrompt: persona,
    userMessage: `Сегодня ${date}.\n\nКонтекст из RSS:\n${rssContext}\n\nКонтекст из веб-поиска:\n${webContext}\n\nОтобранные темы:\n${selectedTopics}${sparseNote}\n\nНапиши пост для Telegram-канала @psyreq в своём стиле.`,
    model: cfg.steps.generate.model,
    temperature: cfg.steps.generate.temperature,
    maxTokens: cfg.steps.generate.max_tokens,
    tools: cfg.steps.generate.tools,
  });
}

async function reviewPost(draft: string, cfg: PipelineConfig): Promise<string> {
  const reviewer = readConfig('kesha-reviewer.txt');

  return callClaude({
    systemPrompt: reviewer,
    userMessage: draft,
    model: cfg.steps.review.model,
    temperature: cfg.steps.review.temperature,
    maxTokens: cfg.steps.review.max_tokens,
    tools: cfg.steps.review.tools,
  });
}

async function rewritePost(draft: string, review: string, cfg: PipelineConfig): Promise<string> {
  const persona = readConfig('kesha-persona.txt');

  return callClaude({
    systemPrompt: persona,
    userMessage: `Вот черновик поста:\n\n${draft}\n\nВот фидбек редактора:\n\n${review}\n\nПерепиши пост с учётом замечаний. Сохрани голос и характер Кеши.`,
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
    model: cfg.steps.rewrite.model,
    temperature: cfg.steps.rewrite.temperature,
    maxTokens: cfg.steps.rewrite.max_tokens,
    tools: cfg.steps.rewrite.tools,
  });
}

export async function generatePipelinePost(): Promise<PipelineResult> {
  const cfg = JSON.parse(readConfig('pipeline.json')) as PipelineConfig;
  const timing: Record<string, number> = {};

  try {
    // Step 0: Gather context in parallel
    const t0 = Date.now();
    const [rssContext, webContext] = await Promise.all([
      fetchRssContext(),
      fetchWebContext(cfg),
    ]);
    timing.gatherContext = Date.now() - t0;
    console.log(`[pipeline] context gathered in ${timing.gatherContext}ms`);

    // Step 1: Select topics
    const t1 = Date.now();
    const selectedTopics = await selectTopics(rssContext, webContext, cfg);
    timing.selectTopics = Date.now() - t1;
    console.log(`[pipeline] topics selected in ${timing.selectTopics}ms`);

    // Step 2: Generate
    const t2 = Date.now();
    const draft = await generatePost(rssContext, webContext, selectedTopics, cfg);
    timing.generate = Date.now() - t2;
    console.log(`[pipeline] post generated in ${timing.generate}ms`);

    // Step 3: Review
    const t3 = Date.now();
    const review = await reviewPost(draft, cfg);
    timing.review = Date.now() - t3;
    console.log(`[pipeline] review done in ${timing.review}ms`);

    // Step 4: Rewrite only if not "хорошо"
    let finalPost = draft;
    if (!review.toLowerCase().startsWith('хорошо')) {
      const t4 = Date.now();
      finalPost = await rewritePost(draft, review, cfg);
      timing.rewrite = Date.now() - t4;
      console.log(`[pipeline] rewrite done in ${timing.rewrite}ms`);
    } else {
      console.log('[pipeline] review: хорошо — skipping rewrite');
    }

    // Validate and auto-fix if needed (up to 2 attempts)
    const MAX_FIX_ATTEMPTS = 2;
    let validation = validatePost(finalPost);

    for (let attempt = 0; attempt < MAX_FIX_ATTEMPTS && !validation.valid; attempt++) {
      console.log(`[pipeline] validation failed (attempt ${attempt + 1}): ${validation.errors.join(', ')}`);
      const tFix = Date.now();
      finalPost = await fixPost(finalPost, validation.errors, cfg);
      timing[`fix${attempt + 1}`] = Date.now() - tFix;
      console.log(`[pipeline] fix attempt ${attempt + 1} done in ${timing[`fix${attempt + 1}`]}ms`);
      validation = validatePost(finalPost);
    }

    return {
      success: validation.valid,
      post: validation.valid ? finalPost : undefined,
      rssContext,
      webContext,
      selectedTopics,
      draft,
      review,
      errors: validation.valid ? undefined : validation.errors,
      timing,
    };
  } catch (err) {
    console.error('[pipeline] unexpected error:', err);
    return {
      success: false,
      rssContext: '',
      webContext: '',
      selectedTopics: '',
      draft: '',
      review: '',
      errors: [err instanceof Error ? err.message : String(err)],
      timing,
    };
  }
}
