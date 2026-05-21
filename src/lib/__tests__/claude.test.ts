import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-level mock — Vitest hoists this automatically
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { callClaude, callClaudeWithTools, type ToolDef, type ToolResult } from '../claude.js';

const BASE_PARAMS = {
  systemPrompt: 'You are helpful.',
  userMessage: 'Hello',
  model: 'claude-sonnet-4-6',
  temperature: 0.5,
  maxTokens: 100,
};

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockCreate.mockReset();
});

describe('callClaude', () => {
  it('returns concatenated text blocks, filtering out non-text blocks', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', id: 'tu_1', name: 'web_search', input: {} },
        { type: 'text', text: 'world' },
      ],
    });

    const result = await callClaude(BASE_PARAMS);

    expect(result).toBe('Hello world');
  });

  it('includes web_search tool when tools contains web_search', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'result' }] });

    await callClaude({ ...BASE_PARAMS, tools: ['web_search'] });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      })
    );
  });

  it('does not include tools when tools is empty', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'result' }] });

    await callClaude({ ...BASE_PARAMS, tools: [] });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toBeUndefined();
  });

  it('does not include tools when tools param is omitted', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'result' }] });

    await callClaude(BASE_PARAMS);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toBeUndefined();
  });

  it('passes model, temperature, max_tokens to API', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    await callClaude({ ...BASE_PARAMS, model: 'claude-sonnet-4-6', temperature: 0.8, maxTokens: 4096 });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        temperature: 0.8,
        max_tokens: 4096,
      })
    );
  });

  it('passes system prompt as plain string when cacheSystem is not set', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    await callClaude(BASE_PARAMS);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'You are helpful.' })
    );
  });

  it('wraps system prompt in structured block with cache_control when cacheSystem is true', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    await callClaude({ ...BASE_PARAMS, cacheSystem: true });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: [{
          type: 'text',
          text: 'You are helpful.',
          cache_control: { type: 'ephemeral' },
        }],
      })
    );
  });
});

describe('callClaudeWithTools', () => {
  const TOOLS: ToolDef[] = [
    {
      name: 'extract_url',
      description: 'fetch a url',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  ];

  it('returns text immediately when first response is end_turn (no tools used)', async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'no tools needed' }],
    });

    const executeTool = vi.fn();
    const result = await callClaudeWithTools({
      ...BASE_PARAMS,
      tools: TOOLS,
      executeTool,
      maxIterations: 3,
    });

    expect(result).toBe('no tools needed');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('executes tool, sends result back, returns final text', async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'extract_url', input: { url: 'https://a.com' } }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'final answer using tool result' }],
      });

    const executeTool = vi.fn().mockResolvedValue('tool returned this text');
    const result = await callClaudeWithTools({
      ...BASE_PARAMS,
      tools: TOOLS,
      executeTool,
      maxIterations: 3,
    });

    expect(result).toBe('final answer using tool result');
    expect(executeTool).toHaveBeenCalledWith('extract_url', { url: 'https://a.com' });
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // Second call should include the tool_use assistant block + tool_result user block
    const secondCallMessages = (mockCreate.mock.calls[1][0] as any).messages;
    expect(secondCallMessages.at(-2)).toMatchObject({
      role: 'assistant',
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'tool_use', id: 'tu_1' }),
      ]),
    });
    expect(secondCallMessages.at(-1)).toMatchObject({
      role: 'user',
      content: [
        expect.objectContaining({
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: 'tool returned this text',
        }),
      ],
    });
  });

  it('passes image tool result as image content block', async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'view_image', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'I see a cat' }],
      });

    const executeTool = vi.fn().mockResolvedValue({
      kind: 'image',
      base64: 'BASE64DATA',
      mediaType: 'image/jpeg',
    } as ToolResult);

    await callClaudeWithTools({
      ...BASE_PARAMS,
      tools: TOOLS,
      executeTool,
      maxIterations: 3,
    });

    const secondCallMessages = (mockCreate.mock.calls[1][0] as any).messages;
    expect(secondCallMessages.at(-1).content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_2',
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'BASE64DATA' },
      }],
    });
  });

  it('forces final answer without tools when max iterations exhausted', async () => {
    // All 3 iterations return tool_use; 4th call (forced final) returns text without tools
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'extract_url', input: { url: 'https://x' } }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't2', name: 'extract_url', input: { url: 'https://y' } }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't3', name: 'extract_url', input: { url: 'https://z' } }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'forced answer' }],
      });

    const executeTool = vi.fn().mockResolvedValue('something');
    const result = await callClaudeWithTools({
      ...BASE_PARAMS,
      tools: TOOLS,
      executeTool,
      maxIterations: 3,
    });

    expect(result).toBe('forced answer');
    expect(mockCreate).toHaveBeenCalledTimes(4);
    expect(executeTool).toHaveBeenCalledTimes(3);
    // Forced-final call has no tools field
    const finalCall = mockCreate.mock.calls[3][0] as any;
    expect(finalCall.tools).toBeUndefined();
  });

  it('returns defensive fallback when forced-final has no text content', async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'extract_url', input: { url: 'https://x' } }],
      })
      .mockResolvedValueOnce({
        // Pathological: model still emits tool_use even without tools offered
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't2', name: 'extract_url', input: { url: 'https://y' } }],
      });

    const executeTool = vi.fn().mockResolvedValue('x');
    const result = await callClaudeWithTools({
      ...BASE_PARAMS,
      tools: TOOLS,
      executeTool,
      maxIterations: 1,
    });

    expect(result).toContain('завис');
  });

  it('handles multiple tool_use blocks in a single response', async () => {
    mockCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'a', name: 'extract_url', input: { url: 'https://1' } },
          { type: 'tool_use', id: 'b', name: 'extract_url', input: { url: 'https://2' } },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'combined' }],
      });

    const executeTool = vi.fn()
      .mockResolvedValueOnce('content-1')
      .mockResolvedValueOnce('content-2');

    const result = await callClaudeWithTools({
      ...BASE_PARAMS,
      tools: TOOLS,
      executeTool,
      maxIterations: 3,
    });

    expect(result).toBe('combined');
    expect(executeTool).toHaveBeenCalledTimes(2);
    const followupContent = (mockCreate.mock.calls[1][0] as any).messages.at(-1).content;
    expect(followupContent).toHaveLength(2);
    expect(followupContent[0]).toMatchObject({ tool_use_id: 'a', content: 'content-1' });
    expect(followupContent[1]).toMatchObject({ tool_use_id: 'b', content: 'content-2' });
  });
});
