import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../claude.js', () => ({ callClaude: vi.fn(), callClaudeStructured: vi.fn() }));
vi.mock('../sources.js', async () => {
  const actual = await vi.importActual<typeof import('../sources.js')>('../sources.js');
  return { ...actual, fetchHackerNewsContext: vi.fn(), fetchLightWebSearch: vi.fn() };
});
vi.mock('../pipeline.js', () => ({
  selectTopicsForContexts: vi.fn(),
  reviewResultTool: { name: 'review_post', description: '', input_schema: {} },
}));
vi.mock('../validator.js', () => ({ validateShort: vi.fn(), countLinkedSources: vi.fn() }));
vi.mock('../url-checker.js', () => ({ findHallucinated: vi.fn() }));

import { generateShortDigest } from '../short-digest.js';
import { callClaude, callClaudeStructured } from '../claude.js';
import { fetchHackerNewsContext, fetchLightWebSearch } from '../sources.js';
import { selectTopicsForContexts } from '../pipeline.js';
import { validateShort, countLinkedSources } from '../validator.js';
import { findHallucinated } from '../url-checker.js';
import type { SelectedTopics, ReviewResult } from '../pipeline.js';

const mockCallClaude = vi.mocked(callClaude);
const mockCallClaudeStructured = vi.mocked(callClaudeStructured);
const mockFetchHN = vi.mocked(fetchHackerNewsContext);
const mockFetchWeb = vi.mocked(fetchLightWebSearch);
const mockSelectTopics = vi.mocked(selectTopicsForContexts);
const mockValidateShort = vi.mocked(validateShort);
const mockCountLinked = vi.mocked(countLinkedSources);
const mockFindHallucinated = vi.mocked(findHallucinated);

const topic = (title = 'A'): SelectedTopics['topics'][0] => ({
  title, summary: 's', sourceUrl: 'https://u', sourceOrigin: 'web', tier: 1,
});
const topics = (n: number): SelectedTopics => ({
  topics: Array.from({ length: n }, (_, i) => topic(`Topic ${i + 1}`)),
  sparseWeek: false,
});
const okReview: ReviewResult = { verdict: 'ok', notes: [] };
const SHORT_POST = 'short digest text';

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchHN.mockResolvedValue({ context: 'HN ctx', itemCount: 10 });
  mockFetchWeb.mockResolvedValue('WEB ctx');
  mockSelectTopics.mockResolvedValue(topics(3));
  mockValidateShort.mockReturnValue({ valid: true, errors: [] });
  mockCountLinked.mockReturnValue(3); // matches topics(3) by default
  mockFindHallucinated.mockReturnValue({ urls: [], handles: [] });
});

describe('generateShortDigest', () => {
  it('returns success with post when review is ok (no rewrite, no fix)', async () => {
    mockCallClaude.mockResolvedValueOnce(SHORT_POST);     // generate
    mockCallClaudeStructured.mockResolvedValueOnce(okReview); // review

    const result = await generateShortDigest();

    expect(result.success).toBe(true);
    expect(result.post).toBe(SHORT_POST);
    expect(mockCallClaude).toHaveBeenCalledTimes(1);          // generate only
    expect(mockCallClaudeStructured).toHaveBeenCalledTimes(1); // review only
    expect(result.timing).not.toHaveProperty('rewrite');
    expect(result.timing).not.toHaveProperty('fix1');
  });

  it('rewrites when review verdict is rework', async () => {
    const rewritten = SHORT_POST + ' (rewritten)';
    mockCallClaude.mockResolvedValueOnce(SHORT_POST).mockResolvedValueOnce(rewritten);
    mockCallClaudeStructured.mockResolvedValueOnce({ verdict: 'rework', notes: [{ issue: 'generic' }] });

    const result = await generateShortDigest();

    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(result.draft).toBe(SHORT_POST);
    expect(result.post).toBe(rewritten);
    expect(result.timing).toHaveProperty('rewrite');
  });

  it('fixes when bullet count does not match selected topics', async () => {
    mockSelectTopics.mockResolvedValue(topics(5));
    mockCallClaude.mockResolvedValueOnce('post with 4 bullets').mockResolvedValueOnce('post with 5 bullets');
    mockCallClaudeStructured.mockResolvedValueOnce(okReview);
    mockCountLinked.mockReturnValueOnce(4).mockReturnValueOnce(5); // mismatch then fixed

    const result = await generateShortDigest();

    expect(result.success).toBe(true);
    expect(result.timing).toHaveProperty('fix1');
    expect(result.errors).toBeUndefined();
  });

  it('fixes when a hallucinated URL is present', async () => {
    mockCallClaude.mockResolvedValueOnce('bad').mockResolvedValueOnce('good');
    mockCallClaudeStructured.mockResolvedValueOnce(okReview);
    mockFindHallucinated
      .mockReturnValueOnce({ urls: ['https://fake.example.com'], handles: [] })
      .mockReturnValueOnce({ urls: [], handles: [] });

    const result = await generateShortDigest();

    expect(result.success).toBe(true);
    expect(result.timing).toHaveProperty('fix1');
  });

  it('returns failure when validation still fails after 2 fixes', async () => {
    mockCallClaude.mockResolvedValue('still bad');
    mockCallClaudeStructured.mockResolvedValueOnce(okReview);
    mockValidateShort.mockReturnValue({ valid: false, errors: ['Missing conclusion after last source line'] });

    const result = await generateShortDigest();

    expect(result.success).toBe(false);
    expect(result.post).toBeUndefined();
    expect(result.errors).toContain('Missing conclusion after last source line');
    expect(result.timing).toHaveProperty('fix1');
    expect(result.timing).toHaveProperty('fix2');
  });

  it('exposes hnContext and webContext in the result', async () => {
    mockCallClaude.mockResolvedValueOnce(SHORT_POST);
    mockCallClaudeStructured.mockResolvedValueOnce(okReview);

    const result = await generateShortDigest();

    expect(result.hnContext).toBe('HN ctx');
    expect(result.webContext).toBe('WEB ctx');
  });
});
