import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/.claude/worktrees/**', '**/node_modules/**'],
  },
});
