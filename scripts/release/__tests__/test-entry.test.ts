import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testProcessEnvironment } from '../../testing/process-fixture.mjs';

const root = resolve(import.meta.dirname, '../../..');
function loadConfig(relative: string, overrides: Record<string, string> = {}) {
  const env = testProcessEnvironment();
  for (const name of ['DEEPSEEK_HARNESS_CHECKOUT', 'OPENSLACK_HARNESS_COMPATIBILITY', 'OPENSLACK_TEST_INVENTORY']) delete env[name];
  Object.assign(env, overrides);
  const program = `const loaded = await import(${JSON.stringify(pathToFileURL(resolve(root, relative)).href)});
    const config = loaded.default.default ?? loaded.default;
    process.stdout.write(JSON.stringify(config.test.projects ?? { name: config.test.name, include: config.test.include }));`;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
    cwd: root, env, encoding: 'utf8', timeout: 20_000,
  });
}

describe('ordinary tests and explicit external compatibility', () => {
  it('does not collect external-peer tests without the opt-in original checkout', () => {
    const result = loadConfig('vitest.config.ts');
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const projects = JSON.parse(result.stdout);
    expect(projects).toContain('packages/*');
    expect(projects).toContain('apps/*');
    expect(projects).not.toContain('integrations/deepseek-harness');
  });

  it('rejects incomplete required execution compatibility before running a partial suite', () => {
    const result = loadConfig('vitest.config.ts', { OPENSLACK_HARNESS_COMPATIBILITY: 'required' });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DEEPSEEK_HARNESS_CHECKOUT');
  });

  it.each([false, true])('includes every plugin declaration project without loading external peers, required=%s', required => {
    const overrides: Record<string, string> = { OPENSLACK_TEST_INVENTORY: 'collect' };
    if (required) overrides.OPENSLACK_HARNESS_COMPATIBILITY = 'required';
    const root = loadConfig('vitest.config.ts', overrides);
    expect(root.error).toBeUndefined();
    expect(root.status, root.stderr).toBe(0);
    expect(JSON.parse(root.stdout)).toContain('integrations/deepseek-harness');
    const plugin = loadConfig('integrations/deepseek-harness/vitest.config.ts', overrides);
    expect(plugin.error).toBeUndefined();
    expect(plugin.status, plugin.stderr).toBe(0);
    expect(JSON.parse(plugin.stdout)).toMatchObject({ name: '@openslack/deepseek-harness-plugin', include: ['tests/**/*.spec.ts'] });
    // Actual completeness is enforced by the production collector, including
    // the Node22 job which has no external checkout, not by a copied case count.
  });

  it('fails an explicitly selected plugin config with an actionable missing-checkout error', () => {
    const result = loadConfig('integrations/deepseek-harness/vitest.config.ts');
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DEEPSEEK_HARNESS_CHECKOUT');
  });

  it('never prunes shared worktrees from the ordinary test lifecycle', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(manifest.scripts.pretest ?? '').not.toMatch(/\b(?:prune|clean|reset)\b/);
    expect(manifest.scripts.test).toContain('vitest');
  });
});
