import Anthropic from '@anthropic-ai/sdk';

export interface CallClaudeParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  temperature: number;
  maxTokens: number;
  tools?: string[];
}

export async function callClaude(params: CallClaudeParams): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tools = params.tools?.includes('web_search')
    ? [{ type: 'web_search_20250305' as const, name: 'web_search' as const }]
    : undefined;

  const response = await client.messages.create({
    model: params.model,
    system: params.systemPrompt,
    messages: [{ role: 'user', content: params.userMessage }],
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    ...(tools ? { tools } : {}),
  } as any);

  return response.content
    .filter((block: Anthropic.ContentBlock): block is Anthropic.TextBlock => block.type === 'text')
    .map((block: Anthropic.TextBlock) => block.text)
    .join('');
}
