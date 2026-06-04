import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = { get: vi.fn(), setJSON: vi.fn(), delete: vi.fn(), getWithMetadata: vi.fn() };
vi.mock('@netlify/blobs', () => ({ getStore: vi.fn(() => store) }));
vi.mock('../../../src/lib/telegram.js', () => ({ sendToChannel: vi.fn() }));
vi.mock('../../../src/lib/memory.js', () => ({ loadMemory: vi.fn(), appendMemory: vi.fn() }));
vi.mock('../../../src/lib/recent-posts.js', () => ({ appendPublishedPost: vi.fn() }));
vi.mock('../../../src/lib/managed-agent.js', () => ({ generateManagedPost: vi.fn() }));
vi.mock('../../../src/lib/cron-guard.js', () => ({ shouldSuppressCron: vi.fn(() => false) }));
vi.mock('../../../src/lib/pipeline.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/pipeline.js')>('../../../src/lib/pipeline.js');
  return { ...actual, generatePipelinePost: vi.fn() };
});
vi.mock('../../../src/lib/short-digest.js', () => ({ generateShortDigest: vi.fn() }));

import cronHandler from '../kesha-post-background.mts';
import { generatePipelinePost } from '../../../src/lib/pipeline.js';
import { generateShortDigest } from '../../../src/lib/short-digest.js';
import { sendToChannel } from '../../../src/lib/telegram.js';
import { loadMemory } from '../../../src/lib/memory.js';

const mockPipeline = vi.mocked(generatePipelinePost);
const mockShort = vi.mocked(generateShortDigest);
const mockSend = vi.mocked(sendToChannel);
const mockLoadMemory = vi.mocked(loadMemory);

const okResult = (post: string) => ({
  success: true,
  post,
  hnContext: '', webContext: '',
  selectedTopics: { topics: [{ title: 'T', summary: 's', sourceUrl: 'https://u/1', sourceOrigin: 'web', tier: 1 }], sparseWeek: false },
  draft: post, review: { verdict: 'ok', notes: [] }, timing: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.KESHA_ENABLED = 'true';
  process.env.KESHA_CRON_CHANNEL = 'test';
  process.env.TELEGRAM_TEST_CHAT_ID = 'test-chan';
  process.env.TELEGRAM_CHAT_ID = 'prod-chan';
  delete process.env.KESHA_MODE;
  mockLoadMemory.mockResolvedValue([]);
  store.get.mockResolvedValue(null);
  mockSend.mockResolvedValue({ success: true, messageId: 7 });
});

describe('cron digest format selection', () => {
  it('default (full): calls generatePipelinePost, writes previous-intros', async () => {
    delete process.env.KESHA_DIGEST_FORMAT;
    mockPipeline.mockResolvedValue(okResult('full post ~ ~ ~ body') as any);

    await cronHandler();

    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(mockShort).not.toHaveBeenCalled();
    const setKeys = store.setJSON.mock.calls.map((c) => c[0]);
    expect(setKeys).toContain('previous-intros');
  });

  it('KESHA_DIGEST_FORMAT=short: calls generateShortDigest, does NOT write previous-intros', async () => {
    process.env.KESHA_DIGEST_FORMAT = 'short';
    mockShort.mockResolvedValue(okResult('📎 a https://u/1') as any);

    await cronHandler();

    expect(mockShort).toHaveBeenCalledTimes(1);
    expect(mockPipeline).not.toHaveBeenCalled();
    const setKeys = store.setJSON.mock.calls.map((c) => c[0]);
    expect(setKeys).not.toContain('previous-intros');
    expect(mockSend).toHaveBeenCalledWith('📎 a https://u/1', 'test-chan');
  });
});
