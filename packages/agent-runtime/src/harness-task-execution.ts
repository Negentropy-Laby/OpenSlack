import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, fstatSync, fsyncSync,
  readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { ToolGuard } from './adapter.js';
import type { BridgeProcessAdapterOptions } from './bridge-adapter.js';
import { createDeepSeekHarnessProvider, type DeepSeekHarnessDeployment } from './deepseek-harness-provider.js';
import type { ApprovedHarnessTask, HarnessTaskHostOptions } from './harness-task-host.js';
import { createRunRecorder } from './recorder.js';
import type { AgentRunStore } from './run-store.js';
import { RepositoryToolExecutor } from './tool-executor.js';
import { isSensitiveRepositoryPath } from './sensitive-data.js';
import { hashHarnessInput } from './harness-admission.js';
import { hashOpenSlackHarnessCallback, hashHarnessPluginArtifacts, hashHarnessNodeExecutable, harnessPluginMountFiles } from './harness-artifacts.js';
import { createRequire } from 'node:module';
import type { AgentRunState } from './types.js';
import type { HarnessRecoveryObservation } from './harness-reconciliation.js';

/** Trusted first-delivery verification. Never derive checks or commands from success_criteria or model output. */
export interface HarnessTextVerification {
  resultMode: 'text' | 'json';
  requireReport: boolean;
  checks: Array<{ path: string; expectedText: string }>;
}

/** Prepared deployment and task definitions are supplied after provisioning; no credential values are accepted. */
export interface HarnessTaskExecutionOptions {
  workspaceRoot: string;
  identityRoot: string;
  store: AgentRunStore;
  deployment: Omit<DeepSeekHarnessDeployment, 'workerBinding' | 'timeoutMs'>;
  authorizeTool: NonNullable<BridgeProcessAdapterOptions['authorizeTool']>;
  verification(taskId: string): HarnessTextVerification;
}

/** Approve the deployment separately from its task-run route and temporary worktree. */
export function hashHarnessDeployment(deployment: HarnessTaskExecutionOptions['deployment']): string {
  const runtime = harnessRuntimeArtifacts(deployment.harnessRoot);
  const publicEntries = new Map(Object.entries(runtime.entries));
  const plugin = hashHarnessPluginArtifacts(deployment.pluginRoot);
  if (plugin !== deployment.pluginBuildHash || deployment.nodeVersion !== '24.18.1' || process.versions.node !== deployment.nodeVersion ||
    deployment.nodeExecutable !== process.execPath || hashHarnessNodeExecutable(process.execPath) !== deployment.nodeSha256) {
    throw new Error('Harness plugin or Node differs from its approved deployment');
  }
  for (const [key, file] of Object.entries({ '': 'index', '/initiator': 'initiator', '/readonly': 'readonly', '/sdk-host': 'sdk-host' })) {
    publicEntries.set(`@openslack/deepseek-harness-plugin${key}`, join(deployment.pluginRoot, 'dist', `${file}.js`));
  }
  const runtimeEntries = harnessPluginRuntimeEntries(runtime.entries);
  assertNoPeerOverrides([deployment.pluginRoot, join(deployment.dshHome, 'profiles/sdk')], runtime.entries);
  const mounts = new Set([...runtime.mounts, ...harnessPluginMountFiles(deployment.pluginRoot)]);
  const profile: Record<string, string> = {};
  for (const path of ['profiles/sdk/package.json', 'profiles/sdk/cordis.patch.yml', 'cordis.patch.yml']) {
    const file = join(deployment.dshHome, path);
    profile[path] = existsSync(file) ? hash(readRegular(file, 1024 * 1024, true)) : 'absent';
    if (path.endsWith('.yml') && existsSync(file)) Object.assign(profile, hashLocalMounts(file, mounts, publicEntries));
  }
  const manifest = JSON.parse(readRegular(join(deployment.dshHome, 'profiles/sdk/package.json'), 512 * 1024, true).toString('utf8')) as Record<string, unknown>;
  if (manifest.dependencies && typeof manifest.dependencies === 'object') {
    if (Object.keys(manifest.dependencies).some(name => name !== '@openslack/deepseek-harness-plugin')) {
      throw new Error('Unbound SDK profile package overrides are forbidden');
    }
    if (Object.keys(manifest.dependencies).length) {
      const resolved = createRequire(join(deployment.dshHome, 'profiles/sdk/package.json')).resolve('@openslack/deepseek-harness-plugin/package.json');
      if (resolve(dirname(resolved)) !== resolve(deployment.pluginRoot)) throw new Error('SDK profile resolves a different external plugin');
    }
  }
  Object.assign(profile, hashLocalMounts(deployment.workerPatch, mounts, publicEntries));
  return hashHarnessInput({ ...deployment,
    workerPatch: hash(readRegular(deployment.workerPatch, 1024 * 1024, true)),
    ...(deployment.callbackMcp ? { callbackBuild: hashOpenSlackHarnessCallback(deployment.callbackMcp.cliModule) } : {}),
    build: runtime.hash, plugin, runtimeEntries,
    profile,
  });
}

function hashLocalMounts(patch: string, mounts: ReadonlySet<string>, publicEntries: ReadonlyMap<string, string>): Record<string, string> {
  const document = parseDocument(readRegular(patch, 1024 * 1024, true).toString('utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: () => { throw new Error('Dynamic Harness configuration cannot be bound'); } }],
  });
  if (document.errors.length) throw new Error('Harness mount configuration is not parseable');
  const inputs: Record<string, string> = {};
  const visit = (rows: unknown): void => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new Error('Invalid Harness mount entry');
      if ('name' in row) {
        if (typeof row.name !== 'string') throw new Error('Dynamic Harness plugin names cannot be bound');
        if (row.name.startsWith('file:') || row.name.startsWith('.') || isAbsolute(row.name)) {
          const path = row.name.startsWith('file:') ? fileURLToPath(row.name) : resolve(dirname(patch), row.name);
          if (!mounts.has(path)) {
            throw new Error('External or unsupported Harness plugin mounts require a separately bound deployment');
          }
          inputs[path] = hash(readRegular(path, 32 * 1024 * 1024, true));
        } else {
          const path = publicEntries.get(row.name);
          if (!path) throw new Error('Unbound external Harness plugin package or subpath');
          inputs[path] = hash(readRegular(path, 32 * 1024 * 1024, true));
        }
      }
      for (const key of ['insert', 'children']) if (key in row) visit(row[key as keyof typeof row]);
      if ('config' in row && Array.isArray(row.config)) visit(row.config);
      else if ('config' in row && row.config && typeof row.config === 'object' && 'plugins' in row.config) {
        if (!Array.isArray(row.config.plugins)) throw new Error('Dynamic preset plugin lists cannot be bound');
        visit(row.config.plugins);
      }
    }
  };
  visit(document.toJS());
  return inputs;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function safeFile(path: string): void {
  if (!path || isAbsolute(path) || path.includes('\\') || isSensitiveRepositoryPath(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.git') || part.startsWith('.openslack'))) {
    throw new Error('Harness text task requires exact nonsecret file paths');
  }
}

function readRegular(path: string, maxBytes: number, trustedArtifact = false): Buffer {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (!trustedArtifact && entry.nlink !== 1)) throw new Error('Harness evidence is not an owned regular file');
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(file);
    if (entry.ino !== before.ino || entry.dev !== before.dev || before.size > maxBytes) throw new Error('Harness evidence read bound exceeded');
    const data = readFileSync(file);
    const after = fstatSync(file);
    if (before.size !== data.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size || before.ino !== after.ino || before.mode !== after.mode) throw new Error('Harness evidence changed during read');
    return data;
  } finally { closeSync(file); }
}

function readToolEvidence(path: string, allowedTools: readonly string[]) {
  const events = readRegular(path, 8 * 1024 * 1024).toString('utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { type: string; data: { toolName?: string } })
    .filter(event => event.type === 'tool_call' || event.type === 'tool_result');
  const balance = new Map<string, number>();
  for (const event of events) {
    if (!event.data?.toolName || !allowedTools.includes(event.data.toolName)) throw new Error('Unapproved tool evidence');
    const count = (balance.get(event.data.toolName) ?? 0) + (event.type === 'tool_call' ? 1 : -1);
    balance.set(event.data.toolName, count);
    if (count < 0) throw new Error('Unmatched tool result evidence');
  }
  if ([...balance.values()].some(value => value !== 0)) throw new Error('Unmatched tool call evidence');
  return events;
}

function directories(root: string, path: string, create = false): void {
  const local = relative(root, path);
  if (isAbsolute(local) || local.split(/[\\/]/).includes('..')) throw new Error('Harness storage is outside its approved root');
  let current = root;
  for (const part of ['', ...local.split(/[\\/]/).filter(Boolean)]) {
    if (part) current = join(current, part);
    if (create && !existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const entry = lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Harness storage cannot traverse a link');
  }
}

/** Hash actual matching runtime artifacts, not a version label or ignored source copy. */
export function hashHarnessRuntimeArtifacts(harnessRoot: string): string {
  return harnessRuntimeArtifacts(harnessRoot).hash;
}

function harnessRuntimeArtifacts(harnessRoot: string): { hash: string; entries: Record<string, string>; mounts: string[] } {
  const digest = createHash('sha256');
  const packages = new Map<string, { path: string; manifest: Record<string, unknown>; bytes: Buffer }>();
  const add = (path: string): void => {
    const bytes = readRegular(join(path, 'package.json'), 512 * 1024, true);
    const manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (typeof manifest.name !== 'string') throw new Error('Invalid Harness package identity');
    packages.set(manifest.name, { path, manifest, bytes });
  };
  for (const group of readdirSync(join(harnessRoot, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const pkg of readdirSync(join(harnessRoot, 'packages', group.name), { withFileTypes: true })) {
      const path = join(harnessRoot, 'packages', group.name, pkg.name);
      if (pkg.isDirectory() && existsSync(join(path, 'package.json'))) add(path);
    }
  }
  for (const pkg of readdirSync(join(harnessRoot, 'vendor'), { withFileTypes: true })) {
    const path = join(harnessRoot, 'vendor', pkg.name);
    if (pkg.isDirectory() && existsSync(join(path, 'package.json'))) add(path);
  }
  add(join(harnessRoot, 'apps/cli'));
  const walk = (directory: string): void => {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Harness artifact directory must not be linked');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Harness artifact links are unsupported');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:js|mjs|cjs|node)$/.test(entry.name)) {
        digest.update(relative(harnessRoot, path)).update(readRegular(path, 64 * 1024 * 1024, true));
      }
    }
  };
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const pkg = packages.get(name);
    if (!pkg) throw new Error('Harness workspace dependency is unavailable');
    digest.update(relative(harnessRoot, pkg.path)).update(pkg.bytes);
    const dsh = pkg.manifest.dsh;
    if (dsh && typeof dsh === 'object' && 'bundle' in dsh && dsh.bundle && typeof dsh.bundle === 'object' && 'patch' in dsh.bundle) {
      const patch = dsh.bundle.patch;
      for (const file of Array.isArray(patch) ? patch : [patch]) {
        if (typeof file !== 'string' || isAbsolute(file) || file.split(/[\\/]/).includes('..') || !/\.(?:yaml|yml|json)$/.test(file)) {
          throw new Error('Unsupported Harness bundle patch declaration');
        }
        digest.update(file).update(readRegular(resolve(pkg.path, file), 1024 * 1024, true));
      }
    }
    if (existsSync(join(pkg.path, 'lib'))) walk(join(pkg.path, 'lib'));
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const dependencies = pkg.manifest[field];
      if (!dependencies || typeof dependencies !== 'object') continue;
      for (const dependency of Object.keys(dependencies).sort()) if (packages.has(dependency)) visit(dependency);
    }
  };
  for (const root of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh-sdk-jsonrpc-server', '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh']) visit(root);
  // Third-party versions remain bound by the frozen installation lock; no credential data is part of this closure.
  digest.update(readRegular(join(harnessRoot, 'pnpm-lock.yaml'), 16 * 1024 * 1024, true));
  const native = join(harnessRoot, 'native/system/packages', `${process.platform}-${process.arch}`);
  if (existsSync(native)) walk(native);
  const entries: Record<string, string> = {};
  const exported = (value: unknown): string | undefined => typeof value === 'string' ? value
    : value && typeof value === 'object' ? ['import', 'node', 'default'].map(key => exported((value as Record<string, unknown>)[key])).find(Boolean) : undefined;
  for (const name of visited) {
    const pkg = packages.get(name)!;
    const table = pkg.manifest.exports;
    if (!table || typeof table !== 'object') continue;
    for (const [key, value] of Object.entries(table)) {
      const file = exported(value);
      if ((key === '.' || key.startsWith('./')) && !key.includes('*') && file && !file.includes('*') && /^\.\/.*\.(?:js|mjs|cjs)$/.test(file)) {
        entries[name + (key === '.' ? '' : key.slice(1))] = resolve(pkg.path, file);
      }
    }
  }
  // Locate third-party peers through the approved native MCP package, then use
  // its public ESM exports, never the require-condition CJS alternative.
  const mcp = packages.get('@deepseek-ai/dsh-mcp-client')!;
  const mcpRequire = createRequire(join(mcp.path, 'package.json'));
  for (const name of ['@modelcontextprotocol/client', '@modelcontextprotocol/client/stdio']) {
    const directory = resolve(dirname(mcpRequire.resolve(name)), '..');
    const local = relative(realpathSync(harnessRoot), realpathSync(directory));
    if (isAbsolute(local) || local.split(/[\\/]/).includes('..')) throw new Error('MCP peer is outside approved Harness');
    const bytes = readRegular(join(directory, 'package.json'), 512 * 1024, true);
    const manifest = JSON.parse(bytes.toString('utf8')) as { exports: Record<string, unknown> };
    const file = exported(manifest.exports[name.endsWith('/stdio') ? './stdio' : '.']);
    if (!file) throw new Error('MCP public ESM entry is absent');
    entries[name] = resolve(directory, file);
    digest.update(bytes).update(readRegular(entries[name]!, 64 * 1024 * 1024, true));
  }
  return { hash: digest.digest('hex'), entries, mounts: Object.values(entries) };
}

const PLUGIN_RUNTIME_PEERS = ['@deepseek-ai/schemastery', '@deepseek-ai/cordis', '@deepseek-ai/dsh-sdk-protocol',
  '@deepseek-ai/dsh-sdk-jsonrpc-server', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-mcp-client', '@modelcontextprotocol/client', '@modelcontextprotocol/client/stdio'] as const;

function harnessPluginRuntimeEntries(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(PLUGIN_RUNTIME_PEERS.map(name => {
    if (!entries[name]) throw new Error('Required public Harness runtime peer is missing');
    return [name, entries[name]!];
  }));
}

export function harnessPublicRuntimeEntries(root: string): Record<string, string> {
  return harnessPluginRuntimeEntries(harnessRuntimeArtifacts(root).entries);
}

function assertNoPeerOverrides(roots: string[], entries: Record<string, string>): void {
  for (const root of roots) for (let current = resolve(root);; current = dirname(current)) {
    for (const [specifier, expected] of Object.entries(entries)) {
      const name = specifier.split('/').slice(0, 2).join('/');
      const candidate = join(current, 'node_modules', name);
      if (existsSync(candidate)) {
        let packageRoot = dirname(expected);
        while (!existsSync(join(packageRoot, 'package.json')) && packageRoot !== dirname(packageRoot)) packageRoot = dirname(packageRoot);
        if (realpathSync(candidate) !== realpathSync(packageRoot)) throw new Error('External plugin runtime peer override is forbidden');
      }
    }
    if (current === dirname(current)) break;
  }
}

/** Concrete prepare-before-execute path: exclusive fresh worktree, SDK peer, read-only text acceptance, no cleanup. */
export function createHarnessTaskExecution(options: HarnessTaskExecutionOptions): HarnessTaskHostOptions['prepare'] {
  if (!isAbsolute(options.workspaceRoot) || !isAbsolute(options.identityRoot)) throw new Error('Harness host roots must be absolute native paths');
  return async (task: ApprovedHarnessTask, runId, signal) => {
    signal.throwIfAborted();
    const definition = structuredClone(options.verification(task.taskId));
    if (task.verificationHash !== hashHarnessInput(definition) ||
      task.deploymentHash !== hashHarnessDeployment(options.deployment)) {
      throw new Error('Harness verifier or deployment does not match the approved task');
    }
    if (!['text', 'json'].includes(definition.resultMode) ||
      !definition.checks.length || definition.checks.length !== task.scope.writePaths.length ||
      new Set(definition.checks.map(check => check.path)).size !== definition.checks.length ||
      definition.checks.some(check => !task.scope.writePaths.includes(check.path) || typeof check.expectedText !== 'string')) {
      throw new Error('Harness text verification must cover every writable file');
    }
    for (const path of [...task.scope.readPaths, ...task.scope.writePaths]) safeFile(path);
    if (!task.principalId || task.request.resolvedConfig.agentId !== options.deployment.agentId ||
      task.request.resolvedConfig.model !== options.deployment.model ||
      !Number.isSafeInteger(options.deployment.exitGraceMs) || options.deployment.exitGraceMs <= 0) {
      throw new Error('Harness task principal or trusted model deployment is incomplete');
    }
    const tools = task.request.permissionProfile.allowedTools;
    if (!tools.includes('Read') || (task.scope.writePaths.length > 0 && (!tools.includes('Write') || !tools.includes('Edit'))) ||
      (definition.requireReport && ['openslack_get_activity', 'openslack_preview_workflow', 'openslack_confirm_plan', 'openslack_cancel_plan']
        .some(name => !tools.includes(`mcp.openslack.${name}`)))) {
      throw new Error('Harness task lacks a required native or callback capability');
    }
    if (definition.requireReport && !options.deployment.callbackMcp) throw new Error('Harness progress requires a bound callback MCP deployment');
    if (task.request.budget || task.request.resolvedConfig.maxTurns !== undefined || task.request.resolvedConfig.effort !== undefined) {
      throw new Error('Required token/cost/turn/effort constraints are unsupported; no process was started');
    }
    if (!lstatSync(join(options.deployment.dshHome, 'profiles/sdk/package.json')).isFile()) {
      throw new Error('Prepare the approved SDK profile once before dispatch; per-task profile installation is disabled');
    }
    if (!task.executionBuildHash || task.executionBuildHash !== hashHarnessRuntimeArtifacts(options.deployment.harnessRoot)) {
      throw new Error('Harness runtime artifacts differ from the approved task build');
    }
    const versions = ['packages/sdk/client', 'apps/cli'].map(path =>
      (JSON.parse(readRegular(join(options.deployment.harnessRoot, path, 'package.json'), 128 * 1024, true).toString('utf8')) as { version: string }).version);
    if (!versions[0] || new Set(versions).size !== 1) throw new Error('Harness peer requires a same-version SDK and dsh');
    readRegular(options.deployment.workerPatch, 1024 * 1024, true);
    for (const id of [task.taskId, task.request.agentId, runId]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('Invalid isolated Harness task identity');
    }
    const worktree = join(options.workspaceRoot, '.worktrees', runId);
    directories(options.workspaceRoot, dirname(worktree), true);
    const branch = `agent/${task.request.agentId}/${task.taskId}/${runId}`;
    if (existsSync(worktree) || git(options.workspaceRoot, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`).trim()) {
      throw new Error('Harness worktree or branch already exists; preserve and reconcile without reuse');
    }
    signal.throwIfAborted();
    git(options.workspaceRoot, 'worktree', 'add', '-b', branch, worktree, task.baseline);
    const index = hash(git(worktree, 'ls-files', '--stage', '-z'));
    if (git(worktree, 'status', '--porcelain=v1', '--untracked-files=all').trim()) throw new Error('Fresh task worktree is not clean');
    const bindingDirectory = join(options.identityRoot, '.openslack.local/agents/harness-bindings');
    directories(options.identityRoot, bindingDirectory, true);
    const workerBinding = join(bindingDirectory, `${runId}.json`);
    const state = options.store.getRun(runId);
    if (!state?.harnessExecution) throw new Error('Canonical pending Harness run is missing');
    const deadline = Date.parse(state.startedAt) + task.timeoutMs;
    if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error('Harness preparation exceeded the total task deadline');
    writeFileSync(workerBinding, JSON.stringify({
      taskId: task.taskId, runId, principalId: task.principalId, generation: state.harnessExecution.requestHash,
      root: worktree, expiresAt: new Date(deadline).toISOString(),
      readPaths: task.scope.readPaths, writePaths: task.scope.writePaths,
      systemText: `Current OpenSlack task: ${task.taskId}. Current run: ${runId}. Report progress only through harness.task.report for this run; do not dispatch another task or declare acceptance.`,
      callbacks: definition.requireReport, resultMode: definition.resultMode,
      runtimeEntries: harnessPublicRuntimeEntries(options.deployment.harnessRoot),
      ...(definition.requireReport ? { callbackMcp: options.deployment.callbackMcp } : {}),
    }), { flag: 'wx', mode: 0o600 });
    options.store.updateRun(runId, { worktreePath: worktree, worktreeHandoff: {
      worktreePath: worktree, branchName: branch, reason: 'Retained Harness task worktree; no automatic cleanup or merge.', preservedAt: new Date().toISOString(),
    } });
    const adapter = createDeepSeekHarnessProvider({ ...options.deployment, workerBinding, timeoutMs: Math.max(1, deadline - Date.now()) },
      options.authorizeTool, definition.requireReport ? ['openslack'] : []).resolve(task.request.resolvedConfig).adapter;
    const recorder = createRunRecorder(options.store, options.identityRoot);
    const guard = new ToolGuard(task.request.permissionProfile, recorder, runId);
    let acceptedFiles: Array<{ path: string; sha256: string }> | undefined;
    let acceptedChangeNames: string[] | undefined;
    const changeNames = () => [...new Set([
      ...git(worktree, 'diff', '--name-only', '--no-renames', '-z', task.baseline, '--').split('\0'),
      ...git(worktree, 'ls-files', '--others', '--exclude-standard', '-z').split('\0'),
      ...git(worktree, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z').split('\0'),
    ].filter(Boolean))].sort();
    return {
      async execute(executionSignal) {
        if (hashHarnessDeployment(options.deployment) !== task.deploymentHash ||
          hashHarnessInput(options.verification(task.taskId)) !== task.verificationHash) {
          throw new Error('Harness deployment or verifier changed before execution');
        }
        const current = options.store.getRun(runId)!;
        const result = await adapter.execute({
          prompt: task.request.prompt, runId, agentId: task.request.agentId, resolvedConfig: task.request.resolvedConfig,
          permissionProfile: task.request.permissionProfile, worktreePath: worktree,
          recorder, runState: current, signal: executionSignal, toolGuard: guard,
          toolExecutor: new RepositoryToolExecutor({ rootPath: worktree, toolGuard: guard, recorder, runId }),
        });
        return { data: result.data, exitConfirmed: true, ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }) };
      },
      async accept(_data, acceptanceSignal) {
        acceptanceSignal.throwIfAborted();
        if (hashHarnessDeployment(options.deployment) !== task.deploymentHash ||
          hashHarnessInput(options.verification(task.taskId)) !== task.verificationHash) {
          throw new Error('Harness deployment or verifier changed before acceptance');
        }
        const changes = new Set(changeNames());
        const current = options.store.getRun(runId);
        const summary = git(worktree, 'diff', '--summary', '--no-ext-diff', '--no-textconv', task.baseline, '--');
        const metadataSafe = git(worktree, 'rev-parse', 'HEAD').trim() === task.baseline &&
          hash(git(worktree, 'ls-files', '--stage', '-z')) === index && !/mode change|delete mode|rename/.test(summary) &&
          [...changes].every(path => task.scope.writePaths.includes(path));
        const observedFiles = metadataSafe ? definition.checks.map(check => {
          directories(worktree, dirname(resolve(worktree, check.path)));
          const bytes = readRegular(resolve(worktree, check.path), 1024 * 1024);
          return { path: check.path, sha256: hash(bytes), matches: bytes.toString('utf8') === check.expectedText };
        }) : [];
        const checks = metadataSafe && observedFiles.every(file => file.matches);
        const reported = !definition.requireReport || Object.keys(current?.harnessExecution?.reports ?? {}).length > 0;
        acceptanceSignal.throwIfAborted();
        const evidenceRefs = [`run:${runId}`];
        if (checks && reported) {
          const files = observedFiles.map(({ path, sha256 }) => ({ path, sha256 }));
          const transcript = readToolEvidence(current!.transcriptPath, task.request.permissionProfile.allowedTools);
          const directory = join(options.identityRoot, '.openslack.local/agents/runs', runId);
          directories(options.identityRoot, directory);
          const evidence = openSync(join(directory, 'acceptance.json'), 'wx', 0o600);
          try {
            writeFileSync(evidence, JSON.stringify({ schema: 'openslack.harness_acceptance.v1', taskId: task.taskId, runId,
              requestHash: current!.harnessExecution!.requestHash, baseline: task.baseline, head: task.baseline, indexHash: index,
              files, toolEvidenceHash: hashHarnessInput(transcript), observedAt: new Date().toISOString() }));
            fsyncSync(evidence);
          } finally { closeSync(evidence); }
          evidenceRefs.push(`artifact:harness-acceptance/${runId}`, ...files.map(file => `sha256:${file.sha256}`));
          acceptedFiles = files;
          acceptedChangeNames = [...changes].sort();
        }
        return { outcome: checks && reported ? 'verified' : 'rejected',
          summary: checks && reported ? 'Host verified task scope, Git state and fixed text checks.' : 'Host rejected task changes, progress evidence or fixed text checks.',
          evidenceRefs };
      },
      revalidateAccepted() {
        if (!acceptedFiles || !acceptedChangeNames || git(worktree, 'rev-parse', 'HEAD').trim() !== task.baseline ||
          hash(git(worktree, 'ls-files', '--stage', '-z')) !== index ||
          hashHarnessInput(changeNames()) !== hashHarnessInput(acceptedChangeNames) ||
          /mode change|delete mode|rename/.test(git(worktree, 'diff', '--summary', '--no-ext-diff', '--no-textconv', task.baseline, '--')) ||
          acceptedFiles.some(file => { directories(worktree, dirname(resolve(worktree, file.path)));
            return hash(readRegular(resolve(worktree, file.path), 1024 * 1024)) !== file.sha256; })) {
          throw new Error('Accepted Harness artifacts changed before completion; preserve and reconcile');
        }
      },
    };
  };
}

/** Pure recovery inspection: no SDK, prompt, writer, worktree creation or automatic replay. */
export async function inspectHarnessTaskExecution(options: Pick<HarnessTaskExecutionOptions, 'workspaceRoot' | 'identityRoot' | 'deployment' | 'verification'>,
  task: ApprovedHarnessTask, state: AgentRunState): Promise<HarnessRecoveryObservation> {
  let deployment: HarnessRecoveryObservation['deployment'] = 'unknown';
  let workspace: HarnessRecoveryObservation['workspace'] = 'unknown';
  try {
    const definition = structuredClone(options.verification(task.taskId));
    deployment = task.verificationHash === hashHarnessInput(definition) && task.deploymentHash === hashHarnessDeployment(options.deployment)
      ? 'matched' : 'changed';
    if (state.worktreePath === join(options.workspaceRoot, '.worktrees', state.runId)) {
      const root = state.worktreePath;
      const changes = new Set([...git(root, 'diff', '--name-only', '--no-renames', '-z', task.baseline, '--').split('\0'),
        ...git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0'),
        ...git(root, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z').split('\0')].filter(Boolean));
      const evidenceDirectory = join(options.identityRoot, '.openslack.local/agents/runs', state.runId);
      directories(options.identityRoot, evidenceDirectory);
      const evidence = JSON.parse(readRegular(join(evidenceDirectory, 'acceptance.json'), 1024 * 1024).toString('utf8')) as Record<string, unknown>;
      const files = definition.checks.map(check => {
        safeFile(check.path); directories(root, dirname(resolve(root, check.path)));
        return { path: check.path, sha256: hash(readRegular(resolve(root, check.path), 1024 * 1024)) };
      });
      const evidenceMatches = evidence.schema === 'openslack.harness_acceptance.v1' && evidence.runId === state.runId &&
        evidence.taskId === task.taskId && evidence.requestHash === state.harnessExecution?.requestHash &&
        evidence.baseline === task.baseline && evidence.head === task.baseline &&
        evidence.indexHash === hash(git(root, 'ls-files', '--stage', '-z')) && hashHarnessInput(evidence.files) === hashHarnessInput(files) &&
        evidence.toolEvidenceHash === hashHarnessInput(readToolEvidence(state.transcriptPath, task.request.permissionProfile.allowedTools));
      workspace = evidenceMatches && git(root, 'rev-parse', 'HEAD').trim() === task.baseline &&
        !git(root, 'diff', '--cached', '--name-only', task.baseline, '--').trim() &&
        !/mode change|delete mode|rename/.test(git(root, 'diff', '--summary', '--no-ext-diff', '--no-textconv', task.baseline, '--')) &&
        [...changes].every(path => task.scope.writePaths.includes(path)) && definition.checks.every(check => {
          safeFile(check.path); directories(root, dirname(resolve(root, check.path)));
          return readRegular(resolve(root, check.path), 1024 * 1024).toString('utf8') === check.expectedText;
        }) ? 'matched' : 'changed';
    }
  } catch { /* Missing or unsupported evidence remains unknown; do not repair the source. */ }
  return { deployment, workspace, process: state.harnessExecution?.processExit === 'confirmed' ? 'exited' : 'unknown' };
}
