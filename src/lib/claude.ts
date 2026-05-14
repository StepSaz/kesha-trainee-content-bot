import Anthropic from '@anthropic-ai/sdk';

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
