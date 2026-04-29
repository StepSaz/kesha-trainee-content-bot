import { readFileSync } from 'fs';
import { join } from 'path';
import { callClaude } from './claude.js';
import { validateBossPost } from './validator.js';

function readConfig(filename: string): string {
  return readFileSync(join(process.cwd(), 'src/config', filename), 'utf-8');
}

interface BossModelConfig {
  model: string;
  temperature: number;
  max_tokens: number;
}

interface BossCommandConfig {
  models: {
    review: BossModelConfig;
    rewrite: BossModelConfig;
  };
}

export interface BossReviewOutput {
  verdict: 'READY' | 'RAW';
  verdict_reason: string;
  corrected_text: string;
  grammar_notes: string;
}

export interface BossPipelineOptions {
  forceRaw?: boolean;
  forceSkip?: boolean;
}

export interface BossPipelineResult {
  success: boolean;
  branch: 'READY' | 'RAW';
  finalText: string;
  reviewOutput: BossReviewOutput;
  rewriteOutput: string | null;
  error?: string;
}

async function runReview(text: string, cfg: BossModelConfig): Promise<BossReviewOutput> {
  const systemPrompt = readConfig('boss-review.txt');

  async function attempt(extra?: string): Promise<BossReviewOutput> {
    const raw = await callClaude({
      systemPrompt: extra ? `${systemPrompt}\n\n${extra}` : systemPrompt,
      userMessage: text,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.max_tokens,
    });
    return JSON.parse(raw) as BossReviewOutput;
  }

  try {
    return await attempt();
  } catch {
    console.log('[boss-pipeline] review JSON parse failed, retrying...');
    return await attempt('ВАЖНО: верни СТРОГО валидный JSON без преамбулы, первым символом должен быть {');
  }
}

function hasFormattingProblems(text: string): boolean {
  return text.includes('\u2014') || /\*\*|##|```/.test(text);
}

async function runRewrite(correctedText: string, cfg: BossModelConfig): Promise<string> {
  const systemPrompt = readConfig('boss-rewrite.txt');

  async function attempt(extra?: string): Promise<string> {
    return callClaude({
      systemPrompt: extra ? `${systemPrompt}\n\n${extra}` : systemPrompt,
      userMessage: correctedText,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.max_tokens,
    });
  }

  const result = await attempt();
  if (!hasFormattingProblems(result)) return result;

  console.log('[boss-pipeline] rewrite has em-dash/markdown, retrying...');
  const retry = await attempt('СТОП: em-dash (—) ЗАПРЕЩЁН, используй дефис (-). Markdown (**, ##, ```) ЗАПРЕЩЁН. Верни только plain text.');
  if (!hasFormattingProblems(retry)) return retry;

  throw new Error('Rewrite contains em-dash or markdown after retry');
}

export async function runBossPipeline(
  text: string,
  options: BossPipelineOptions,
  onProgress?: (status: string) => Promise<void>
): Promise<BossPipelineResult> {
  let pipelineConfig: { boss_command: BossCommandConfig };
  try {
    pipelineConfig = JSON.parse(readConfig('pipeline.json')) as { boss_command: BossCommandConfig };
  } catch (err) {
    return {
      success: false,
      branch: 'READY',
      finalText: '',
      reviewOutput: { verdict: 'READY', verdict_reason: '', corrected_text: '', grammar_notes: '' },
      rewriteOutput: null,
      error: `Config load failed: ${String(err)}`,
    };
  }
  const cfg = pipelineConfig.boss_command;

  console.log(`[boss-pipeline] start length=${text.length} forceRaw=${options.forceRaw ?? false} forceSkip=${options.forceSkip ?? false}`);
  console.log(`[boss-pipeline] input: ${text}`);

  let reviewOutput: BossReviewOutput;
  try {
    reviewOutput = await runReview(text, cfg.models.review);
  } catch (err) {
    console.error('[boss-pipeline] review failed:', err);
    return {
      success: false,
      branch: 'READY',
      finalText: '',
      reviewOutput: { verdict: 'READY', verdict_reason: '', corrected_text: '', grammar_notes: '' },
      rewriteOutput: null,
      error: `Review failed: ${String(err)}`,
    };
  }

  console.log(`[boss-pipeline] verdict=${reviewOutput.verdict} reason=${reviewOutput.verdict_reason}`);
  console.log(`[boss-pipeline] corrected_text: ${reviewOutput.corrected_text}`);

  const branch: 'READY' | 'RAW' = options.forceSkip
    ? 'READY'
    : options.forceRaw
      ? 'RAW'
      : reviewOutput.verdict;

  console.log(`[boss-pipeline] branch=${branch}`);

  if (branch === 'READY') {
    const finalText = reviewOutput.corrected_text;
    const validation = validateBossPost(finalText);
    if (!validation.valid) {
      return { success: false, branch, finalText, reviewOutput, rewriteOutput: null, error: validation.errors.join('; ') };
    }
    console.log('[boss-pipeline] READY done');
    return { success: true, branch, finalText, reviewOutput, rewriteOutput: null };
  }

  if (onProgress) await onProgress('✍️ Текст сыроват, переписываю голосом Кеши...');

  let rewriteOutput: string;
  try {
    rewriteOutput = await runRewrite(reviewOutput.corrected_text, cfg.models.rewrite);
  } catch (err) {
    console.error('[boss-pipeline] rewrite failed:', err);
    return { success: false, branch, finalText: '', reviewOutput, rewriteOutput: null, error: String(err) };
  }

  console.log(`[boss-pipeline] rewrite done: ${rewriteOutput}`);

  const validation = validateBossPost(rewriteOutput);
  if (!validation.valid) {
    return { success: false, branch, finalText: rewriteOutput, reviewOutput, rewriteOutput, error: validation.errors.join('; ') };
  }

  return { success: true, branch, finalText: rewriteOutput, reviewOutput, rewriteOutput };
}
