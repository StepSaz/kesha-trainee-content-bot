import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockSetJSON = vi.fn();

vi.mock('@netlify/blobs', () => ({
  getStore: () => ({ get: mockGet, setJSON: mockSetJSON }),
}));

import { loadMemory, appendMemory, type MemoryEntry } from '../memory.js';

beforeEach(() => vi.clearAllMocks());

const entry = (title: string, daysAgo = 0): MemoryEntry => ({
  url: 'https://example.com',
  title,
  publishedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  postId: null,
});

describe('loadMemory', () => {
  it('returns [] when both blobs absent', async () => {
    mockGet.mockResolvedValue(null);
    expect(await loadMemory()).toEqual([]);
    expect(mockSetJSON).not.toHaveBeenCalled();
  });

  it('returns memory-v1 when present', async () => {
    const entries = [entry('Claude 4.7 release')];
    mockGet.mockResolvedValue(entries);
    expect(await loadMemory()).toEqual(entries);
  });

  it('migrates published-topics when memory-v1 absent', async () => {
    const oldTopics = ['1. [T1] Claude 4.7 релиз (hn)\n2. [T2] OpenAI DevDay (web)'];
    mockGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(oldTopics);
    const result = await loadMemory();
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Claude 4.7 релиз');
    expect(result[1].title).toBe('OpenAI DevDay');
    expect(result[0].url).toBe('');
    expect(result[0].postId).toBeNull();
    expect(mockSetJSON).toHaveBeenCalledWith('memory-v1', result);
  });
});

describe('appendMemory', () => {
  it('appends entries to existing memory', async () => {
    const existing = [entry('Old topic')];
    mockGet.mockResolvedValue(existing);
    const newEntry = entry('New topic');
    await appendMemory([newEntry]);
    expect(mockSetJSON).toHaveBeenCalledWith('memory-v1', [...existing, newEntry]);
  });

  it('starts from empty when blob absent', async () => {
    mockGet.mockResolvedValue(null);
    const newEntry = entry('First ever');
    await appendMemory([newEntry]);
    expect(mockSetJSON).toHaveBeenCalledWith('memory-v1', [newEntry]);
  });

  it('trims to 40 entries FIFO when over limit', async () => {
    const existing: MemoryEntry[] = Array.from({ length: 40 }, (_, i) =>
      entry(`Entry ${i}`));
    mockGet.mockResolvedValue(existing);
    await appendMemory([entry('New')]);
    const saved = mockSetJSON.mock.calls[0][1] as MemoryEntry[];
    expect(saved).toHaveLength(40);
    expect(saved[0].title).toBe('Entry 1');
    expect(saved[39].title).toBe('New');
  });
});
