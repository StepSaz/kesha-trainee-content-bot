import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-level mock — Vitest hoists this automatically
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { callClaude } from '../claude.js';

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
});
