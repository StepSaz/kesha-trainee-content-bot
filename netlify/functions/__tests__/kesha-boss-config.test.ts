import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { readBossConfig } from '../kesha-boss-background.mts';

const originalBossUserIds = process.env.TELEGRAM_BOSS_USER_IDS;
const originalBossUserId = process.env.TELEGRAM_BOSS_USER_ID;

describe('readBossConfig', () => {
  beforeEach(() => {
    delete process.env.TELEGRAM_BOSS_USER_IDS;
    delete process.env.TELEGRAM_BOSS_USER_ID;
  });

  afterEach(() => {
    if (originalBossUserIds === undefined) delete process.env.TELEGRAM_BOSS_USER_IDS;
    else process.env.TELEGRAM_BOSS_USER_IDS = originalBossUserIds;

    if (originalBossUserId === undefined) delete process.env.TELEGRAM_BOSS_USER_ID;
    else process.env.TELEGRAM_BOSS_USER_ID = originalBossUserId;
  });

  it('uses TELEGRAM_BOSS_USER_IDS instead of repo config for allowed boss users', () => {
    process.env.TELEGRAM_BOSS_USER_IDS = '111, 222';

    expect(readBossConfig().allowed_user_ids).toEqual([111, 222]);
  });

  it('uses TELEGRAM_BOSS_USER_ID as a single-id fallback', () => {
    process.env.TELEGRAM_BOSS_USER_ID = '333';

    expect(readBossConfig().allowed_user_ids).toEqual([333]);
  });
});
