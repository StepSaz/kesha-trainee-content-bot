import { readFileSync } from 'fs';
import { join } from 'path';
import { callClaude, callClaudeStructured } from './claude.js';
import { fetchHackerNewsContext, fetchLightWebSearch, normalizeUrl } from './sources.js';
import { selectTopicsForContexts, reviewResultTool, type SelectedTopics, type ReviewResult } from './pipeline.js';
import { validateShort, countLinkedSources } from './validator.js';
import { findHallucinated } from './url-checker.js';
import { type MemoryEntry } from './memory.js';

function readConfig(filename: string): string {
  return readFileSync(join(process.cwd(), 'src/config', filename), 'utf-8');
}

interface ShortModelConfig {
  model: string;
  temperature: number;
  max_tokens: number;
  tools: string[];
}

interface ShortDigestConfig {
  generate: ShortModelConfig;
  review: ShortModelConfig;
  rewrite: ShortModelConfig;
  fix: ShortModelConfig;
}

export interface ShortDigestOptions {
  memoryEntries?: MemoryEntry[];
  previousIntros?: string[];
}

// Extracts the short digest's intro — the greeting line(s) between the mandatory
// disclaimer header and the first 📎 bullet. Used for cross-week anti-repetition.
export function extractShortIntro(post: string): string {
  const lines = post.split('\n');
  const firstBullet = lines.findIndex((l) => /^📎/u.test(l));
  const head = firstBullet === -1 ? lines : lines.slice(0, firstBullet);
  return head
    .map((l) => l.trim())
    .filter((l) => l && !/Я МАЛЕНЬКИЙ БОТ/i.test(l))
    .join(' ')
    .trim();
}

export interface ShortDigestResult {
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

const EMPTY_TOPICS: SelectedTopics = { topics: [], sparseWeek: false };
const OK_REVIEW: ReviewResult = { verdict: 'ok', notes: [] };

function topicsList(topics: SelectedTopics): string {
  return topics.topics
    .map((t, i) => `${i + 1}. ${t.title} (${t.sourceUrl}) - ${t.summary}`)
    .join('\n');
}

async function generateShortPost(topics: SelectedTopics, hnContext: string, webContext: string, cfg: ShortDigestConfig, previousIntros?: string[]): Promise<string> {
  const persona = readConfig('kesha-short.txt');
  const now = new Date();
  const date = now.toLocaleDateString('ru-RU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Warsaw',
  });
  const count = topics.topics.length;
  const introsBlock = previousIntros && previousIntros.length > 0
    ? `\n\nПОСЛЕДНИЕ ТВОИ ВСТУПЛЕНИЯ (НЕ повторяй ни словарь, ни структуру - напиши по-другому):\n${previousIntros.slice(-3).join('\n---\n')}`
    : '';
  return callClaude({
    systemPrompt: persona,
    cacheSystem: true,
    userMessage: `Сегодня ${date} по Варшаве.\n\nКонтекст из Hacker News:\n${hnContext}\n\nКонтекст из веб-поиска:\n${webContext}\n\nОтобранные темы (${count}):\n${topicsList(topics)}${introsBlock}\n\nНапиши КОРОТКИЙ дайджест: ровно ${count} буллетов (каждый - строка, начинается с 📎, со ссылкой на источник), плюс короткий вывод в конце. По одному буллету на каждую тему из списка. Начни с живого вступления (1-2 строки), каждый раз новым.`,
    model: cfg.generate.model,
    temperature: cfg.generate.temperature,
    maxTokens: cfg.generate.max_tokens,
    tools: cfg.generate.tools,
  });
}

async function reviewShortPost(draft: string, cfg: ShortDigestConfig): Promise<ReviewResult> {
  const reviewer = readConfig('kesha-short-reviewer.txt');
  return callClaudeStructured<ReviewResult>({
    systemPrompt: reviewer,
    userMessage: draft,
    model: cfg.review.model,
    temperature: cfg.review.temperature,
    maxTokens: cfg.review.max_tokens,
    tool: reviewResultTool,
  });
}

async function rewriteShortPost(draft: string, review: ReviewResult, cfg: ShortDigestConfig): Promise<string> {
  const persona = readConfig('kesha-short.txt');
  const reviewText = review.notes
    .map((n) => `- ${n.issue}${n.quote ? ` (цитата: "${n.quote}")` : ''}${n.suggestion ? ` -> ${n.suggestion}` : ''}`)
    .join('\n');
  return callClaude({
    systemPrompt: persona,
    cacheSystem: true,
    userMessage: `Вот черновик короткого дайджеста:\n\n${draft}\n\nВот фидбек редактора:\n\n${reviewText}\n\nПерепиши с учётом замечаний. Сохрани формат (буллеты с 📎 + короткий вывод) и голос Кеши.`,
    model: cfg.rewrite.model,
    temperature: cfg.rewrite.temperature,
    maxTokens: cfg.rewrite.max_tokens,
    tools: cfg.rewrite.tools,
  });
}

async function fixShortPost(post: string, errors: string[], cfg: ShortDigestConfig): Promise<string> {
  const persona = readConfig('kesha-short.txt');
  return callClaude({
    systemPrompt: persona,
    cacheSystem: true,
    userMessage: `Короткий дайджест не прошёл проверку. Ошибки:\n\n${errors.join('\n')}\n\nВот пост:\n\n${post}\n\nИсправь ТОЛЬКО эти проблемы. Сохрани формат (буллеты с 📎 + короткий вывод) и голос Кеши. Верни только исправленный пост без пояснений.`,
    model: cfg.fix.model,
    temperature: cfg.fix.temperature,
    maxTokens: cfg.fix.max_tokens,
    tools: cfg.fix.tools,
  });
}

export async function generateShortDigest(options: ShortDigestOptions = {}): Promise<ShortDigestResult> {
  const cfg = (JSON.parse(readConfig('pipeline.json')) as { short_digest: ShortDigestConfig }).short_digest;
  const timing: Record<string, number> = {};

  try {
    // Step 0: gather context (HN + light web search in parallel, dedup by memory)
    const t0 = Date.now();
    const excludeUrls = new Set<string>();
    for (const entry of options.memoryEntries ?? []) {
      if (entry.url) excludeUrls.add(normalizeUrl(entry.url));
    }
    const [hnResult, webContext] = await Promise.all([
      fetchHackerNewsContext(excludeUrls).catch((err) => {
        console.warn('[short-digest] HN fetch failed:', err);
        return { context: '', itemCount: 0 };
      }),
      fetchLightWebSearch(excludeUrls),
    ]);
    const hnContext = hnResult.context;
    timing.gatherContext = Date.now() - t0;

    // Step 1: select topics (reused tiered rubric + dedup)
    const t1 = Date.now();
    const selectedTopics = await selectTopicsForContexts(hnContext, webContext, options.memoryEntries);
    timing.selectTopics = Date.now() - t1;

    // Step 2: generate short post
    const t2 = Date.now();
    const draft = await generateShortPost(selectedTopics, hnContext, webContext, cfg, options.previousIntros);
    timing.generate = Date.now() - t2;

    // Step 3: review
    const t3 = Date.now();
    const review = await reviewShortPost(draft, cfg);
    timing.review = Date.now() - t3;

    // Step 4: rewrite only on "rework"
    let finalPost = draft;
    if (review.verdict === 'rework') {
      const t4 = Date.now();
      finalPost = await rewriteShortPost(draft, review, cfg);
      timing.rewrite = Date.now() - t4;
    }

    // Step 5: validate (structural + URL hallucination + exact bullet count), fix up to 2x
    const MAX_FIX_ATTEMPTS = 2;
    const collectErrors = (post: string): string[] => {
      const structural = validateShort(post).errors;
      const hallucinated = findHallucinated(post, [hnContext, webContext]);
      const urlErrors = hallucinated.urls.map(
        (u) => `Hallucinated URL not found in sources: ${u} - replace with a real URL from the provided context`,
      );
      const expected = selectedTopics.topics.length;
      const linked = countLinkedSources(post);
      const countErrors = linked !== expected
        ? [`Expected ${expected} news items, found ${linked} 📎+URL lines`]
        : [];
      return [...structural, ...urlErrors, ...countErrors];
    };

    let postErrors = collectErrors(finalPost);
    for (let attempt = 0; attempt < MAX_FIX_ATTEMPTS && postErrors.length > 0; attempt++) {
      const tFix = Date.now();
      finalPost = await fixShortPost(finalPost, postErrors, cfg);
      timing[`fix${attempt + 1}`] = Date.now() - tFix;
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
    console.error('[short-digest] unexpected error:', err);
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
