import { defineConfig } from 'vitest/config';
import { publicAliases } from './runtime-public.mjs';
import { fileURLToPath } from 'node:url';
import { assertCompatibilityWitness } from './compatibility-witness.mjs';

const harnessRoot = process.env.DEEPSEEK_HARNESS_CHECKOUT?.trim();
const inventory = process.env.OPENSLACK_TEST_INVENTORY === 'collect';
if (!harnessRoot && !inventory) throw new Error('Explicit plugin compatibility tests require DEEPSEEK_HARNESS_CHECKOUT pointing to the built original dependency.');
if (!inventory) assertCompatibilityWitness(fileURLToPath(new URL('../../', import.meta.url)), harnessRoot!);
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Inventory includes declarations without loading external peers. Execution
  // still requires the exact built original checkout and compatibility witness.
  resolve: { alias: Object.entries({ ...(!inventory ? publicAliases(harnessRoot!) : {}),
    '@openslack/agent-runtime/internal/harness': fileURLToPath(new URL('../../packages/agent-runtime/dist/harness.js', import.meta.url)),
    '@openslack/agent-runtime/internal/bridge-wire': fileURLToPath(new URL('../../packages/agent-runtime/dist/bridge-wire.js', import.meta.url)),
    '@openslack/qoder-adapter/internal/harness-tool-catalog': fileURLToPath(new URL('../../packages/qoder-adapter/dist/harness-tool-catalog.js', import.meta.url)),
  }).sort(([a], [b]) => b.length - a.length)
    .map(([name, replacement]) => ({ find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement })) },
  test: { name: '@openslack/deepseek-harness-plugin', include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'], testTimeout: 30_000 },
});
