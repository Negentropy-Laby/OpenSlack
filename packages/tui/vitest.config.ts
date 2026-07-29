import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Keep package self-imports independent of concurrently generated Windows dist artifacts.
const TUI_TEST_SOURCE_ENTRY = fileURLToPath(new URL('./src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@openslack/tui': TUI_TEST_SOURCE_ENTRY,
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
  },
});
