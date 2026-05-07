import { describe, it, expect } from 'vitest';
import { shouldSuppressCron } from '../cron-guard.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

describe('shouldSuppressCron', () => {
  it('returns false when publishedAt is null', () => {
    expect(shouldSuppressCron(null, now)).toBe(false);
  });

  it('returns true when published 1 day ago', () => {
    expect(shouldSuppressCron(new Date(now - DAY).toISOString(), now)).toBe(true);
  });

  it('returns true when published 6 days ago', () => {
    expect(shouldSuppressCron(new Date(now - 6 * DAY).toISOString(), now)).toBe(true);
  });

  it('returns false when published exactly 7 days ago', () => {
    expect(shouldSuppressCron(new Date(now - 7 * DAY).toISOString(), now)).toBe(false);
  });

  it('returns false when published 8 days ago', () => {
    expect(shouldSuppressCron(new Date(now - 8 * DAY).toISOString(), now)).toBe(false);
  });
});
