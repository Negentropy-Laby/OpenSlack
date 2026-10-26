import { defineConfig } from 'vitest/config';
import { publicAliases } from './runtime-public.mjs';
import { fileURLToPath } from 'node:url';

const harnessRoot = process.env.DEEPSEEK_HARNESS_CHECKOUT;
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Loading the root Vitest configuration must not require Harness for unrelated
  // OpenSlack projects. Selecting these compatibility tests still requires the
  // real built peers; there are no fallback aliases or silently skipped cases.
  resolve: { alias: Object.entries({ ...(harnessRoot ? publicAliases(harnessRoot) : {}),
    '@openslack/agent-runtime/internal/harness': fileURLToPath(new URL('../../packages/agent-runtime/dist/harness.js', import.meta.url)),
  }).sort(([a], [b]) => b.length - a.length)
    .map(([name, replacement]) => ({ find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement })) },
  test: { name: '@openslack/deepseek-harness-plugin', include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'], testTimeout: 30_000 },
});
