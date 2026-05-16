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
}

export async function callClaude(params: CallClaudeParams): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tools = params.tools?.includes('web_search')
    ? [{ type: 'web_search_20250305' as const, name: 'web_search' as const }]
    : undefined;

  const response = await client.messages.create({
    model: params.model,
    system: params.systemPrompt,
    messages: [
      ...(params.conversationHistory ?? []),
      { role: 'user', content: params.userMessage },
    ],
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    ...(tools ? { tools } : {}),
  } as any);

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

export interface CallClaudeWithToolsParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  temperature: number;
  maxTokens: number;
  tools: ToolDef[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  maxIterations: number;
  conversationHistory?: ConversationTurn[];
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((block: Anthropic.ContentBlock): block is Anthropic.TextBlock => block.type === 'text')
    .map((block: Anthropic.TextBlock) => block.text)
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

  for (let i = 0; i < params.maxIterations; i++) {
    const response = await client.messages.create({
      model: params.model,
      system: params.systemPrompt,
      messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      tools: params.tools as unknown as Anthropic.Tool[],
    } as any);

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter(
      (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      console.log(`[claude:tools] iteration=${i + 1} tool=${block.name} input=${JSON.stringify(block.input)}`);
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
  const text = extractText(final);
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
}

// Forces the model to call a single tool and returns its parsed input as a typed object.
// Anthropic tool_choice: { type: 'tool', name } guarantees a tool_use block — no prose fallback.
export async function callClaudeStructured<T>(params: CallClaudeStructuredParams): Promise<T> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: params.model,
    system: params.systemPrompt,
    messages: [{ role: 'user', content: params.userMessage }],
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    tools: [params.tool],
    tool_choice: { type: 'tool', name: params.tool.name },
  } as any);

  const block = response.content.find(
    (b: Anthropic.ContentBlock) => b.type === 'tool_use' && b.name === params.tool.name,
  ) as Anthropic.ToolUseBlock | undefined;

  if (!block) {
    throw new Error(`No tool_use block for ${params.tool.name} in response`);
  }

  return block.input as T;
}
