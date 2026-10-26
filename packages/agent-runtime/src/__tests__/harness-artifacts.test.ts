import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HARNESS_PLUGIN_ENTRIES, harnessPluginMountFiles, hashHarnessNodeExecutable, hashHarnessPluginArtifacts, hashOpenSlackHarnessCallback } from '../harness-artifacts.js';
import { createDeepSeekHarnessProvider } from '../deepseek-harness-provider.js';
import { hashHarnessRuntimeArtifacts } from '../harness-task-execution.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openslack-external-artifacts-'));
  roots.push(root);
  const pluginRoot = join(root, 'plugin');
  mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@openslack/deepseek-harness-plugin' }));
  writeFileSync(join(pluginRoot, 'plugin.patch.yml'), '[]');
  for (const name of HARNESS_PLUGIN_ENTRIES) writeFileSync(join(pluginRoot, 'dist', `${name}.js`), 'export {};');
  writeFileSync(join(root, 'patch.json'), '[]');
  writeFileSync(join(root, 'binding.json'), '{}');
  return { root, pluginRoot };
}

describe('external plugin and Node input identities', () => {
  it.each(['dist', 'workspace-peer'] as const)('rejects callback %s redirection even when its copied JS bytes match', kind => {
    const { root } = fixture();
    const cli = join(root, 'apps/cli');
    const core = join(root, 'packages/core');
    for (const [dir, name] of [[cli, '@openslack/cli'], [join(root, 'apps/mcp'), '@openslack/mcp'], [core, '@openslack/core']]) {
      mkdirSync(join(dir!, 'dist'), { recursive: true });
      writeFileSync(join(dir!, 'dist/index.js'), 'export {};');
      writeFileSync(join(dir!, 'package.json'), JSON.stringify({ name, main: './dist/index.js',
        dependencies: name === '@openslack/cli' ? { '@openslack/core': 'workspace:*' } : {} }));
    }
    writeFileSync(join(root, 'bun.lock'), 'fixture-lock');
    const link = join(cli, 'node_modules/@openslack/core');
    mkdirSync(join(cli, 'node_modules/@openslack'), { recursive: true });
    symlinkSync(core, link, process.platform === 'win32' ? 'junction' : 'dir');
    const entry = join(cli, 'dist/index.js');
    expect(hashOpenSlackHarnessCallback(entry)).toMatch(/^[a-f0-9]{64}$/);
    if (kind === 'dist') {
      const redirected = join(root, 'copied-dist');
      renameSync(join(cli, 'dist'), redirected);
      symlinkSync(redirected, join(cli, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => hashOpenSlackHarnessCallback(entry)).toThrow('must not be linked');
    } else {
      const redirected = join(root, 'copied-core');
      renameSync(core, redirected);
      mkdirSync(join(core, 'dist'), { recursive: true });
      writeFileSync(join(core, 'package.json'), JSON.stringify({ name: '@openslack/core', main: './dist/index.js', dependencies: {} }));
      writeFileSync(join(core, 'dist/index.js'), 'export {};');
      unlinkSync(link);
      symlinkSync(redirected, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => hashOpenSlackHarnessCallback(entry)).toThrow('outside approved root');
    }
  });
  it('binds executable public JS under lib/types without treating declarations as executable', () => {
    const { root } = fixture();
    const packages = [
      ['packages/sdk/client', '@deepseek-ai/dsh-sdk-client'], ['packages/sdk/server', '@deepseek-ai/dsh-sdk-jsonrpc-server'],
      ['packages/mcp/client', '@deepseek-ai/dsh-mcp-client'], ['apps/cli', '@deepseek-ai/dsh'],
      ['packages/llm/llm', '@deepseek-ai/dsh-llm'],
    ] as const;
    mkdirSync(join(root, 'vendor'));
    for (const [path, name] of packages) {
      const dir = join(root, path);
      mkdirSync(join(dir, 'lib'), { recursive: true });
      writeFileSync(join(dir, 'lib/index.js'), 'export {};');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module',
        exports: { '.': './lib/index.js' }, dependencies: name.endsWith('sdk-client') ? { '@deepseek-ai/dsh-llm': 'workspace:*' } : {} }));
    }
    const thirdParty = join(root, 'node_modules/@modelcontextprotocol/client');
    mkdirSync(join(thirdParty, 'dist'), { recursive: true });
    writeFileSync(join(thirdParty, 'package.json'), JSON.stringify({ name: '@modelcontextprotocol/client',
      exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' },
        './stdio': { import: './dist/stdio.mjs', require: './dist/stdio.cjs' } } }));
    for (const file of ['index.mjs', 'index.cjs', 'stdio.mjs', 'stdio.cjs']) writeFileSync(join(thirdParty, 'dist', file), '');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'fixture-lock');
    const types = join(root, 'packages/llm/llm/lib/types');
    mkdirSync(types);
    writeFileSync(join(types, 'brand.js'), 'export const brand=1;');
    writeFileSync(join(types, 'brand.d.ts'), 'export declare const brand: number;');
    const before = hashHarnessRuntimeArtifacts(root);
    writeFileSync(join(types, 'brand.d.ts'), 'export declare const brand: 1;');
    expect(hashHarnessRuntimeArtifacts(root)).toBe(before);
    writeFileSync(join(types, 'brand.js'), 'export const brand=2;');
    expect(hashHarnessRuntimeArtifacts(root)).not.toBe(before);
  });
  it('binds the exact external entries; source files and arbitrary mounts are not eligible', () => {
    const { pluginRoot } = fixture();
    const initial = hashHarnessPluginArtifacts(pluginRoot);
    expect(harnessPluginMountFiles(pluginRoot)).toHaveLength(7);
    mkdirSync(join(pluginRoot, 'src'));
    writeFileSync(join(pluginRoot, 'src/arbitrary.ts'), 'throw new Error("not shipped");');
    expect(hashHarnessPluginArtifacts(pluginRoot)).toBe(initial);
    expect(harnessPluginMountFiles(pluginRoot)).not.toContain(join(pluginRoot, 'src/arbitrary.ts'));
    writeFileSync(join(pluginRoot, 'dist/sdk-host.js'), 'export const drift=true;');
    expect(hashHarnessPluginArtifacts(pluginRoot)).not.toBe(initial);
  });
  it('rejects a linked artifact parent instead of expanding an approved code root', () => {
    const { root, pluginRoot } = fixture();
    const target = join(root, 'outside');
    mkdirSync(target);
    const parent = join(pluginRoot, '.build');
    symlinkSync(target, parent, process.platform === 'win32' ? 'junction' : 'dir');
    mkdirSync(join(target, 'fixtures'));
    writeFileSync(join(target, 'fixtures/scripted-model.js'), 'export {};');
    expect(() => hashHarnessPluginArtifacts(pluginRoot)).toThrow('directory link');
  });
  it.each(['plugin', 'node', 'version'] as const)('refuses %s drift before creating a peer', kind => {
    const { root, pluginRoot } = fixture();
    const deployment = { harnessRoot: root, pluginRoot, pluginBuildHash: hashHarnessPluginArtifacts(pluginRoot),
      nodeExecutable: process.execPath, nodeVersion: '24.18.1' as const, nodeSha256: hashHarnessNodeExecutable(process.execPath),
      dshHome: root, agentId: 'fixed', provider: 'fixture', model: 'fixture', workerPatch: join(root, 'patch.json'),
      workerBinding: join(root, 'binding.json'), timeoutMs: 1_000, exitGraceMs: 1_000 };
    if (kind === 'plugin') writeFileSync(join(pluginRoot, 'dist/index.js'), 'export const changed=true;');
    if (kind === 'node') deployment.nodeSha256 = '0'.repeat(64);
    if (kind === 'version') Object.assign(deployment, { nodeVersion: '24.18.0' });
    expect(() => createDeepSeekHarnessProvider(deployment, async () => {}).resolve({ agentId: 'fixed', source: 'fixture', model: 'fixture' }))
      .toThrow('approved deployment');
  });
});
