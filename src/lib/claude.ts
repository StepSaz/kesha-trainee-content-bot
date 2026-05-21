import Anthropic from '@anthropic-ai/sdk';
import type { ImageMediaType } from './telegram.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CallClaudeParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  temperature: number;
  maxTokens: number;
  tools?: string[];
  conversationHistory?: ConversationTurn[];
  // If true, mark the system prompt with cache_control: ephemeral.
  // Anthropic prefix-caches the (tools + system) block on the first call and
  // serves subsequent calls with identical bytes at ~10% input cost.
  // Useful when the same system prompt is reused across pipeline steps
  // (e.g. kesha-persona in generate → rewrite). 5-minute default TTL.
  cacheSystem?: boolean;
}

function logCacheUsage(label: string, usage: Anthropic.Message['usage'] | undefined): void {
  if (!usage) return; // tests / mocks may omit usage
  const cw = (usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
  const cr = (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  const i = usage.input_tokens;
  const o = usage.output_tokens;
  if (cw || cr) {
    console.log(`[claude:${label}] tokens in=${i} cache_write=${cw} cache_read=${cr} out=${o}`);
  } else {
    console.log(`[claude:${label}] tokens in=${i} out=${o}`);
  }
}

export async function callClaude(params: CallClaudeParams): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tools = params.tools?.includes('web_search')
    ? [{ type: 'web_search_20250305' as const, name: 'web_search' as const }]
    : undefined;

  // Wrap system prompt in a structured block with cache_control when caching is requested.
  // Anthropic silently skips caching for prompts shorter than the model's minimum (4096 for
  // Haiku 4.5, 2048 for Sonnet 4.6), so this is safe to set even on smaller prompts.
  const system = params.cacheSystem
    ? [{ type: 'text' as const, text: params.systemPrompt, cache_control: { type: 'ephemeral' as const } }]
    : params.systemPrompt;

  const response = await client.messages.create({
    model: params.model,
    system,
    messages: [
      ...(params.conversationHistory ?? []),
      { role: 'user', content: params.userMessage },
    ],
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    ...(tools ? { tools } : {}),
  } as any);

  logCacheUsage('callClaude', response.usage);

  return response.content
    .filter((block: Anthropic.ContentBlock): block is Anthropic.TextBlock => block.type === 'text')
    .map((block: Anthropic.TextBlock) => block.text)
    .join('');
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolResult = string | { kind: 'image'; base64: string; mediaType: ImageMediaType };

// Server-side tools (e.g. web_search_20250305) — Anthropic executes them
// internally, no executeTool callback is invoked. Pass them alongside the
// regular ToolDef list and they get merged into the tools array sent to the API.
export interface ServerToolSpec {
  type: string;
  name: string;
  max_uses?: number;
}

export interface CallClaudeWithToolsParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  temperature: number;
  maxTokens: number;
  tools: ToolDef[];
  serverTools?: ServerToolSpec[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  maxIterations: number;
  conversationHistory?: ConversationTurn[];
  // Fires for every tool invocation observed in the response — including
  // server-side ones that don't go through executeTool. Useful for telemetry
  // and tests.
  onToolUse?: (name: string, input: unknown, source: 'client' | 'server') => void;
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((block: Anthropic.ContentBlock): block is Anthropic.TextBlock => block.type === 'text')
    .map((block: Anthropic.TextBlock) => block.text)
    .join('');
}

// When server-side tools (e.g. web_search) are used, Claude often emits a
// short "thinking out loud" text block before the tool call ("копаю минуту…").
// For end-user replies we only want the final answer — text that comes after
// the last server_tool_use block.
function extractFinalText(response: Anthropic.Message): string {
  const blocks = response.content as unknown as { type: string; text?: string }[];
  let lastServerToolIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === 'server_tool_use') lastServerToolIdx = i;
  }
  if (lastServerToolIdx === -1) return extractText(response);
  return blocks
    .slice(lastServerToolIdx + 1)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('');
}

// EXPERIMENT (2026-05-15): tool-use comment replies — see CLAUDE.md
// Agentic loop: model decides when to call view_image / extract_url.
// Note: conversationHistory carries only plain-text turns (final user/assistant).
// Tool roundtrips are appended fresh each call and not persisted by callers.
export async function callClaudeWithTools(params: CallClaudeWithToolsParams): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages: Anthropic.MessageParam[] = [
    ...(params.conversationHistory ?? []),
    { role: 'user', content: params.userMessage },
  ];

  const mergedTools = [...(params.serverTools ?? []), ...params.tools];

  for (let i = 0; i < params.maxIterations; i++) {
    const response = await client.messages.create({
      model: params.model,
      system: params.systemPrompt,
      messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      tools: mergedTools as unknown as Anthropic.Tool[],
    } as any);

    // Surface server-side tool calls for telemetry/tests even though they
    // don't need a client-side response.
    if (params.onToolUse) {
      for (const block of response.content) {
        const b = block as unknown as { type: string; name?: string; input?: unknown };
        if (b.type === 'server_tool_use' && b.name) {
          params.onToolUse(b.name, b.input, 'server');
        }
      }
    }

    if (response.stop_reason !== 'tool_use') {
      return extractFinalText(response);
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter(
      (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      console.log(`[claude:tools] iteration=${i + 1} tool=${block.name} input=${JSON.stringify(block.input)}`);
      if (params.onToolUse) params.onToolUse(block.name, block.input, 'client');
      const result = await params.executeTool(block.name, block.input as Record<string, unknown>);
      if (typeof result === 'string') {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: result.mediaType, data: result.base64 },
          }],
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  console.log(`[claude:tools] max iterations (${params.maxIterations}) reached — forcing final answer without tools`);
  const final = await client.messages.create({
    model: params.model,
    system: params.systemPrompt,
    messages,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
  } as any);
  const text = extractFinalText(final);
  // Defensive fallback: if the model still emitted only tool_use (no text) on the no-tools call,
  // we'd otherwise drop the reply silently. Better to say something honest.
  return text || 'что-то я завис на этом вопросе, попробуй переформулировать 🐤';
}

export interface CallClaudeStructuredParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  temperature: number;
  maxTokens: number;
  tool: ToolDef;
  // See callClaude.cacheSystem — same semantics.
  cacheSystem?: boolean;
}

// Forces the model to call a single tool and returns its parsed input as a typed object.
// Anthropic tool_choice: { type: 'tool', name } guarantees a tool_use block — no prose fallback.
export async function callClaudeStructured<T>(params: CallClaudeStructuredParams): Promise<T> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const system = params.cacheSystem
    ? [{ type: 'text' as const, text: params.systemPrompt, cache_control: { type: 'ephemeral' as const } }]
    : params.systemPrompt;

  const response = await client.messages.create({
    model: params.model,
    system,
    messages: [{ role: 'user', content: params.userMessage }],
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    tools: [params.tool],
    tool_choice: { type: 'tool', name: params.tool.name },
  } as any);

  logCacheUsage('callClaudeStructured', response.usage);

  const block = response.content.find(
    (b: Anthropic.ContentBlock) => b.type === 'tool_use' && b.name === params.tool.name,
  ) as Anthropic.ToolUseBlock | undefined;

  if (!block) {
    throw new Error(`No tool_use block for ${params.tool.name} in response`);
  }

  return block.input as T;
}
