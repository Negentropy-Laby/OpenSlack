import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync,
  readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseDocument } from 'yaml';
import { ToolGuard } from './adapter.js';
import type { BridgeProcessAdapterOptions } from './bridge-adapter.js';
import { createDeepSeekHarnessProvider, type DeepSeekHarnessDeployment } from './deepseek-harness-provider.js';
import { hashHarnessTask, type ApprovedHarnessTask, type HarnessTaskHostOptions } from './harness-task-host.js';
import { createRunRecorder } from './recorder.js';
import type { AgentRunStore } from './run-store.js';
import { RepositoryToolExecutor } from './tool-executor.js';
import { isSensitiveRepositoryPath } from './sensitive-data.js';
import { canonicalHarnessInput, hashHarnessInput } from './harness-admission.js';
import { canonicalHarnessRoot, readHarnessFile } from './harness-read.js';
import { visitStrictTranscript } from './transcript.js';
import { hashOpenSlackHarnessCallback, captureHarnessArtifactObservation, inspectHarnessArtifactObservation,
  type HarnessArtifactObservation, harnessPluginMountFiles } from './harness-artifacts.js';
import { createRequire } from 'node:module';
import type { AgentRunState } from './types.js';
import type { HarnessRecoveryObservation } from './harness-reconciliation.js';
import { assertHarnessTaskEligibility, assertHarnessRunStartEligibility, bindHarnessRunStartEligibility } from './harness-eligibility.js';
import { assertHarnessNotStopped } from './harness-stop.js';
import { HARNESS_CLEANUP_BUDGET, assertHarnessCleanupBudget } from './bridge-cleanup.js';
import { HarnessRuntimePackageClosure, readRuntimeWorkspacePackage, type RuntimeWorkspacePackage } from './harness-runtime-closure.js';

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
  assertHarnessCleanupBudget(deployment.exitGraceMs);
  return deploymentDigest(deployment, harnessRuntimeArtifacts(deployment.harnessRoot),
    captureHarnessArtifactObservation(deployment.pluginRoot, deployment.nodeExecutable));
}

function deploymentDigest(deployment: HarnessTaskExecutionOptions['deployment'], runtime: ReturnType<typeof harnessRuntimeArtifacts>, proof: HarnessArtifactObservation): string {
  assertHarnessCleanupBudget(deployment.exitGraceMs);
  const publicEntries = new Map(Object.entries(runtime.entries));
  const observed = inspectHarnessArtifactObservation(proof, deployment.pluginRoot, deployment.nodeExecutable);
  const plugin = observed.pluginHash;
  if (plugin !== deployment.pluginBuildHash || deployment.nodeVersion !== '24.18.1' || process.versions.node !== deployment.nodeVersion ||
    deployment.nodeExecutable !== process.execPath || observed.nodeHash !== deployment.nodeSha256) {
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
  return readHarnessFile(path, maxBytes, { trustedArtifact });
}

function readToolEvidence(path: string, allowedTools: readonly string[]): string {
  const balance = new Map<string, number>();
  const digest = createHash('sha256').update('[');
  let first = true;
  visitStrictTranscript(path, event => {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') return;
    const name = event.data?.toolName;
    if (typeof name !== 'string' || !allowedTools.includes(name)) throw new Error('Unapproved tool evidence');
    const key = typeof event.data.callId === 'string' ? `call:${event.data.callId}` : `legacy:${name}`;
    const count = (balance.get(key) ?? 0) + (event.type === 'tool_call' ? 1 : -1);
    balance.set(key, count);
    if (count < 0) throw new Error('Unmatched tool result evidence');
    if (!first) digest.update(',');
    digest.update(canonicalHarnessInput(event)); first = false;
  });
  if ([...balance.values()].some(value => value !== 0)) throw new Error('Unmatched tool call evidence');
  return digest.update(']').digest('hex');
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
  harnessRoot = canonicalHarnessRoot(harnessRoot);
  const packages = new Map<string, RuntimeWorkspacePackage>();
  const add = (path: string, output: RuntimeWorkspacePackage['output'] = 'lib'): void => {
    const pkg = readRuntimeWorkspacePackage(path, output, output === 'application');
    const name = pkg.manifest.name as string;
    if (packages.has(name)) throw new Error('Duplicate Harness workspace package identity');
    packages.set(name, pkg);
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
  // apps/* is a first-party workspace family in the pinned public manifest.
  // Classify only a dependency-visited app's declared compiled output; never
  // scan its source/tests as though it were an installed third-party package.
  for (const application of readdirSync(join(harnessRoot, 'apps'), { withFileTypes: true })) {
    if (application.isSymbolicLink()) throw new Error('Harness application workspace must not be linked');
    const path = join(harnessRoot, 'apps', application.name);
    if (application.isDirectory() && existsSync(join(path, 'package.json'))) add(path, 'application');
  }
  const closure = new HarnessRuntimePackageClosure(harnessRoot, packages);
  for (const root of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh-sdk-jsonrpc-server', '@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh']) closure.visitWorkspace(root);
  closure.addFile(join(harnessRoot, 'pnpm-lock.yaml'), 16 * 1024 * 1024);
  const native = join(harnessRoot, 'native/system/packages', `${process.platform}-${process.arch}`);
  if (existsSync(native)) closure.addDirectory(native);
  // The peer directly consumes these two public MCP exports. Bind their entire
  // installed dependency closure, including split chunks, not only their entry.
  const mcp = packages.get('@deepseek-ai/dsh-mcp-client')!;
  const mcpDirectory = closure.dependency(mcp.path, '@modelcontextprotocol/client')!;
  const mcpManifest = JSON.parse(readRegular(join(mcpDirectory, 'package.json'), 512 * 1024, true).toString('utf8')) as { exports: Record<string, unknown> };
  const observed = closure.finish();
  const entries: Record<string, string> = {};
  const exported = (value: unknown): string | undefined => typeof value === 'string' ? value
    : value && typeof value === 'object' ? ['import', 'node', 'default'].map(key => exported((value as Record<string, unknown>)[key])).find(Boolean) : undefined;
  for (const name of observed.workspaceNames) {
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
  for (const name of ['@modelcontextprotocol/client', '@modelcontextprotocol/client/stdio']) {
    const file = exported(mcpManifest.exports[name.endsWith('/stdio') ? './stdio' : '.']);
    if (!file) throw new Error('MCP public ESM entry is absent');
    const entry = resolve(mcpDirectory, file), local = relative(mcpDirectory, entry);
    if (isAbsolute(local) || local.split(/[\\/]/).includes('..')) throw new Error('MCP public entry escapes its package');
    entries[name] = entry;
  }
  return { hash: observed.hash, entries, mounts: Object.values(entries) };
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
  assertHarnessCleanupBudget(options.deployment.exitGraceMs);
  return async (task: ApprovedHarnessTask, runId, signal) => {
    signal.throwIfAborted();
    const admission = options.store.readRun(runId);
    const earlyCutoff = Date.parse(admission?.harnessExecution?.lifecycle?.deadlineAt ?? '') - HARNESS_CLEANUP_BUDGET.totalMs;
    const localDeadline = performance.now() + Math.min(task.timeoutMs, earlyCutoff + HARNESS_CLEANUP_BUDGET.totalMs - Date.now());
    const executionRemaining = () => Math.floor(Math.min(earlyCutoff - Date.now(), localDeadline - HARNESS_CLEANUP_BUDGET.totalMs - performance.now()));
    const checkPreparation = () => { signal.throwIfAborted(); if (!Number.isFinite(earlyCutoff) || executionRemaining() <= 0) throw new Error('Harness preparation cannot fit the required cleanup within the total deadline'); };
    checkPreparation();
    const runtime = harnessRuntimeArtifacts(options.deployment.harnessRoot);
    const proof = captureHarnessArtifactObservation(options.deployment.pluginRoot, options.deployment.nodeExecutable);
    const definition = structuredClone(options.verification(task.taskId));
    if (task.verificationHash !== hashHarnessInput(definition) ||
      task.deploymentHash !== deploymentDigest(options.deployment, runtime, proof)) {
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
    if (!task.executionBuildHash || task.executionBuildHash !== runtime.hash) {
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
    checkPreparation();
    git(options.workspaceRoot, 'worktree', 'add', '-b', branch, worktree, task.baseline);
    const index = hash(git(worktree, 'ls-files', '--stage', '-z'));
    if (git(worktree, 'status', '--porcelain=v1', '--untracked-files=all').trim()) throw new Error('Fresh task worktree is not clean');
    const bindingDirectory = join(options.identityRoot, '.openslack.local/agents/harness-bindings');
    directories(options.identityRoot, bindingDirectory, true);
    const workerBinding = join(bindingDirectory, `${runId}.json`);
    const state = options.store.readRun(runId);
    if (!state?.harnessExecution) throw new Error('Canonical pending Harness run is missing');
    const deadline = Date.parse(state.harnessExecution.lifecycle?.deadlineAt ?? '');
    const executionDeadline = deadline - HARNESS_CLEANUP_BUDGET.totalMs;
    if (executionDeadline !== earlyCutoff) throw new Error('Harness admission deadline changed during preparation');
    checkPreparation();
    options.store.withRunTransaction(runId, current => ({ patch: { harnessExecution: { ...current.harnessExecution!,
      lifecycle: { ...current.harnessExecution!.lifecycle!, executionDeadlineAt: new Date(executionDeadline).toISOString() } } } }));
    writeFileSync(workerBinding, JSON.stringify({
      taskId: task.taskId, runId, principalId: task.principalId, generation: state.harnessExecution.lifecycle!.ownerGeneration,
      requestHash: state.harnessExecution.requestHash,
      root: worktree, expiresAt: new Date(executionDeadline).toISOString(),
      readPaths: task.scope.readPaths, writePaths: task.scope.writePaths,
      systemText: `Current OpenSlack task: ${task.taskId}. Current run: ${runId}. Report progress only through harness.task.report for this run; do not dispatch another task or declare acceptance.`,
      callbacks: definition.requireReport, resultMode: definition.resultMode,
      runtimeEntries: harnessPluginRuntimeEntries(runtime.entries),
      ...(definition.requireReport ? { callbackMcp: options.deployment.callbackMcp } : {}),
    }), { flag: 'wx', mode: 0o600 });
    options.store.updateRun(runId, { worktreePath: worktree, worktreeHandoff: {
      worktreePath: worktree, branchName: branch, reason: 'Retained Harness task worktree; no automatic cleanup or merge.', preservedAt: new Date().toISOString(),
    } });
    // Resolve once within this synchronous observation phase to validate the prepared
    // provider; execution obtains its own fresh proof and remaining absolute budget.
    checkPreparation();
    createDeepSeekHarnessProvider({ ...options.deployment, workerBinding, timeoutMs: Math.max(1, executionRemaining()) },
      options.authorizeTool, definition.requireReport ? ['openslack'] : [], proof).resolve(task.request.resolvedConfig);
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
      async execute(executionSignal, eligibility) {
        executionSignal.throwIfAborted();
        if (executionRemaining() <= 0) throw new Error('Harness execution cutoff elapsed before deployment observation');
        const expectedEligibility = { taskId: task.taskId, taskHash: hashHarnessTask(task), principalId: task.principalId!, principalHash: task.principalHash, phase: 'execute' as const };
        assertHarnessTaskEligibility(eligibility, expectedEligibility);
        const executionRuntime = harnessRuntimeArtifacts(options.deployment.harnessRoot);
        const executionProof = captureHarnessArtifactObservation(options.deployment.pluginRoot, options.deployment.nodeExecutable);
        if (deploymentDigest(options.deployment, executionRuntime, executionProof) !== task.deploymentHash ||
          hashHarnessInput(options.verification(task.taskId)) !== task.verificationHash) {
          throw new Error('Harness deployment or verifier changed before execution');
        }
        const current = options.store.readRun(runId)!;
        const currentBinding = current?.harnessExecution, lifecycle = currentBinding?.lifecycle;
        if (current.status !== 'running' || currentBinding?.taskId !== task.taskId || currentBinding.requestHash !== hashHarnessTask(task) ||
          currentBinding.principalHash !== task.principalHash || lifecycle?.phase !== 'started' ||
          lifecycle.ownerGeneration !== state.harnessExecution!.lifecycle!.ownerGeneration ||
          lifecycle.executionDeadlineAt !== new Date(executionDeadline).toISOString()) {
          throw new Error('Harness execution start differs from its canonical confirmed binding');
        }
        assertHarnessNotStopped(options.identityRoot, current);
        executionSignal.throwIfAborted();
        const remaining = executionRemaining();
        if (remaining <= 0) throw new Error('Harness execution cutoff elapsed during deployment observation');
        assertHarnessTaskEligibility(eligibility, expectedEligibility);
        const startEligibility = bindHarnessRunStartEligibility(eligibility, { runId, generation: lifecycle.ownerGeneration });
        const adapter = createDeepSeekHarnessProvider({ ...options.deployment, workerBinding, timeoutMs: remaining },
          options.authorizeTool, definition.requireReport ? ['openslack'] : [], executionProof).resolve(task.request.resolvedConfig).adapter;
        assertHarnessRunStartEligibility(startEligibility, { runId, requestHash: currentBinding.requestHash,
          principalHash: currentBinding.principalHash, generation: lifecycle.ownerGeneration });
        assertHarnessNotStopped(options.identityRoot, current);
        const result = await adapter.execute({
          prompt: task.request.prompt, runId, agentId: task.request.agentId, resolvedConfig: task.request.resolvedConfig,
          permissionProfile: task.request.permissionProfile, worktreePath: worktree,
          recorder, runState: current, signal: executionSignal, executionDeadline,
          executionMonotonicDeadline: localDeadline - HARNESS_CLEANUP_BUDGET.totalMs, startEligibility, toolGuard: guard,
          toolExecutor: new RepositoryToolExecutor({ rootPath: worktree, toolGuard: guard, recorder, runId }),
        });
        return { data: result.data, exitConfirmed: true, ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }) };
      },
      async accept(_data, acceptanceSignal, eligibility) {
        const checkEligibility = () => {
          acceptanceSignal.throwIfAborted();
          if (performance.now() >= localDeadline || Date.now() >= deadline) throw new Error('Harness total deadline expired before acceptance evidence publication');
          assertHarnessTaskEligibility(eligibility, { taskId: task.taskId, taskHash: hashHarnessTask(task), principalId: task.principalId!, principalHash: task.principalHash, phase: 'accept' });
        };
        checkEligibility();
        if (hashHarnessDeployment(options.deployment) !== task.deploymentHash ||
          hashHarnessInput(options.verification(task.taskId)) !== task.verificationHash) {
          throw new Error('Harness deployment or verifier changed before acceptance');
        }
        const changes = new Set(changeNames());
        const current = options.store.readRun(runId);
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
        checkEligibility();
        const evidenceRefs = [`run:${runId}`];
        if (checks && reported) {
          const files = observedFiles.map(({ path, sha256 }) => ({ path, sha256 }));
          const transcript = readToolEvidence(current!.transcriptPath, task.request.permissionProfile.allowedTools);
          const directory = join(options.identityRoot, '.openslack.local/agents/runs', runId);
          directories(options.identityRoot, directory);
          checkEligibility();
          const evidence = openSync(join(directory, 'acceptance.json'), 'wx', 0o600);
          try {
            writeFileSync(evidence, JSON.stringify({ schema: 'openslack.harness_acceptance.v1', taskId: task.taskId, runId,
              requestHash: current!.harnessExecution!.requestHash, baseline: task.baseline, head: task.baseline, indexHash: index,
              files, toolEvidenceHash: transcript, observedAt: new Date().toISOString() }));
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
        evidence.toolEvidenceHash === readToolEvidence(state.transcriptPath, task.request.permissionProfile.allowedTools);
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
