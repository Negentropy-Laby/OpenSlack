import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/*',
      'scripts/release',
      'scripts/public-pack',
      'scripts/live-capstone',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
  },
});
