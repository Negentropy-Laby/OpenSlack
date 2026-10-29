import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashHarnessRuntimeArtifacts, hashHarnessDeployment, createHarnessTaskExecution } from '../harness-task-execution.js';
import { hashOpenSlackHarnessCallback, hashHarnessPluginArtifacts, hashHarnessNodeExecutable, HARNESS_PLUGIN_ENTRIES, HARNESS_NATIVE_SUPERVISOR_FILE } from '../harness-artifacts.js';
import { HarnessRuntimePackageClosure, readRuntimeWorkspacePackage } from '../harness-runtime-closure.js';
import { createRunStore } from '../run-store.js';
import { hashHarnessInput } from '../harness-admission.js';
import { hashHarnessTask, type ApprovedHarnessTask } from '../harness-task-host.js';
import { buildHarnessTaskPermissionProfile } from '../harness-permissions.js';
import { readHarnessFile, withHarnessDescriptor } from '../harness-read.js';
import type * as HarnessRead from '../harness-read.js';

vi.mock('../harness-read.js', async original => {
  const actual = await original<typeof HarnessRead>();
  return { ...actual, readHarnessFile: vi.fn(actual.readHarnessFile), withHarnessDescriptor: vi.fn(actual.withHarnessDescriptor) };
});

const roots: string[] = [];
afterEach(() => { vi.mocked(readHarnessFile).mockClear(); vi.mocked(withHarnessDescriptor).mockClear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function put(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function manifest(path: string, value: object): void { put(join(path, 'package.json'), JSON.stringify(value)); }
function fixture(kind: 'harness' | 'callback') {
  const root = mkdtempSync(join(tmpdir(), 'harness-installed-closure-')); roots.push(root);
  const packages = kind === 'harness' ? [
    ['packages/sdk/client', '@deepseek-ai/dsh-sdk-client'], ['packages/sdk/server', '@deepseek-ai/dsh-sdk-jsonrpc-server'],
    ['packages/mcp/client', '@deepseek-ai/dsh-mcp-client'], ['apps/cli', '@deepseek-ai/dsh'],
    ['packages/llm/llm', '@deepseek-ai/dsh-llm'], ['vendor/cordis', '@deepseek-ai/cordis'],
    ['vendor/schemastery', '@deepseek-ai/schemastery'], ['packages/sdk/protocol', '@deepseek-ai/dsh-sdk-protocol'],
  ] : [['apps/cli', '@openslack/cli'], ['apps/mcp', '@openslack/mcp']];
  mkdirSync(join(root, 'packages'), { recursive: true }); mkdirSync(join(root, 'vendor'), { recursive: true });
  for (const [path, name] of packages) {
    const directory = join(root, path!), output = kind === 'harness' ? 'lib' : 'dist';
    manifest(directory, { name, version: '0.2.1-rc.3', type: 'module', exports: { '.': `./${output}/index.js` },
      dependencies: { '@modelcontextprotocol/client': '2.2.0', ...(name === '@deepseek-ai/dsh-sdk-client'
        ? Object.fromEntries(packages.filter(([, dependency]) => dependency !== name).map(([, dependency]) => [dependency, 'workspace:*'])) : {}) } });
    put(join(directory, output, 'index.js'), 'export {};');
    const link = join(root, 'node_modules', name!);
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const peer = join(root, 'node_modules/@modelcontextprotocol/client');
  manifest(peer, { name: '@modelcontextprotocol/client', version: '2.2.0', type: 'module',
    exports: { '.': './dist/index.js', './stdio': './dist/stdio.js' }, dependencies: { 'fixture-transitive': '1.0.0' } });
  for (const name of ['index', 'stdio']) put(join(peer, `dist/${name}.js`), 'export { observed } from "./chunks/session.js";');
  const split = join(peer, 'dist/chunks/session.js');
  put(split, 'import { value } from "fixture-transitive";export const observed=value+"A";');
  const transitive = join(peer, 'node_modules/fixture-transitive');
  manifest(transitive, { name: 'fixture-transitive', version: '1.0.0', type: 'module', exports: './index.js' });
  put(join(transitive, 'index.js'), 'export const value="one";');
  const lock = join(root, kind === 'harness' ? 'pnpm-lock.yaml' : 'bun.lock'); put(lock, 'fixed fixture lock');
  const hash = () => kind === 'harness' ? hashHarnessRuntimeArtifacts(root) : hashOpenSlackHarnessCallback(join(root, 'apps/cli/dist/index.js'));
  return { root, peer, split, transitive, lock, hash };
}

function applicationFixture() {
  const f = fixture('harness'), application = join(f.root, 'apps/frontend');
  const name = 'fixture-compiled-application';
  manifest(application, { name, version: '0.2.1-rc.3', type: 'module',
    exports: { './dist/*': './dist/*', './package.json': './package.json' }, files: ['dist', '!dist/**/*.map'] });
  for (const file of ['index.js', 'asset.css', 'font.woff2', 'engine.wasm', 'runtime.data']) put(join(application, 'dist', file), 'runtime-one');
  for (const file of ['src/page.ts', 'tests/page.test.ts', 'dist/index.js.map', 'dist/types.d.ts']) put(join(application, file), 'debug-one');
  const cli = join(f.root, 'apps/cli/package.json'), data = JSON.parse(readFileSync(cli, 'utf8'));
  data.dependencies[name] = 'workspace:*'; put(cli, JSON.stringify(data));
  const link = join(f.root, 'node_modules', name);
  symlinkSync(application, link, process.platform === 'win32' ? 'junction' : 'dir');
  return { ...f, application, name };
}

describe('approved installed runtime dependency bytes', () => {
  it('discovers declared applications and excludes their source, tests and publication-excluded debug output', () => {
    const f = applicationFixture(), before = f.hash();
    for (const file of ['src/page.ts', 'tests/page.test.ts', 'dist/index.js.map', 'dist/types.d.ts']) put(join(f.application, file), 'debug-two');
    expect(f.hash()).toBe(before);
    expect(vi.mocked(withHarnessDescriptor).mock.calls.some(([path]) => /(?:\/|\\)(?:src|tests)(?:\/|\\)/.test(path) || /\.(?:map|d\.ts)$/.test(path))).toBe(false);
  });

  it('uses a CLI public bin and non-types export contract without executing an unused unsupported application', () => {
    const f = fixture('harness'), path = join(f.root, 'apps/cli/package.json'), data = JSON.parse(readFileSync(path, 'utf8'));
    data.bin = { dsh: 'lib/index.js' };
    data.exports = { '.': { types: './lib/index.d.ts', default: './lib/index.js' } };
    put(path, JSON.stringify(data)); put(join(f.root, 'apps/cli/lib/index.d.ts'), 'export {};');
    const before = f.hash();
    manifest(join(f.root, 'apps/unselected'), { name: 'unselected-application', main: './unimplemented/entry.js' });
    expect(f.hash()).toBe(before);
  });

  it.each(['index.js', 'asset.css', 'font.woff2', 'engine.wasm', 'runtime.data'])('binds a discovered application compiled %s resource', file => {
    const f = applicationFixture(), before = f.hash();
    put(join(f.application, 'dist', file), 'runtime-two');
    expect(f.hash()).not.toBe(before);
  });

  it.each(['unknown', 'mixed', 'unpublished-dist', 'escaping-bin'] as const)('refuses a visited application with an unsupported %s artifact contract', kind => {
    const f = applicationFixture(), path = join(f.application, 'package.json'), data = JSON.parse(readFileSync(path, 'utf8'));
    if (kind === 'unknown') data.exports = { '.': './src/page.ts' };
    if (kind === 'mixed') data.exports = { '.': './dist/index.js', './other': './lib/other.js' };
    if (kind === 'unpublished-dist') data.files = ['dist'];
    if (kind === 'escaping-bin') { data.exports = { '.': './lib/index.js' }; data.bin = { fixture: 'lib/../../unobserved.js' }; put(join(f.application, 'lib/index.js'), 'export {};'); }
    put(path, JSON.stringify(data));
    expect(() => f.hash()).toThrow(/application compiled artifact contract/);
  });

  it('refuses an application identity colliding with a discovered library package', () => {
    const f = fixture('harness');
    manifest(join(f.root, 'apps/colliding'), { name: '@deepseek-ai/dsh-sdk-client', main: 'lib/index.js' });
    put(join(f.root, 'apps/colliding/lib/index.js'), 'export {};');
    expect(() => f.hash()).toThrow(/Duplicate Harness workspace package identity/);
  });

  it('refuses a linked application workspace instead of classifying its target as compiled application output', () => {
    const f = applicationFixture(), target = join(f.root, 'relocated-application');
    renameSync(f.application, target);
    symlinkSync(target, f.application, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => f.hash()).toThrow(/application workspace must not be linked/);
  });

  it.each(['harness', 'callback'] as const)('binds %s actual nested split and transitive bodies without changing entries, manifests or lock', kind => {
    const f = fixture(kind), entry = join(f.peer, 'dist/index.js'), packageFile = join(f.peer, 'package.json');
    const fixed = [entry, packageFile, f.lock].map(path => readFileSync(path));
    const before = f.hash(); expect(f.hash()).toBe(before);
    const runtime = () => execFileSync(process.execPath, ['--input-type=module', '-e',
      `console.log((await import(${JSON.stringify(pathToFileURL(entry).href)})).observed)`], { encoding: 'utf8' }).trim();
    expect(runtime()).toBe('oneA');
    put(f.split, readFileSync(f.split, 'utf8').replace('+"A"', '+"B"'));
    expect(runtime()).toBe('oneB');
    const split = f.hash(); expect(split).not.toBe(before);
    put(join(f.transitive, 'index.js'), 'export const value="two";');
    expect(runtime()).toBe('twoB');
    expect(f.hash()).not.toBe(split);
    for (const [index, path] of [entry, packageFile, f.lock].entries()) expect(readFileSync(path).equals(fixed[index]!)).toBe(true);
  });

  it('does not deduplicate two installed copies by package name/version and binds non-JS runtime resources', () => {
    const f = fixture('callback'), second = join(f.root, 'apps/mcp/node_modules/fixture-transitive');
    manifest(second, { name: 'fixture-transitive', version: '1.0.0', exports: './index.js' });
    put(join(second, 'index.js'), 'exports.value="one";'); put(join(second, 'runtime.data'), 'first');
    const path = join(f.root, 'apps/mcp/package.json'), data = JSON.parse(readFileSync(path, 'utf8'));
    data.dependencies['fixture-transitive'] = '1.0.0'; put(path, JSON.stringify(data));
    const before = f.hash();
    put(join(f.transitive, 'index.js'), 'export const value="two";');
    const firstCopy = f.hash(); expect(firstCopy).not.toBe(before);
    put(join(second, 'runtime.data'), 'other');
    expect(f.hash()).not.toBe(firstCopy);
  });

  it.each(['harness', 'callback'] as const)('refuses %s package-resolution escape and linked content even inside its approved code root', kind => {
    const f = fixture(kind);
    const outside = mkdtempSync(join(tmpdir(), 'runtime-closure-outside-')); roots.push(outside);
    put(join(outside, 'payload.js'), 'export const forbidden="unapproved";');
    const content = join(f.peer, 'dist/linked.js');
    symlinkSync(join(outside, 'payload.js'), content, 'file');
    expect(() => f.hash()).toThrow(/linked/);
    rmSync(content); symlinkSync(f.split, content, 'file');
    expect(() => f.hash()).toThrow(/linked/);
    rmSync(content);
    rmSync(f.transitive, { recursive: true });
    manifest(outside, { name: 'fixture-transitive', version: '1.0.0', main: './payload.js' });
    symlinkSync(outside, f.transitive, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => f.hash()).toThrow(/escapes its approved/);
    expect(readFileSync(join(outside, 'payload.js'), 'utf8')).toBe('export const forbidden="unapproved";');
  });

  it('distinguishes absent optional/peer edges from missing required dependencies without searching parent installations', () => {
    const f = fixture('callback'), path = join(f.peer, 'package.json'), data = JSON.parse(readFileSync(path, 'utf8'));
    data.optionalDependencies = { 'fixture-optional': '1.0.0' }; data.peerDependencies = { 'fixture-peer': '1.0.0' };
    put(path, JSON.stringify(data));
    const absent = f.hash(); expect(f.hash()).toBe(absent);
    for (const name of ['fixture-optional', 'fixture-peer']) {
      const directory = join(f.peer, 'node_modules', name);
      manifest(directory, { name, version: '1.0.0', main: './index.js' }); put(join(directory, 'index.js'), 'module.exports=1;');
    }
    expect(f.hash()).not.toBe(absent);
    data.dependencies['unavailable-runtime-fixture'] = '1.0.0'; put(path, JSON.stringify(data));
    expect(() => f.hash()).toThrow(/Required installed runtime dependency is unavailable inside its approved root/);
  });

  it('checks stable observation witnesses and capacity before accepting a package digest', () => {
    const f = fixture('callback'), pkg = readRuntimeWorkspacePackage(join(f.root, 'apps/cli'), 'dist', true);
    const closure = new HarnessRuntimePackageClosure(f.root, new Map([['@openslack/cli', pkg]]));
    closure.visitWorkspace('@openslack/cli');
    put(f.split, readFileSync(f.split, 'utf8') + '\n// changed after the file was hashed');
    expect(() => closure.finish()).toThrow(/changed/);
    const oversized = join(f.peer, 'dist/oversized.data'); put(oversized, ''); truncateSync(oversized, 256 * 1024 * 1024 + 1);
    expect(() => f.hash()).toThrow(/capacity/);
  });

  it('streams a resource above the former 64 MiB buffer limit and binds a changed byte at its end', () => {
    const f = fixture('callback'), path = join(f.peer, 'dist/engine.wasm');
    put(path, ''); truncateSync(path, 70 * 1024 * 1024);
    const first = f.hash(); expect(f.hash()).toBe(first);
    const descriptor = openSync(path, 'r+');
    try { writeSync(descriptor, Buffer.from([1]), 0, 1, 70 * 1024 * 1024 - 1); }
    finally { closeSync(descriptor); }
    expect(f.hash()).not.toBe(first);
  });

  it('binds an installed dependency that shares a Node builtin name rather than treating it as missing', () => {
    const f = fixture('callback'), path = join(f.peer, 'package.json'), data = JSON.parse(readFileSync(path, 'utf8'));
    data.dependencies.buffer = '1.0.0'; put(path, JSON.stringify(data));
    const buffer = join(f.peer, 'node_modules/buffer');
    manifest(buffer, { name: 'buffer', version: '1.0.0', main: './index.js' }); put(join(buffer, 'index.js'), 'exports.fixture=1;');
    const first = f.hash(); put(join(buffer, 'index.js'), 'exports.fixture=2;');
    expect(f.hash()).not.toBe(first);
  });

  it('rejects additive directory drift and retargeting an installed package entry before finishing its observation', () => {
    const f = fixture('callback'), directory = join(f.root, 'apps/cli');
    const observe = () => {
      const pkg = readRuntimeWorkspacePackage(directory, 'dist', true);
      const closure = new HarnessRuntimePackageClosure(f.root, new Map([['@openslack/cli', pkg]]));
      closure.visitWorkspace('@openslack/cli');
      return closure;
    };
    const additive = observe();
    put(join(f.peer, 'dist/extra-runtime.data'), 'new actual runtime input');
    expect(() => additive.finish()).toThrow(/changed/);
    const first = join(f.root, 'installed-first'), second = join(f.root, 'installed-second');
    renameSync(f.transitive, first);
    for (const path of ['package.json', 'index.js']) put(join(second, path), readFileSync(join(first, path), 'utf8'));
    symlinkSync(first, f.transitive, process.platform === 'win32' ? 'junction' : 'dir');
    const before = f.hash(), retargeted = observe();
    rmSync(f.transitive); symlinkSync(second, f.transitive, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => retargeted.finish()).toThrow(/resolution changed/);
    expect(f.hash()).not.toBe(before);
  });

  it.each(['.env', '.env.local', '.npmrc', '.openslack.local', 'credentials', 'secrets', '.ssh', 'private.pem', 'private.key'])('rejects protected %s metadata before opening or reading any bytes', name => {
    const f = fixture('callback'), closure = new HarnessRuntimePackageClosure(f.root, new Map());
    const privateFile = join(f.peer, name);
    // No protected file or secret material is created. The guard must reject
    // the name even before attempting lstat/open on this nonexistent entry.
    expect(() => closure.addFile(privateFile)).toThrow(/local configuration or credential/);
    expect(vi.mocked(readHarnessFile).mock.calls.some(([path]) => path === privateFile)).toBe(false);
    expect(vi.mocked(withHarnessDescriptor).mock.calls.some(([path]) => path === privateFile)).toBe(false);
  });

  it('binds an ordinary published credentials code tree but rejects an injected data blob before reading any member', () => {
    const f = fixture('callback'), directory = join(f.peer, 'lib/credentials');
    const module = join(directory, 'identity-token.mjs'), declaration = join(directory, 'types.d.ts');
    put(module, 'export const value="code-one";'); put(declaration, 'export declare const value: string;');
    const first = f.hash();
    put(module, 'export const value="code-two";');
    expect(f.hash()).not.toBe(first);
    const privateFile = join(directory, 'secret.json'); put(privateFile, '{"fixtureOnly":true}');
    vi.mocked(readHarnessFile).mockClear();
    vi.mocked(withHarnessDescriptor).mockClear();
    expect(() => f.hash()).toThrow(/local configuration or credential/);
    expect(vi.mocked(readHarnessFile).mock.calls.some(([path]) => [module, declaration, privateFile].includes(path))).toBe(false);
    expect(vi.mocked(withHarnessDescriptor).mock.calls.some(([path]) => [module, declaration, privateFile].includes(path))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('rejects a literal backslash filename instead of aliasing a directory/file frame identity', () => {
    const f = fixture('callback'), ambiguous = join(f.peer, 'dist/a\\b.js');
    put(ambiguous, 'export const value=1;');
    expect(() => f.hash()).toThrow(/not portable or unambiguous/);
    rmSync(ambiguous); put(join(f.peer, 'dist/a/b.js'), 'export const value=1;');
    expect(f.hash()).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['.js', '.json', '.node'])('refuses a real optional CJS file-shaped %s dependency instead of calling it absent', suffix => {
    const f = fixture('callback'), path = join(f.peer, 'package.json'), data = JSON.parse(readFileSync(path, 'utf8'));
    data.optionalDependencies = { 'file-shaped-fixture': '1.0.0' }; put(path, JSON.stringify(data));
    const executable = join(f.peer, 'node_modules', `file-shaped-fixture${suffix}`);
    put(executable, suffix === '.json' ? '{}' : 'module.exports=1;');
    expect(createRequire(path).resolve('file-shaped-fixture')).toBe(executable);
    expect(() => f.hash()).toThrow(/file-shaped runtime dependency resolution/);
  });

  it.each(['main', 'exports'] as const)('refuses a package %s that points outside its observed package body', field => {
    const f = fixture('callback'), path = join(f.transitive, 'package.json'), data = JSON.parse(readFileSync(path, 'utf8'));
    data[field] = field === 'main' ? '../unbound-runtime.js' : { '.': './../unbound-runtime.js' };
    put(path, JSON.stringify(data));
    expect(() => f.hash()).toThrow(/entry escapes its package root/);
  });

  it.each(['main', 'exports'] as const)('refuses a package %s routed into an undeclared nested node_modules body', field => {
    const f = fixture('callback'), path = join(f.transitive, 'package.json'), data = JSON.parse(readFileSync(path, 'utf8'));
    data[field] = field === 'main' ? './node_modules/undeclared/index.js' : { '.': './node_modules/undeclared/index.js' };
    put(path, JSON.stringify(data)); put(join(f.transitive, 'node_modules/undeclared/index.js'), 'exports.value=1;');
    expect(() => f.hash()).toThrow(/bypasses its declared dependency closure/);
  });

  it.runIf(process.platform === 'win32')('normalizes one real drive alias for both full Harness and callback hash consumers', () => {
    if (!process.env.SystemRoot) throw new Error('A native Windows system directory is required');
    const drive = ['Z:', 'Y:', 'X:', 'W:', 'V:'].find(value => !existsSync(`${value}\\`));
    if (!drive) throw new Error('This isolated alias regression needs one free temporary drive');
    const subst = join(process.env.SystemRoot, 'System32/subst.exe');
    for (const kind of ['harness', 'callback'] as const) {
      const f = fixture(kind), expected = f.hash();
      execFileSync(subst, [drive, f.root], { stdio: 'pipe' });
      try {
        const actual = kind === 'harness' ? hashHarnessRuntimeArtifacts(`${drive}\\`) : hashOpenSlackHarnessCallback(join(`${drive}\\`, 'apps/cli/dist/index.js'));
        expect(actual).toBe(expected);
      } finally { execFileSync(subst, [drive, '/D'], { stdio: 'pipe' }); }
    }
  });

  it('refuses an actually available parent optional package without reading it as a new approved root', () => {
    const f = fixture('callback'), childRoot = join(f.root, 'nested-checkout');
    mkdirSync(childRoot);
    const path = join(childRoot, 'packages/fixture');
    manifest(path, { name: 'fixture-root', optionalDependencies: { 'parent-runtime-fixture-only': '1.0.0' } });
    put(join(path, 'dist/index.js'), 'export {};');
    manifest(join(f.root, 'node_modules/parent-runtime-fixture-only'), { name: 'parent-runtime-fixture-only', version: '1.0.0' });
    const pkg = readRuntimeWorkspacePackage(path, 'dist', true), closure = new HarnessRuntimePackageClosure(childRoot, new Map([['fixture-root', pkg]]));
    expect(() => closure.visitWorkspace('fixture-root')).toThrow(/would resolve outside its approved root/);
  });

  it('rejects deployment drift before creating a worktree or SDK when only a previously approved nested split changes', async () => {
    const f = fixture('harness'), plugin = join(f.root, 'external-plugin');
    manifest(plugin, { name: '@openslack/deepseek-harness-plugin' }); put(join(plugin, 'plugin.patch.yml'), '[]');
    put(join(plugin, 'THIRD-PARTY-NOTICES.txt'), 'fixture notice');
    for (const name of HARNESS_PLUGIN_ENTRIES) put(join(plugin, 'dist', `${name}.js`), 'export {};');
    put(join(plugin, HARNESS_NATIVE_SUPERVISOR_FILE), 'fixture identity only');
    const home = join(f.root, 'approved-home'); manifest(join(home, 'profiles/sdk'), {});
    const patch = join(f.root, 'worker.json'); put(patch, '[]');
    const deployment = { harnessRoot: f.root, pluginRoot: plugin, pluginBuildHash: hashHarnessPluginArtifacts(plugin), nodeExecutable: process.execPath,
      nodeVersion: '24.18.1' as const, nodeSha256: hashHarnessNodeExecutable(process.execPath), dshHome: home,
      agentId: 'fixture', provider: 'fixture', model: 'fixture', workerPatch: patch, exitGraceMs: 30_000 };
    const verification = { resultMode: 'text' as const, requireReport: false, checks: [{ path: 'fixture.txt', expectedText: 'after' }] };
    const config = { agentId: 'fixture', source: 'unit-fixture', runtimeProvider: 'deepseek-harness', model: 'fixture', tools: ['Read', 'Write', 'Edit'], permissionMode: 'acceptEdits' as const };
    const task: ApprovedHarnessTask = { taskId: 'TASK-CLOSURE-FIXTURE', principalId: 'fixture-only', principalHash: 'a'.repeat(64), baseline: 'b'.repeat(40), timeoutMs: 240_000,
      request: { agentId: 'fixture', prompt: 'fixture', resolvedConfig: config, permissionProfile: buildHarnessTaskPermissionProfile(config) },
      scope: { readPaths: ['fixture.txt'], writePaths: ['fixture.txt'], forbiddenPaths: ['.git/**'] }, outputSchema: { type: 'object' },
      executionBuildHash: f.hash(), verificationHash: hashHarnessInput(verification), deploymentHash: hashHarnessDeployment(deployment) };
    const store = createRunStore(f.root, { sweepOrphans: false }), runId = 'RUN-CLOSURE-FIXTURE';
    store.createRun({ ...task.request, runId });
    store.updateRun(runId, { harnessExecution: { schema: 'openslack.harness_execution.v1', taskId: task.taskId, requestHash: hashHarnessTask(task), principalHash: task.principalHash,
      baseline: task.baseline, acceptance: 'pending', summary: 'fixture', reports: {}, evidenceRefs: [],
      lifecycle: { phase: 'authorized', ownerGeneration: 'fixture-owner', deadlineAt: new Date(Date.now() + task.timeoutMs).toISOString() } } });
    put(f.split, readFileSync(f.split, 'utf8').replace('+"A"', '+"B"'));
    const prepare = createHarnessTaskExecution({ workspaceRoot: f.root, identityRoot: f.root, store, deployment,
      authorizeTool: async () => { throw new Error('No SDK or tool may start'); }, verification: () => verification });
    await expect(prepare(task, runId, new AbortController().signal)).rejects.toThrow('verifier or deployment does not match the approved task');
    expect(existsSync(join(f.root, '.worktrees'))).toBe(false);
    expect(store.getRun(runId)?.status).toBe('pending');
  });
});
