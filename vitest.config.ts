import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.worktrees/**',
    ],
  },
});
