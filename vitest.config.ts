import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'scripts/release', 'scripts/public-pack'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
  },
});
