import { constants as fsConstants, writeSync, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {
  decodeWorkflowRunnerFrame,
  WorkflowRunnerJsonlDecoder,
} from './workflow-runner-framing.js';
import {
  hashWorkflowRunnerManifest,
  hashWorkflowRunnerSource,
  type WorkflowRunnerExecutionDescriptor,
} from './workflow-runner-descriptor.js';
import { WorkflowRunnerDescriptorStore } from './workflow-runner-descriptor-store.js';
import {
  WorkflowRunnerSession,
  type WorkflowRunnerExecutionContext,
  type WorkflowRunnerSourceLoader,
} from './workflow-runner-session.js';
import { assertWorkflowRunnerSourceIsSelfContained } from './workflow-runner-source-policy.js';
import type { RunResult, WorkflowModule } from './types.js';
import { RunStore } from './run-store.js';

export const WORKFLOW_RUNNER_WORKER_ENABLED_ENV = 'OPENSLACK_WORKFLOW_RUNNER_ENABLED' as const;

export interface WorkflowRunnerWorkerConfig {
  readonly enabled: true;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly descriptorRoot: string;
  readonly runnerBuildHash: string;
}

export class WorkflowRunnerWorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunnerWorkerConfigError';
  }
}

export class WorkflowRunnerRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunnerRunStateError';
  }
}

interface PreparedWorkflowSource {
  readonly path: string;
  readonly bytes: Buffer;
  readonly identity: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const SOURCE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.ts'] as const);
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);

function sameSourceIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFilesystemObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sourceIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function assertNoWindowsReparseComponents(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const root = parse(path).root;
  const components = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    const linked = await lstat(current, { bigint: true });
    const canonical = await realpath(current);
    const resolved = await lstat(canonical, { bigint: true });
    if (linked.isSymbolicLink() || !sameFilesystemObject(linked, resolved)) {
      throw new Error('Sealed workflow path contains a reparse component.');
    }
  }
}

async function readSealedWorkflowSource(path: string): Promise<{
  readonly bytes: Buffer;
  readonly stat: BigIntStats;
}> {
  await assertNoWindowsReparseComponents(path);
  const linked = await lstat(path, { bigint: true });
  const canonical = await realpath(path);
  const canonicalStat = await lstat(canonical, { bigint: true });
  if (
    !linked.isFile() ||
    linked.isSymbolicLink() ||
    linked.size > BigInt(MAX_SOURCE_BYTES) ||
    !canonicalStat.isFile() ||
    canonicalStat.isSymbolicLink() ||
    (process.platform === 'win32'
      ? !sameFilesystemObject(linked, canonicalStat)
      : canonical !== path)
  ) {
    throw new Error('Sealed workflow source is unsafe or exceeds its byte limit.');
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameSourceIdentity(linked, opened)) {
      throw new Error('Sealed workflow source changed before it was opened.');
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.length) {
      throw new Error('Sealed workflow source ended unexpectedly.');
    }
    const after = await handle.stat({ bigint: true });
    if (!sameSourceIdentity(opened, after)) {
      throw new Error('Sealed workflow source changed while it was read.');
    }
    return Object.freeze({ bytes, stat: after });
  } finally {
    await handle.close();
  }
}

function absolutePath(value: string | undefined, name: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    throw new WorkflowRunnerWorkerConfigError(`${name} must be a normalized absolute path.`);
  }
  return value;
}

export function loadWorkflowRunnerWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowRunnerWorkerConfig {
  if (environment[WORKFLOW_RUNNER_WORKER_ENABLED_ENV] !== '1') {
    throw new WorkflowRunnerWorkerConfigError(
      'Workflow runner worker is default-off; explicit enablement is required.',
    );
  }
  const workspaceId = environment.OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID;
  const runnerBuildHash = environment.OPENSLACK_WORKFLOW_RUNNER_BUILD_HASH;
  if (!workspaceId || !SAFE_ID.test(workspaceId)) {
    throw new WorkflowRunnerWorkerConfigError('Worker workspace ID is invalid.');
  }
  if (!runnerBuildHash || !HASH.test(runnerBuildHash)) {
    throw new WorkflowRunnerWorkerConfigError('Worker build hash is invalid.');
  }
  return Object.freeze({
    enabled: true,
    workspaceId,
    workspaceRoot: absolutePath(
      environment.OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT,
      'Worker workspace root',
    ),
    descriptorRoot: absolutePath(
      environment.OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT,
      'Worker descriptor root',
    ),
    runnerBuildHash,
  });
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function sourceRoot(
  descriptor: WorkflowRunnerExecutionDescriptor,
  workspaceRoot: string,
): Promise<string> {
  switch (descriptor.workflowSource) {
    case 'openslack-project':
      return join(workspaceRoot, '.openslack', 'workflows');
    case 'claude-project':
      return join(workspaceRoot, '.claude', 'workflows');
    case 'claude-user':
      return join(homedir(), '.claude', 'workflows');
    case 'builtin':
      return join(import.meta.dirname, 'builtins');
  }
}

export function createSealedWorkflowRunnerSourceLoader(
  workspaceRoot: string,
): WorkflowRunnerSourceLoader<PreparedWorkflowSource> {
  return Object.freeze({
    async prepare(descriptor: WorkflowRunnerExecutionDescriptor): Promise<PreparedWorkflowSource> {
      const root = await sourceRoot(descriptor, workspaceRoot);
      await assertNoWindowsReparseComponents(root);
      const rootBefore = await lstat(root, { bigint: true });
      if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
        throw new Error('Sealed workflow catalog root is unsafe.');
      }
      const rootReal = await realpath(root);
      const rootCanonical = await lstat(rootReal, { bigint: true });
      if (
        !rootCanonical.isDirectory() ||
        rootCanonical.isSymbolicLink() ||
        (process.platform === 'win32'
          ? !sameFilesystemObject(rootBefore, rootCanonical)
          : rootReal !== resolve(root))
      ) {
        throw new Error('Sealed workflow catalog root must be canonical and non-symlinked.');
      }
      const entries = new Set(await readdir(root));
      const candidates = SOURCE_EXTENSIONS.filter((extension) =>
        entries.has(`${descriptor.workflowId}${extension}`),
      ).map((extension) => join(rootReal, `${descriptor.workflowId}${extension}`));
      if (candidates.length !== 1) {
        throw new Error('Sealed workflow catalog entry is missing or ambiguous.');
      }
      const path = candidates[0]!;
      const pathBefore = await lstat(path, { bigint: true });
      if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
        throw new Error('Sealed workflow source has an unsafe type.');
      }
      const canonical = await realpath(path);
      const canonicalStat = await lstat(canonical, { bigint: true });
      if (
        !canonicalStat.isFile() ||
        canonicalStat.isSymbolicLink() ||
        (process.platform === 'win32'
          ? !sameFilesystemObject(pathBefore, canonicalStat)
          : canonical !== path) ||
        !within(rootReal, canonical)
      ) {
        throw new Error('Sealed workflow source escapes its catalog root.');
      }
      const source = await readSealedWorkflowSource(canonical);
      const rootAfter = await lstat(root, { bigint: true });
      if (!sameSourceIdentity(rootBefore, rootAfter)) {
        throw new Error('Sealed workflow catalog root changed during validation.');
      }
      if (hashWorkflowRunnerSource(source.bytes) !== descriptor.workflowSourceHash) {
        throw new Error('Sealed workflow source hash does not match the descriptor.');
      }
      // GS8 accepts only a single hash-bound source object. Reject source forms
      // that could load unbound transitive execution bytes before lease_accept.
      // The existing CLI loader is deliberately outside this default-off path.
      assertWorkflowRunnerSourceIsSelfContained(source.bytes);
      return Object.freeze({
        path: canonical,
        bytes: source.bytes,
        identity: sourceIdentity(source.stat),
      });
    },
    async load(
      descriptor: WorkflowRunnerExecutionDescriptor,
      prepared: PreparedWorkflowSource,
    ): Promise<WorkflowModule> {
      // This is the first dynamic import on the worker execution path and the
      // session invokes it only after lease_accept has an advancing receipt.
      const beforeImport = await readSealedWorkflowSource(prepared.path);
      if (
        sourceIdentity(beforeImport.stat) !== prepared.identity ||
        !beforeImport.bytes.equals(prepared.bytes) ||
        hashWorkflowRunnerSource(beforeImport.bytes) !== descriptor.workflowSourceHash
      ) {
        throw new Error('Sealed workflow source changed after lease acceptance.');
      }
      const { loadWorkflow } = await import('./loader.js');
      const workflow = await loadWorkflow(prepared.path, {
        moduleCacheKey: descriptor.workflowSourceHash,
      });
      // Node cannot atomically import through the already verified file handle
      // on every supported platform. Re-verify immediately after import and
      // fail closed if the path or bytes crossed that residual boundary.
      const afterImport = await readSealedWorkflowSource(prepared.path);
      if (
        sourceIdentity(afterImport.stat) !== prepared.identity ||
        !afterImport.bytes.equals(prepared.bytes) ||
        workflow.meta.name !== descriptor.workflowId ||
        (workflow.meta.version ?? '0.0.0') !== descriptor.workflowVersion ||
        hashWorkflowRunnerManifest(workflow.meta) !== descriptor.manifestHash ||
        hashWorkflowRunnerSource(afterImport.bytes) !== descriptor.workflowSourceHash
      ) {
        throw new Error('Loaded workflow identity does not match the sealed descriptor.');
      }
      return workflow;
    },
  });
}

function installProtocolOnlyStreams(): void {
  const suppressedWrite = ((_chunk: unknown, ...rest: unknown[]) => {
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = suppressedWrite;
  process.stderr.write = suppressedWrite as typeof process.stderr.write;
  console.log = (..._values: unknown[]) => undefined;
  console.info = (..._values: unknown[]) => undefined;
  console.debug = (..._values: unknown[]) => undefined;
  console.warn = (..._values: unknown[]) => undefined;
  console.error = (..._values: unknown[]) => undefined;
}

function boundedDiagnostic(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const code =
    error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
      ? (error as Error & { code: string }).code
      : 'WORKFLOW_RUNNER_WORKER_FAILED';
  return `[${String(code).slice(0, 128)}] ${String(name).slice(0, 128)}\n`;
}

/**
 * Dispatch one accepted runner job without ever treating an existing run as a
 * fresh execution. Only paused/resuming runs enter the strict resume path;
 * terminal, running, or incomplete local state fails closed.
 */
export async function executeWorkflowRunnerJob(
  workflow: WorkflowModule,
  descriptor: WorkflowRunnerExecutionDescriptor,
  context: WorkflowRunnerExecutionContext,
  workspaceRoot: string,
): Promise<RunResult> {
  const store = new RunStore({ baseDir: join(workspaceRoot, '.openslack.local', 'workflows') });
  const exists = await store.runExists(descriptor.workflowRunId);
  const status = exists ? await store.loadStatus(descriptor.workflowRunId) : null;
  const { executeResume, executeRun } = await loadWorkflowExecutionAuthority();
  const unattended = descriptor.confirmationPolicy.mode === 'unattended-explicit';
  const common = {
    manifest: workflow.meta,
    args: { ...descriptor.input },
    budget: descriptor.budget,
    runId: descriptor.workflowRunId,
    ...(unattended
      ? { allowUnattended: true as const }
      : { confirmationPolicy: descriptor.confirmationPolicy }),
    signal: context.signal,
    effectBoundary: context.effectBoundary,
    rootDir: workspaceRoot,
  };

  if (!exists) return executeRun(workflow, common);
  if (status === null) {
    throw new WorkflowRunnerRunStateError(
      `Workflow run ${descriptor.workflowRunId} exists without readable status.`,
    );
  }
  if (!['paused', 'paused_waiting_approval', 'resuming'].includes(status.status)) {
    throw new WorkflowRunnerRunStateError(
      `Workflow run ${descriptor.workflowRunId} cannot resume from status "${status.status}".`,
    );
  }
  return executeResume(workflow, common);
}

export async function runWorkflowRunnerWorker(
  config: WorkflowRunnerWorkerConfig = loadWorkflowRunnerWorkerConfig(),
): Promise<void> {
  installProtocolOnlyStreams();
  const descriptorStore = new WorkflowRunnerDescriptorStore(config.descriptorRoot);
  await descriptorStore.initialize();
  let closed = false;
  const timers: { heartbeat?: NodeJS.Timeout; retry?: NodeJS.Timeout } = {};
  const close = async (exitCode: number) => {
    if (closed) return;
    closed = true;
    if (timers.heartbeat) clearInterval(timers.heartbeat);
    if (timers.retry) clearInterval(timers.retry);
    process.stdin.pause();
    process.exitCode = exitCode;
  };
  const sourceLoader = createSealedWorkflowRunnerSourceLoader(config.workspaceRoot);
  const session = new WorkflowRunnerSession<PreparedWorkflowSource>({
    workspaceId: config.workspaceId,
    runnerBuildHash: config.runnerBuildHash,
    runtimeVersion: process.versions.node,
    descriptorStore,
    sourceLoader,
    send: (exactBytes) => {
      writeSync(1, exactBytes, undefined, 'utf8');
    },
    close,
    execute: async (
      workflow: WorkflowModule,
      descriptor: WorkflowRunnerExecutionDescriptor,
      context: WorkflowRunnerExecutionContext,
    ): Promise<RunResult> => {
      return executeWorkflowRunnerJob(workflow, descriptor, context, config.workspaceRoot);
    },
  });

  const fatal = async (error: unknown) => {
    if (closed) return;
    writeSync(2, boundedDiagnostic(error), undefined, 'utf8');
    await close(1);
  };
  const decoder = new WorkflowRunnerJsonlDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) {
        const message = decodeWorkflowRunnerFrame(frame);
        void session.receive(message).catch(fatal);
      }
    } catch (error) {
      void fatal(error);
    }
  });
  process.stdin.on('end', () => {
    try {
      decoder.finish();
      if (!closed) void fatal(new Error('Workflow runner control stream ended unexpectedly.'));
    } catch (error) {
      void fatal(error);
    }
  });
  process.stdin.on('error', fatal);

  await session.start();
  let lastHeartbeat = 0;
  timers.heartbeat = setInterval(() => {
    const interval = session.heartbeatIntervalMs;
    if (interval <= 0 || Date.now() - lastHeartbeat < interval) return;
    lastHeartbeat = Date.now();
    void session.heartbeat().catch(fatal);
  }, 250);
  timers.retry = setInterval(() => {
    void session.retryOutstanding().catch(fatal);
  }, 2_000);
}

async function loadWorkflowExecutionAuthority(): Promise<typeof import('./execute.js')> {
  // Keep executable authority loading behind WorkflowRunnerSession's advancing
  // lease_accept receipt. executeWorkflowRunnerJob is only invoked by the
  // accepted session callback in production; exporting it exists for focused
  // state-routing tests, not as a second worker entrypoint.
  return await import('./execute.js');
}
