import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// @ts-expect-error TS5097 — tsconfig lacks allowImportingTsExtensions; vitest resolves .mts fine
import handler from '../kesha-boss-background.mts';
import { sendMessage } from '../../../src/lib/telegram.js';

const mockSendMessage = vi.mocked(sendMessage);

const SECRET = 'test-webhook-secret';

// A /notes text without a document: cheap deterministic path that replies via sendMessage.
const notesUpdate = {
  update_id: 1,
  message: {
    message_id: 1,
    from: { id: 352830345 },
    chat: { id: 5, type: 'private' },
    text: '/notes',
  },
};

const makeRequest = (body: unknown, secretHeader?: string) =>
  new Request('https://example.test/.netlify/functions/kesha-boss-background', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secretHeader !== undefined ? { 'X-Telegram-Bot-Api-Secret-Token': secretHeader } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

describe('webhook secret verification', () => {
  it('secret configured + missing header: 401, update not processed', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const res = await handler(makeRequest(notesUpdate));
    expect(res.status).toBe(401);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('secret configured + wrong header: 401, update not processed', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const res = await handler(makeRequest(notesUpdate, 'wrong-secret'));
    expect(res.status).toBe(401);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('secret configured + correct header: update is processed normally', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const res = await handler(makeRequest(notesUpdate, SECRET));
    expect(res.status).toBe(202);
    expect(mockSendMessage).toHaveBeenCalledWith('5', expect.stringContaining('/notes'));
  });

  it('secret configured + correct header + malformed body: reaches JSON parsing (400)', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const res = await handler(makeRequest('not json', SECRET));
    expect(res.status).toBe(400);
  });

  it('secret NOT configured: verification is skipped (local/test mode)', async () => {
    const res = await handler(makeRequest(notesUpdate));
    expect(res.status).toBe(202);
    expect(mockSendMessage).toHaveBeenCalled();
  });
});
