import { defineConfig } from 'vitest/config';

const harnessCheckout = process.env.DEEPSEEK_HARNESS_CHECKOUT?.trim();
if (!harnessCheckout && (process.env.OPENSLACK_HARNESS_COMPATIBILITY === 'required' ||
  process.env.OPENSLACK_TEST_INVENTORY === 'collect')) {
  throw new Error('Complete Harness compatibility/inventory requires DEEPSEEK_HARNESS_CHECKOUT pointing to the built original dependency.');
}

export function resolveTestMaxWorkers(platform: NodeJS.Platform): number | undefined {
  return platform === 'win32' ? 4 : undefined;
}

export default defineConfig({
  test: {
    maxWorkers: resolveTestMaxWorkers(process.platform),
    projects: [
      'packages/*',
      'apps/*',
      ...(harnessCheckout ? ['integrations/deepseek-harness'] : []),
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
