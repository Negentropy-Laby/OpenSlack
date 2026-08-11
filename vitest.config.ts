import { defineConfig } from 'vitest/config';

export function resolveTestMaxWorkers(platform: NodeJS.Platform): number | undefined {
  return platform === 'win32' ? 4 : undefined;
}

export default defineConfig({
  test: {
    maxWorkers: resolveTestMaxWorkers(process.platform),
    projects: [
      'packages/*',
      'apps/*',
      'scripts/release',
      'scripts/public-pack',
      'scripts/live-capstone',
      'scripts/qualification-capstone',
      'scripts/qualification',
      'scripts/notification-docs',
      'scripts/documentation',
    ],
    // Project roots are already closed above. Excluding every absolute path
    // containing `.worktrees` silently skips all tests when this repository is
    // developed from its required isolated worktree.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
