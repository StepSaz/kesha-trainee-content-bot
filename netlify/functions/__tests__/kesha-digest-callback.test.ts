import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = {
  get: vi.fn(),
  setJSON: vi.fn(),
  delete: vi.fn(),
  getWithMetadata: vi.fn(),
};

vi.mock('@netlify/blobs', () => ({ getStore: vi.fn(() => store) }));
vi.mock('../../../src/lib/telegram.js', () => ({
  sendToChannel: vi.fn(),
  sendMessage: vi.fn(),
  editMessageText: vi.fn(),
  answerCallbackQuery: vi.fn(),
}));
vi.mock('../../../src/lib/recent-posts.js', () => ({
  appendPublishedPost: vi.fn(),
  loadRecentPosts: vi.fn(),
}));
vi.mock('../../../src/lib/memory.js', () => ({
  appendMemory: vi.fn(),
  loadMemory: vi.fn(),
}));

import { handleDigestCallback } from '../kesha-boss-background.mts';
import { sendToChannel, answerCallbackQuery } from '../../../src/lib/telegram.js';
import { appendMemory } from '../../../src/lib/memory.js';

const mockSendToChannel = vi.mocked(sendToChannel);
const mockAnswerCallback = vi.mocked(answerCallbackQuery);
const mockAppendMemory = vi.mocked(appendMemory);

const BOSS_ID = 352830345;
const CHAT_ID = '5';

const basePending = {
  id: 'abc',
  chatId: CHAT_ID,
  progressMessageId: 1,
  post: 'POST BODY',
  selectedTopics: { topics: [{ title: 'T1', summary: 's', sourceUrl: 'https://u/1', sourceOrigin: 'web', tier: 1 }], sparseWeek: false },
  createdAt: new Date().toISOString(),
};

const callback = (data: string, fromId = BOSS_ID, chatId = CHAT_ID) => ({
  id: 'cbq',
  from: { id: fromId },
  message: { message_id: 9, chat: { id: Number(chatId) } },
  data,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_CHAT_ID = 'channel';
  process.env.TELEGRAM_BOSS_USER_IDS = String(BOSS_ID);
  mockSendToChannel.mockResolvedValue({ success: true, messageId: 42 });
});

describe('handleDigestCallback publish path', () => {
  it('short: appends memory + writes previous-short-intros, NOT digest-last-manual-at or previous-intros', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'short', newShortIntros: ['short-intro-1'] });
    await handleDigestCallback(callback('digest_prod:abc') as any);

    expect(mockSendToChannel).toHaveBeenCalledWith('POST BODY', 'channel');
    expect(mockAppendMemory).toHaveBeenCalledTimes(1);
    const setKeys = store.setJSON.mock.calls.map((c) => c[0]);
    expect(setKeys).not.toContain('digest-last-manual-at');
    expect(setKeys).not.toContain('previous-intros');
    const shortIntroCall = store.setJSON.mock.calls.find((c) => c[0] === 'previous-short-intros');
    expect(shortIntroCall).toBeDefined();
    expect(shortIntroCall![1]).toEqual(['short-intro-1']);
  });

  it('full: appends memory AND writes digest-last-manual-at + previous-intros', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'full', newIntros: ['intro-1'] });
    await handleDigestCallback(callback('digest_prod:abc') as any);

    expect(mockAppendMemory).toHaveBeenCalledTimes(1);
    const setKeys = store.setJSON.mock.calls.map((c) => c[0]);
    expect(setKeys).toContain('digest-last-manual-at');
    const introCall = store.setJSON.mock.calls.find((c) => c[0] === 'previous-intros');
    expect(introCall).toBeDefined();
    expect(introCall![1]).toEqual(['intro-1']);
  });

  it('stale id: does not publish', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'short' });
    await handleDigestCallback(callback('digest_prod:WRONG') as any);
    expect(mockSendToChannel).not.toHaveBeenCalled();
  });

  it('malformed callback data: no-op, no publish', async () => {
    await handleDigestCallback(callback('digest_prod') as any);
    await handleDigestCallback(callback('digest_prod:') as any);
    await handleDigestCallback(callback('digest_x:abc') as any);
    expect(mockSendToChannel).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled(); // returns before loading pending
  });

  it('non-owner click: does not publish', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'short' });
    await handleDigestCallback(callback('digest_prod:abc', 999) as any);
    expect(mockSendToChannel).not.toHaveBeenCalled();
    expect(mockAnswerCallback).toHaveBeenCalledWith('cbq', 'Только для начальника 🐤');
  });

  it('click from a different chat than the preview: does not publish', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'short', chatId: '5' });
    await handleDigestCallback(callback('digest_prod:abc', BOSS_ID, '777') as any);
    expect(mockSendToChannel).not.toHaveBeenCalled();
  });

  it('cancel: deletes pending, does not publish', async () => {
    store.get.mockResolvedValueOnce({ ...basePending, variant: 'short' });
    await handleDigestCallback(callback('digest_cancel:abc') as any);
    expect(store.delete).toHaveBeenCalledWith('pending-digest');
    expect(mockSendToChannel).not.toHaveBeenCalled();
  });
});
