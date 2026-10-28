import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { HARNESS_PLUGIN_ENTRIES, HARNESS_NATIVE_SUPERVISOR_FILE, harnessPluginMountFiles, hashHarnessNodeExecutable, hashHarnessPluginArtifacts, hashOpenSlackHarnessCallback,
  captureHarnessArtifactObservation, inspectHarnessArtifactObservation, type HarnessArtifactObservation } from '../harness-artifacts.js';
import { createDeepSeekHarnessProvider, classifyHarnessDeploymentFailure } from '../deepseek-harness-provider.js';
import { hashHarnessRuntimeArtifacts } from '../harness-task-execution.js';
import { canonicalHarnessRoot } from '../harness-read.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openslack-external-artifacts-'));
  roots.push(root);
  const pluginRoot = join(root, 'plugin');
  mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@openslack/deepseek-harness-plugin' }));
  writeFileSync(join(pluginRoot, 'plugin.patch.yml'), '[]');
  writeFileSync(join(pluginRoot, 'THIRD-PARTY-NOTICES.txt'), 'fixture-license');
  for (const name of HARNESS_PLUGIN_ENTRIES) writeFileSync(join(pluginRoot, 'dist', `${name}.js`), 'export {};');
  writeFileSync(join(pluginRoot, HARNESS_NATIVE_SUPERVISOR_FILE), 'fixture binary identity only');
  writeFileSync(join(root, 'patch.json'), '[]');
  writeFileSync(join(root, 'binding.json'), JSON.stringify({ runId: 'RUN-TEST', generation: 'owner-test' }));
  return { root, pluginRoot };
}

describe('external plugin and Node input identities', () => {
  it.each([1000, 25_000, 60_000])('rejects legacy exitGraceMs=%i before filesystem observation or process startup', exitGraceMs => {
    const root = join(tmpdir(), 'must-not-be-read-r36-cleanup');
    const deployment = { harnessRoot: root, pluginRoot: root, pluginBuildHash: 'a'.repeat(64), nodeExecutable: process.execPath,
      nodeVersion: '24.18.1' as const, nodeSha256: 'b'.repeat(64), dshHome: root, agentId: 'fixed', provider: 'fixture', model: 'fixture',
      workerPatch: join(root, 'patch'), workerBinding: join(root, 'binding'), timeoutMs: 1000, exitGraceMs };
    expect(() => createDeepSeekHarnessProvider(deployment, async () => {}).resolve({ agentId: 'fixed', source: 'fixture' }))
      .toThrow('Harness exitGraceMs must be 30000');
  });
  it.runIf(process.platform === 'win32')('normalizes an actual 8.3 spelling when the test volume supplies one', ({ skip }) => {
    const { pluginRoot } = fixture();
    if (!process.env.SystemRoot) throw new Error('A native Windows system directory is required');
    const cmd = join(process.env.SystemRoot, 'System32/cmd.exe');
    const observed = spawnSync(cmd, ['/d', '/s', '/c', `for %I in ("${pluginRoot}") do @echo %~sI`],
      { encoding: 'utf8', windowsVerbatimArguments: true });
    if (observed.error || observed.status !== 0) throw new Error('Native short-path observation failed');
    const short = observed.stdout.trim();
    if (!short || short.toLowerCase() === pluginRoot.toLowerCase()) skip('The test volume did not provide a distinct 8.3 alias');
    expect(short).toMatch(/~\d/);
    expect(canonicalHarnessRoot(short).toLowerCase()).toBe(canonicalHarnessRoot(pluginRoot).toLowerCase());
    expect(hashHarnessPluginArtifacts(short)).toBe(hashHarnessPluginArtifacts(pluginRoot));
    console.info(JSON.stringify({ kind: 'windows-path-observation', scenario: '8.3', input: short,
      canonical: canonicalHarnessRoot(short), result: 'same-root-and-artifact-hash' }));
  });
  it.runIf(process.platform === 'win32')('normalizes a real Windows drive alias while still rejecting directory junctions', () => {
    const { root, pluginRoot } = fixture();
    const drive = ['Z:', 'Y:', 'X:', 'W:', 'V:'].find(value => !existsSync(`${value}\\`));
    if (!drive || !process.env.SystemRoot) throw new Error('A free temporary test drive and native Windows system directory are required');
    const subst = join(process.env.SystemRoot, 'System32/subst.exe');
    execFileSync(subst, [drive, root], { stdio: 'pipe' });
    try {
      const alias = join(`${drive}\\`, 'plugin');
      expect(canonicalHarnessRoot(alias).toLowerCase()).toBe(canonicalHarnessRoot(pluginRoot).toLowerCase());
      expect(hashHarnessPluginArtifacts(alias)).toBe(hashHarnessPluginArtifacts(pluginRoot));
      const linked = join(root, 'linked-plugin');
      symlinkSync(pluginRoot, linked, 'junction');
      expect(() => canonicalHarnessRoot(linked)).toThrow('directory link');
      console.info(JSON.stringify({ kind: 'windows-path-observation', scenario: 'drive-alias-and-junction',
        input: alias, canonical: canonicalHarnessRoot(alias), alias: 'same-root-and-artifact-hash', junction: 'rejected' }));
    } finally {
      // Remove only the exact fresh mapping created by this fixture, never a
      // pre-existing drive or worktree.
      execFileSync(subst, [drive, '/D'], { stdio: 'pipe' });
    }
  });
  it('reuses exact expensive bytes only in one synchronous phase and rejects forgery or cross-await use', async () => {
    const { root, pluginRoot } = fixture();
    const node = join(root, 'node-binary');
    writeFileSync(node, 'known binary bytes');
    const proof = captureHarnessArtifactObservation(pluginRoot, node);
    expect(inspectHarnessArtifactObservation(proof, pluginRoot, node)).toEqual({ pluginHash: hashHarnessPluginArtifacts(pluginRoot), nodeHash: hashHarnessNodeExecutable(node) });
    expect(() => inspectHarnessArtifactObservation({} as HarnessArtifactObservation, pluginRoot, node)).toThrow('expired or changed');
    await Promise.resolve();
    expect(() => inspectHarnessArtifactObservation(proof, pluginRoot, node)).toThrow('expired or changed');
  });
  it('distinguishes plugin file partitions even when unframed path/body concatenations are identical', () => {
    const { root, pluginRoot } = fixture(), node = join(root, 'fixed-node-binary');
    writeFileSync(node, 'fixed node bytes');
    const first = join(pluginRoot, 'dist/index.js'), second = join(pluginRoot, 'dist/initiator.js');
    const left = '// alpha ', pivot = '\n// beta ', right = '\n', key = 'dist/initiator.js';
    writeFileSync(first, left); writeFileSync(second, pivot + key + right);
    const initial = hashHarnessPluginArtifacts(pluginRoot);
    const proof = captureHarnessArtifactObservation(pluginRoot, node);
    expect(inspectHarnessArtifactObservation(proof, pluginRoot, node).pluginHash).toBe(initial);
    expect(left + key + pivot + key + right).toBe((left + key + pivot) + key + right);
    writeFileSync(first, left + key + pivot); writeFileSync(second, right);
    const changed = hashHarnessPluginArtifacts(pluginRoot);
    expect(changed).not.toBe(initial);
    const next = captureHarnessArtifactObservation(pluginRoot, node);
    expect(inspectHarnessArtifactObservation(next, pluginRoot, node)).toEqual({ pluginHash: changed, nodeHash: hashHarnessNodeExecutable(node) });
  });
  it('rejects artifact mutation within a phase even when the opaque proof is otherwise genuine', () => {
    const { root, pluginRoot } = fixture();
    const node = join(root, 'node-binary');
    writeFileSync(node, 'before');
    const proof = captureHarnessArtifactObservation(pluginRoot, node);
    writeFileSync(node, 'after!');
    expect(() => inspectHarnessArtifactObservation(proof, pluginRoot, node)).toThrow('expired or changed');
  });
  it.each(['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EMFILE'])('retains stable %s diagnostics without disclosing raw paths', code => {
    const error = classifyHarnessDeploymentFailure(Object.assign(new Error('SECRET_PATH_SENTINEL'), { code }));
    expect(error).toMatchObject({ filesystemCode: code });
    expect(error.message).not.toContain('SECRET_PATH_SENTINEL');
    if (code !== 'ENOENT') { expect(error.message).toContain(code); expect(error.message).not.toContain('build the matching'); }
  });
  it('classifies a real missing approved artifact through provider resolution rather than leaking an fs exception', () => {
    const { root, pluginRoot } = fixture();
    const deployment = { harnessRoot: root, pluginRoot, pluginBuildHash: hashHarnessPluginArtifacts(pluginRoot),
      nodeExecutable: process.execPath, nodeVersion: '24.18.1' as const, nodeSha256: hashHarnessNodeExecutable(process.execPath),
      dshHome: root, agentId: 'fixed', provider: 'fixture', model: 'fixture', workerPatch: join(root, 'patch.json'),
      workerBinding: join(root, 'binding.json'), timeoutMs: 1_000, exitGraceMs: 30_000 };
    unlinkSync(join(pluginRoot, HARNESS_NATIVE_SUPERVISOR_FILE));
    let failure: unknown;
    try { createDeepSeekHarnessProvider(deployment, async () => {}).resolve({ agentId: 'fixed', source: 'fixture' }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'RUNTIME_MISCONFIGURED', filesystemCode: 'ENOENT' });
    expect((failure as Error).message).not.toContain(pluginRoot);
  });
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
    // A real workspace dependency must resolve from this approved fixture
    // installation, not merely share a name with an enumerated manifest.
    mkdirSync(join(root, 'node_modules/@deepseek-ai'), { recursive: true });
    symlinkSync(join(root, 'packages/llm/llm'), join(root, 'node_modules/@deepseek-ai/dsh-llm'), process.platform === 'win32' ? 'junction' : 'dir');
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
      workerBinding: join(root, 'binding.json'), timeoutMs: 1_000, exitGraceMs: 30_000 };
    if (kind === 'plugin') writeFileSync(join(pluginRoot, 'dist/index.js'), 'export const changed=true;');
    if (kind === 'node') deployment.nodeSha256 = '0'.repeat(64);
    if (kind === 'version') Object.assign(deployment, { nodeVersion: '24.18.0' });
    expect(() => createDeepSeekHarnessProvider(deployment, async () => {}).resolve({ agentId: 'fixed', source: 'fixture', model: 'fixture' }))
      .toThrow('approved deployment');
  });
});
