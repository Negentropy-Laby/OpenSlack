import { createHash } from 'node:crypto';
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
import { classifyWorkflowRunnerRunState } from './workflow-runner-run-state.js';
import {
  createWorkflowCheckpointObservationPort,
  createWorkflowCheckpointShadowHttpPublisher,
  type WorkflowCheckpointShadowDiagnostic,
  type WorkflowCheckpointObservationPort,
} from './workflow-checkpoint-shadow.js';
import { createWorkflowEffectAuthorizationPort } from './workflow-effect-authorization.js';
import { WORKFLOW_EFFECT_CONTROL_ROUTE } from './workflow-effect-control-contract.js';
import {
  createWorkflowEffectShadowHttpPublisher,
  createWorkflowEffectShadowObservationPort,
  type WorkflowEffectShadowDiagnostic,
  type WorkflowEffectShadowObservationPort,
} from './workflow-effect-shadow.js';
import type { WorkflowControlObservationPort } from './workflow-control-shadow.js';
import { workflowEffectLeaseAuthorityFromBoundary } from './internal/workflow-effect-lease-authority.js';
import { validateWorkflowLocalShadowConfig } from './internal/workflow-local-shadow-config.js';
import type {
  ProviderAttemptPort,
  ProviderAttemptReservation,
  ProviderAttemptReserveInput,
  ProviderUsageReceipt,
} from '@openslack/agent-runtime';
import { workflowBudgetAuthorityChargeNanoUsd } from './workflow-budget-authority-contract.js';
import {
  decodeWorkflowRunnerV2Frame,
  WorkflowRunnerV2JsonlDecoder,
} from './workflow-runner-v2-framing.js';
import {
  hashWorkflowRunnerV2Manifest,
  hashWorkflowRunnerV2Source,
  WORKFLOW_RUNNER_V2_DESCRIPTOR_CODEC,
  type WorkflowRunnerV2ExecutionDescriptor,
} from './workflow-runner-v2-descriptor.js';
import {
  WorkflowRunnerV2Session,
  WorkflowRunnerV2SessionError,
  type WorkflowRunnerV2ExecutionContext,
  type WorkflowRunnerV2SourceLoader,
} from './workflow-runner-v2-session.js';

export const WORKFLOW_RUNNER_WORKER_ENABLED_ENV = 'OPENSLACK_WORKFLOW_RUNNER_ENABLED' as const;
export const WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED_ENV =
  'OPENSLACK_WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED' as const;

export interface WorkflowRunnerWorkerConfig {
  readonly enabled: true;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly descriptorRoot: string;
  readonly runnerBuildHash: string;
  readonly checkpointShadow?: {
    readonly endpoint: string;
    readonly bearerToken: string;
    readonly callerId: string;
    readonly journalRoot: string;
  };
  readonly effectShadow?: {
    readonly endpoint: string;
    readonly bearerToken: string;
    readonly callerId: string;
    readonly journalRoot: string;
  };
}

export interface WorkflowRunnerV2QualificationWorkerConfig {
  readonly enabled: true;
  readonly qualificationOnly: true;
  readonly runtimeBoundaryMode: 'provider-attempt-only';
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

export class WorkflowRunnerV2RuntimeBoundaryUnavailableError extends Error {
  readonly code = 'WORKFLOW_RUNNER_V2_RUNTIME_BOUNDARY_UNAVAILABLE' as const;

  constructor(boundary: 'resume' | 'checkpoint' | 'effect') {
    super(`Workflow runner v2 ${boundary} delivery remains unavailable in GS9-F1.`);
    this.name = 'WorkflowRunnerV2RuntimeBoundaryUnavailableError';
  }
}

export { WorkflowRunnerRunStateError } from './workflow-runner-run-state.js';

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
  const workspaceRoot = absolutePath(
    environment.OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT,
    'Worker workspace root',
  );
  const checkpointKeys = [
    'OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENDPOINT',
    'OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_BEARER_TOKEN',
    'OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CALLER_ID',
    'OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT',
  ] as const;
  const enabledValue = environment.OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENABLED;
  if (enabledValue !== undefined && enabledValue !== '0' && enabledValue !== '1') {
    throw new WorkflowRunnerWorkerConfigError('Workflow checkpoint shadow enablement is invalid.');
  }
  const checkpointEnabled = enabledValue === '1';
  if (!checkpointEnabled && checkpointKeys.some((key) => environment[key] !== undefined)) {
    throw new WorkflowRunnerWorkerConfigError(
      'Disabled Workflow checkpoint shadow configuration must be empty.',
    );
  }
  const checkpointShadow = checkpointEnabled
    ? {
        endpoint: environment.OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENDPOINT ?? '',
        bearerToken: environment.OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_BEARER_TOKEN ?? '',
        callerId: environment.OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CALLER_ID ?? '',
        journalRoot: absolutePath(
          environment.OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT,
          'Workflow checkpoint shadow journal root',
        ),
      }
    : undefined;
  if (
    checkpointEnabled &&
    (!checkpointShadow?.endpoint ||
      checkpointShadow.bearerToken.length < 32 ||
      !SAFE_ID.test(checkpointShadow.callerId))
  ) {
    throw new WorkflowRunnerWorkerConfigError(
      'Workflow checkpoint shadow configuration is invalid.',
    );
  }
  if (checkpointShadow) {
    try {
      validateWorkflowLocalShadowConfig({
        workspaceRoot,
        journalRoot: checkpointShadow.journalRoot,
        endpoint: checkpointShadow.endpoint,
        routes: ['/', '/v1/shadow/workflow-control/checkpoints'],
      });
    } catch {
      throw new WorkflowRunnerWorkerConfigError(
        'Workflow checkpoint shadow must use loopback and a workspace-local journal.',
      );
    }
  }
  const effectKeys = [
    'OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENDPOINT',
    'OPENSLACK_WORKFLOW_EFFECT_SHADOW_BEARER_TOKEN',
    'OPENSLACK_WORKFLOW_EFFECT_SHADOW_CALLER_ID',
    'OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT',
  ] as const;
  const effectEnabledValue = environment.OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENABLED;
  if (
    effectEnabledValue !== undefined &&
    effectEnabledValue !== '0' &&
    effectEnabledValue !== '1'
  ) {
    throw new WorkflowRunnerWorkerConfigError('Workflow effect shadow enablement is invalid.');
  }
  const effectEnabled = effectEnabledValue === '1';
  if (!effectEnabled && effectKeys.some((key) => environment[key] !== undefined)) {
    throw new WorkflowRunnerWorkerConfigError(
      'Disabled Workflow effect shadow configuration must be empty.',
    );
  }
  const effectShadow = effectEnabled
    ? {
        endpoint: environment.OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENDPOINT ?? '',
        bearerToken: environment.OPENSLACK_WORKFLOW_EFFECT_SHADOW_BEARER_TOKEN ?? '',
        callerId: environment.OPENSLACK_WORKFLOW_EFFECT_SHADOW_CALLER_ID ?? '',
        journalRoot: absolutePath(
          environment.OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT,
          'Workflow effect shadow journal root',
        ),
      }
    : undefined;
  if (
    effectEnabled &&
    (!effectShadow?.endpoint ||
      effectShadow.bearerToken.length < 32 ||
      !SAFE_ID.test(effectShadow.callerId))
  ) {
    throw new WorkflowRunnerWorkerConfigError('Workflow effect shadow configuration is invalid.');
  }
  if (effectShadow) {
    try {
      validateWorkflowLocalShadowConfig({
        workspaceRoot,
        journalRoot: effectShadow.journalRoot,
        endpoint: effectShadow.endpoint,
        routes: [WORKFLOW_EFFECT_CONTROL_ROUTE],
        protectedRelativeRoots: [
          join('workflows', 'effect-approvals'),
          join('workflows', 'effect-authority'),
        ],
      });
    } catch {
      throw new WorkflowRunnerWorkerConfigError(
        'Workflow effect shadow must use its exact loopback route and a workspace-local journal.',
      );
    }
  }
  return Object.freeze({
    enabled: true,
    workspaceId,
    workspaceRoot,
    descriptorRoot: absolutePath(
      environment.OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT,
      'Worker descriptor root',
    ),
    runnerBuildHash,
    ...(checkpointShadow ? { checkpointShadow: Object.freeze(checkpointShadow) } : {}),
    ...(effectShadow ? { effectShadow: Object.freeze(effectShadow) } : {}),
  });
}

export function loadWorkflowRunnerV2QualificationWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowRunnerV2QualificationWorkerConfig {
  if (environment[WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED_ENV] !== '1') {
    throw new WorkflowRunnerWorkerConfigError(
      'Workflow runner v2 qualification is default-off; explicit enablement is required.',
    );
  }
  if (environment[WORKFLOW_RUNNER_WORKER_ENABLED_ENV] === '1') {
    throw new WorkflowRunnerWorkerConfigError(
      'Workflow runner v1 and v2 qualification modes cannot be enabled together.',
    );
  }
  const unavailableBoundaryKeys = [
    'OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENABLED',
    'OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENDPOINT',
    'OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_BEARER_TOKEN',
    'OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CALLER_ID',
    'OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT',
    'OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENABLED',
    'OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENDPOINT',
    'OPENSLACK_WORKFLOW_EFFECT_SHADOW_BEARER_TOKEN',
    'OPENSLACK_WORKFLOW_EFFECT_SHADOW_CALLER_ID',
    'OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT',
  ] as const;
  if (unavailableBoundaryKeys.some((key) => environment[key] !== undefined)) {
    throw new WorkflowRunnerWorkerConfigError(
      'Workflow runner v2 GS9-F1 cannot configure checkpoint or effect authority boundaries.',
    );
  }
  const workspaceId = environment.OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID;
  const runnerBuildHash = environment.OPENSLACK_WORKFLOW_RUNNER_BUILD_HASH;
  if (!workspaceId || !SAFE_ID.test(workspaceId)) {
    throw new WorkflowRunnerWorkerConfigError('V2 qualification workspace ID is invalid.');
  }
  if (!runnerBuildHash || !HASH.test(runnerBuildHash)) {
    throw new WorkflowRunnerWorkerConfigError('V2 qualification runner build hash is invalid.');
  }
  return Object.freeze({
    enabled: true,
    qualificationOnly: true,
    runtimeBoundaryMode: 'provider-attempt-only',
    workspaceId,
    workspaceRoot: absolutePath(
      environment.OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT,
      'V2 qualification workspace root',
    ),
    descriptorRoot: absolutePath(
      environment.OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT,
      'V2 qualification descriptor root',
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
      // Project and user catalogs accept only one hash-bound source object.
      // Builtins are reviewed code inside the sealed runner distribution: the
      // exact catalog source hash binds the requested entry while the runner
      // build hash binds its transitive product-code dependencies.
      if (descriptor.workflowSource !== 'builtin') {
        assertWorkflowRunnerSourceIsSelfContained(source.bytes);
      }
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

export function createSealedWorkflowRunnerV2SourceLoader(
  workspaceRoot: string,
): WorkflowRunnerV2SourceLoader<PreparedWorkflowSource, WorkflowModule> {
  return Object.freeze({
    async prepare(
      descriptor: WorkflowRunnerV2ExecutionDescriptor,
    ): Promise<PreparedWorkflowSource> {
      if (descriptor.resumeGeneration !== 0) {
        throw new WorkflowRunnerV2RuntimeBoundaryUnavailableError('resume');
      }
      const root = await sourceRoot(
        descriptor as unknown as WorkflowRunnerExecutionDescriptor,
        workspaceRoot,
      );
      await assertNoWindowsReparseComponents(root);
      const rootBefore = await lstat(root, { bigint: true });
      if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
        throw new Error('Sealed v2 workflow catalog root is unsafe.');
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
        throw new Error('Sealed v2 workflow catalog root must be canonical and non-symlinked.');
      }
      const entries = new Set(await readdir(root));
      const candidates = SOURCE_EXTENSIONS.filter((extension) =>
        entries.has(`${descriptor.workflowId}${extension}`),
      ).map((extension) => join(rootReal, `${descriptor.workflowId}${extension}`));
      if (candidates.length !== 1) {
        throw new Error('Sealed v2 workflow catalog entry is missing or ambiguous.');
      }
      const path = candidates[0]!;
      const pathBefore = await lstat(path, { bigint: true });
      if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
        throw new Error('Sealed v2 workflow source has an unsafe type.');
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
        throw new Error('Sealed v2 workflow source escapes its catalog root.');
      }
      const source = await readSealedWorkflowSource(canonical);
      const rootAfter = await lstat(root, { bigint: true });
      if (!sameSourceIdentity(rootBefore, rootAfter)) {
        throw new Error('Sealed v2 workflow catalog root changed during validation.');
      }
      if (hashWorkflowRunnerV2Source(source.bytes) !== descriptor.workflowSourceHash) {
        throw new Error('Sealed v2 workflow source hash does not match the descriptor.');
      }
      if (descriptor.workflowSource !== 'builtin') {
        assertWorkflowRunnerSourceIsSelfContained(source.bytes);
      }
      return Object.freeze({
        path: canonical,
        bytes: source.bytes,
        identity: sourceIdentity(source.stat),
      });
    },
    async load(
      prepared: PreparedWorkflowSource,
      descriptor: WorkflowRunnerV2ExecutionDescriptor,
    ): Promise<WorkflowModule> {
      const beforeImport = await readSealedWorkflowSource(prepared.path);
      if (
        sourceIdentity(beforeImport.stat) !== prepared.identity ||
        !beforeImport.bytes.equals(prepared.bytes) ||
        hashWorkflowRunnerV2Source(beforeImport.bytes) !== descriptor.workflowSourceHash
      ) {
        throw new Error('Sealed v2 workflow source changed after lease acceptance.');
      }
      const { loadWorkflow } = await import('./loader.js');
      const workflow = await loadWorkflow(prepared.path, {
        moduleCacheKey: descriptor.workflowSourceHash,
      });
      const afterImport = await readSealedWorkflowSource(prepared.path);
      if (
        sourceIdentity(afterImport.stat) !== prepared.identity ||
        !afterImport.bytes.equals(prepared.bytes) ||
        workflow.meta.name !== descriptor.workflowId ||
        (workflow.meta.version ?? '0.0.0') !== descriptor.workflowVersion ||
        hashWorkflowRunnerV2Manifest(workflow.meta) !== descriptor.manifestHash ||
        hashWorkflowRunnerV2Source(afterImport.bytes) !== descriptor.workflowSourceHash
      ) {
        throw new Error('Loaded v2 workflow identity does not match the sealed descriptor.');
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

function writeCheckpointDiagnostic(diagnostic: WorkflowCheckpointShadowDiagnostic): void {
  writeSync(
    2,
    `${JSON.stringify({ schema: 'openslack.workflow_checkpoint_shadow_diagnostic.v1', ...diagnostic })}\n`,
    undefined,
    'utf8',
  );
}

function writeEffectShadowDiagnostic(diagnostic: WorkflowEffectShadowDiagnostic): void {
  writeSync(
    2,
    `${JSON.stringify({ schema: 'openslack.workflow_effect_shadow_diagnostic.v1', ...diagnostic })}\n`,
    undefined,
    'utf8',
  );
}

/**
 * Dispatch one accepted runner job without ever treating an existing run as a
 * fresh execution. Only paused/resuming runs enter the strict resume path;
 * terminal, running, or incomplete local state fails closed.
 */
async function executeWorkflowRunnerJob(
  workflow: WorkflowModule,
  descriptor: WorkflowRunnerExecutionDescriptor,
  context: WorkflowRunnerExecutionContext,
  workspaceRoot: string,
  checkpointObservationPort?: WorkflowCheckpointObservationPort,
  observationPort?: WorkflowControlObservationPort,
  effectShadowObservationPort?: WorkflowEffectShadowObservationPort,
): Promise<RunResult> {
  const store = new RunStore({
    baseDir: join(workspaceRoot, '.openslack.local', 'workflows'),
    observationPort,
    checkpointObservationPort,
  });
  const exists = await store.runExists(descriptor.workflowRunId);
  const status = exists ? await store.loadStatus(descriptor.workflowRunId) : null;
  const disposition = classifyWorkflowRunnerRunState(
    descriptor.workflowRunId,
    exists,
    status?.status ?? null,
  );
  const { executeResumeWithStore, executeRunWithStore } = await loadWorkflowExecutionAuthority();
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
  const effectAuthorizationPort = createWorkflowEffectAuthorizationPort({
    workspaceRoot,
    effectBoundary: context.effectBoundary,
    leaseAuthority: workflowEffectLeaseAuthorityFromBoundary(context.effectBoundary),
    observationPort,
    effectShadowObservationPort,
  });

  return disposition === 'initialize'
    ? executeRunWithStore(
        workflow,
        common,
        store,
        context.checkpointAuthority,
        effectAuthorizationPort,
      )
    : executeResumeWithStore(
        workflow,
        common,
        store,
        context.checkpointAuthority,
        effectAuthorizationPort,
      );
}

export async function runWorkflowRunnerWorker(
  config: WorkflowRunnerWorkerConfig = loadWorkflowRunnerWorkerConfig(),
  checkpointObservationPort?: WorkflowCheckpointObservationPort,
  observationPort?: WorkflowControlObservationPort,
  effectShadowObservationPort?: WorkflowEffectShadowObservationPort,
): Promise<void> {
  installProtocolOnlyStreams();
  const effectiveCheckpointObservationPort =
    checkpointObservationPort ??
    (config.checkpointShadow
      ? await createWorkflowCheckpointObservationPort({
          enabled: true,
          journalRoot: config.checkpointShadow.journalRoot,
          publisher: createWorkflowCheckpointShadowHttpPublisher({
            endpoint: config.checkpointShadow.endpoint,
            bearerToken: config.checkpointShadow.bearerToken,
            callerId: config.checkpointShadow.callerId,
          }),
          diagnosticSink: writeCheckpointDiagnostic,
        })
      : undefined);
  let effectiveEffectShadowObservationPort = effectShadowObservationPort;
  if (!effectiveEffectShadowObservationPort && config.effectShadow) {
    try {
      effectiveEffectShadowObservationPort = await createWorkflowEffectShadowObservationPort({
        enabled: true,
        workspaceRoot: config.workspaceRoot,
        journalRoot: config.effectShadow.journalRoot,
        publisher: createWorkflowEffectShadowHttpPublisher({
          endpoint: config.effectShadow.endpoint,
          bearerToken: config.effectShadow.bearerToken,
          callerId: config.effectShadow.callerId,
        }),
        diagnosticSink: writeEffectShadowDiagnostic,
      });
    } catch (error) {
      writeEffectShadowDiagnostic({
        outcome: 'failed',
        runIdHash: 'unavailable',
        approvalIdHash: 'unavailable',
        observationHash: null,
        code:
          error &&
          typeof error === 'object' &&
          typeof (error as { readonly code?: unknown }).code === 'string'
            ? String((error as { readonly code: string }).code).slice(0, 128)
            : 'WORKFLOW_EFFECT_SHADOW_INITIALIZATION_FAILED',
      });
    }
  }
  if (effectiveEffectShadowObservationPort) {
    void (async () => {
      await effectiveEffectShadowObservationPort.replay();
      await effectiveEffectShadowObservationPort.synchronize();
    })().catch((error) => {
      writeEffectShadowDiagnostic({
        outcome: 'failed',
        runIdHash: 'unavailable',
        approvalIdHash: 'unavailable',
        observationHash: null,
        code:
          error &&
          typeof error === 'object' &&
          typeof (error as { readonly code?: unknown }).code === 'string'
            ? String((error as { readonly code: string }).code).slice(0, 128)
            : 'WORKFLOW_EFFECT_SHADOW_REPLAY_FAILED',
      });
    });
  }
  const descriptorStore = new WorkflowRunnerDescriptorStore(config.descriptorRoot);
  await descriptorStore.initialize();
  let closed = false;
  const timers: {
    heartbeat?: NodeJS.Timeout;
    retry?: NodeJS.Timeout;
    effectShadowSync?: NodeJS.Timeout;
  } = {};
  const close = async (exitCode: number) => {
    if (closed) return;
    closed = true;
    if (timers.heartbeat) clearInterval(timers.heartbeat);
    if (timers.retry) clearInterval(timers.retry);
    if (timers.effectShadowSync) clearInterval(timers.effectShadowSync);
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
      return executeWorkflowRunnerJob(
        workflow,
        descriptor,
        context,
        config.workspaceRoot,
        effectiveCheckpointObservationPort,
        observationPort,
        effectiveEffectShadowObservationPort,
      );
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
  let heartbeatInFlight: Promise<void> | undefined;
  timers.heartbeat = setInterval(() => {
    const interval = session.heartbeatIntervalMs;
    if (interval <= 0 || heartbeatInFlight || Date.now() - lastHeartbeat < interval) return;
    heartbeatInFlight = session
      .heartbeat()
      .then((sent) => {
        if (sent) lastHeartbeat = Date.now();
      })
      .catch(fatal)
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, 250);
  timers.retry = setInterval(() => {
    void session.retryOutstanding().catch(fatal);
  }, 2_000);
  if (effectiveEffectShadowObservationPort) {
    let synchronizationInFlight: Promise<void> | undefined;
    timers.effectShadowSync = setInterval(() => {
      if (synchronizationInFlight) return;
      synchronizationInFlight = effectiveEffectShadowObservationPort!
        .synchronize()
        .catch((error) => {
          writeEffectShadowDiagnostic({
            outcome: 'failed',
            runIdHash: 'unavailable',
            approvalIdHash: 'unavailable',
            observationHash: null,
            code:
              error &&
              typeof error === 'object' &&
              typeof (error as { readonly code?: unknown }).code === 'string'
                ? String((error as { readonly code: string }).code).slice(0, 128)
                : 'WORKFLOW_EFFECT_SHADOW_SYNCHRONIZATION_FAILED',
          });
        })
        .finally(() => {
          synchronizationInFlight = undefined;
        });
    }, 2_000);
  }
}

class WorkflowRunnerV2BudgetBoundaryError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_V2_BUDGET_REJECTED'
      | 'WORKFLOW_RUNNER_V2_BUDGET_AUTHORIZATION_MISMATCH'
      | 'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowRunnerV2BudgetBoundaryError';
  }
}

function createWorkflowRunnerV2ProviderAttemptPort(
  descriptor: WorkflowRunnerV2ExecutionDescriptor,
  context: WorkflowRunnerV2ExecutionContext,
): ProviderAttemptPort {
  const reservations = new Map<
    string,
    {
      readonly reservation: ProviderAttemptReservation;
      readonly providerAttempt: string;
      readonly requestedTokens: string;
    }
  >();
  // F1 proves only reserve-before-fetch and settle-after-usage ordering. The
  // frozen request does not carry expected provider/model/provider-run hashes,
  // so this seam deliberately makes no E1 identity-propagation or budget-
  // authority claim.
  return Object.freeze({
    async reserve(input: ProviderAttemptReserveInput) {
      const identity = createHash('sha256')
        .update(
          [descriptor.workflowRunId, input.providerRunId, input.providerAttempt].join('\0'),
          'utf8',
        )
        .digest('hex')
        .slice(0, 32);
      const reservationId = `reservation-${identity}`;
      const callId = `call-${identity}`;
      const decision = await context.reserveBudget({
        reservationId,
        callId,
        policyHash: descriptor.budgetPolicy.policyHash,
        requestedTokens: input.requestedTokens,
        requestedCostNanoUsd: workflowBudgetAuthorityChargeNanoUsd(
          input.requestedTokens,
          descriptor.budgetPolicy.rateNanoUsdPerToken,
        ),
        requestedCalls: '1',
      });
      const payload = decision.payload;
      if (payload.status === 'reconciliation_required') {
        throw new WorkflowRunnerV2BudgetBoundaryError(
          'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
          'Budget reserve outcome requires reconciliation.',
        );
      }
      if (payload.status !== 'reserved') {
        throw new WorkflowRunnerV2BudgetBoundaryError(
          'WORKFLOW_RUNNER_V2_BUDGET_REJECTED',
          'Budget authority rejected the provider attempt.',
        );
      }
      if (
        payload.reservationId !== reservationId ||
        typeof payload.authorizedTokens !== 'string' ||
        !/^(?:0|[1-9][0-9]*)$/u.test(payload.authorizedTokens) ||
        BigInt(payload.authorizedTokens) < 1n ||
        BigInt(payload.authorizedTokens) > BigInt(input.requestedTokens) ||
        payload.authorizedCalls !== '1'
      ) {
        throw new WorkflowRunnerV2BudgetBoundaryError(
          'WORKFLOW_RUNNER_V2_BUDGET_AUTHORIZATION_MISMATCH',
          'Budget authorization does not bind the requested provider attempt.',
        );
      }
      const reservation = Object.freeze({
        reservationId,
        callId,
        authorizedTokens: payload.authorizedTokens,
      });
      reservations.set(reservationId, {
        reservation,
        providerAttempt: input.providerAttempt,
        requestedTokens: input.requestedTokens,
      });
      return reservation;
    },
    async settle(reservation: ProviderAttemptReservation, usage: ProviderUsageReceipt) {
      const opened = reservations.get(reservation.reservationId);
      if (
        !opened ||
        opened.reservation !== reservation ||
        reservation.callId !== opened.reservation.callId ||
        usage.attempt !== opened.providerAttempt
      ) {
        throw new WorkflowRunnerV2BudgetBoundaryError(
          'WORKFLOW_RUNNER_V2_BUDGET_AUTHORIZATION_MISMATCH',
          'Provider usage does not bind an open budget reservation.',
        );
      }
      const totalTokens = usage.status === 'reported' ? usage.totalTokens : null;
      const receiptHash = usage.receiptHash.startsWith('sha256:')
        ? usage.receiptHash.slice('sha256:'.length)
        : usage.receiptHash;
      if (!HASH.test(receiptHash)) {
        throw new WorkflowRunnerV2BudgetBoundaryError(
          'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
          'Provider usage receipt hash is invalid.',
        );
      }
      const settled = totalTokens !== null && BigInt(totalTokens) <= BigInt(opened.requestedTokens);
      await context.reportBudgetUsage({
        reservationId: reservation.reservationId,
        callId: reservation.callId,
        providerReceiptHash: receiptHash,
        actualTokens: totalTokens ?? '0',
        actualCostNanoUsd:
          totalTokens === null
            ? '0'
            : workflowBudgetAuthorityChargeNanoUsd(
                totalTokens,
                descriptor.budgetPolicy.rateNanoUsdPerToken,
              ),
        actualCalls: '1',
        settlementStatus: settled ? 'settled' : 'reconciliation_required',
      });
      reservations.delete(reservation.reservationId);
      if (!settled) {
        throw new WorkflowRunnerV2BudgetBoundaryError(
          'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
          'Provider usage is missing, unreported, or exceeded its reservation.',
        );
      }
    },
  });
}

async function executeWorkflowRunnerV2QualificationJob(
  workflow: WorkflowModule,
  descriptor: WorkflowRunnerV2ExecutionDescriptor,
  context: WorkflowRunnerV2ExecutionContext,
  workspaceRoot: string,
): Promise<RunResult> {
  const store = new RunStore({
    baseDir: join(workspaceRoot, '.openslack.local', 'workflows'),
  });
  const exists = await store.runExists(descriptor.workflowRunId);
  const status = exists ? await store.loadStatus(descriptor.workflowRunId) : null;
  const disposition = classifyWorkflowRunnerRunState(
    descriptor.workflowRunId,
    exists,
    status?.status ?? null,
  );
  if (disposition === 'resume') {
    throw new WorkflowRunnerV2RuntimeBoundaryUnavailableError('resume');
  }
  const { executeRunWithStore } = await loadWorkflowExecutionAuthority();
  const tokenLimit = Number(descriptor.budgetPolicy.tokenLimit);
  const costLimitNanoUsd = BigInt(descriptor.budgetPolicy.costLimitNanoUsd);
  const costUsd = Number(costLimitNanoUsd) / 1_000_000_000;
  const unattended = descriptor.confirmationPolicy.mode === 'unattended-explicit';
  const common = {
    manifest: workflow.meta,
    args: { ...descriptor.input },
    budget: { tokens: tokenLimit, costUsd },
    runId: descriptor.workflowRunId,
    ...(unattended
      ? { allowUnattended: true as const }
      : { confirmationPolicy: descriptor.confirmationPolicy }),
    signal: context.signal,
    rootDir: workspaceRoot,
    agentLauncher: await (async () => {
      const { createOpenSlackAgentLauncher, createRunStore } =
        await import('@openslack/agent-runtime');
      return createOpenSlackAgentLauncher({
        runStore: createRunStore(workspaceRoot),
        rootDir: workspaceRoot,
        openAICompatible: {
          rootDir: workspaceRoot,
          providerAttemptPort: createWorkflowRunnerV2ProviderAttemptPort(descriptor, context),
        },
      });
    })(),
  };
  // GS9-F1 is qualification-only and deliberately wires only the provider
  // attempt reserve/settle seam. It does not claim provider-budget delivery or
  // authority. No checkpoint authority, effect boundary, or effect
  // authorization port is passed here: ctx.checkpoint therefore stays absent
  // and every real effect fails closed with the existing authorization-required
  // error. Durable checkpoint/effect adapters remain explicit GS9-F2 work.
  return executeRunWithStore(workflow, common, store);
}

export async function runWorkflowRunnerV2QualificationWorker(
  config: WorkflowRunnerV2QualificationWorkerConfig = loadWorkflowRunnerV2QualificationWorkerConfig(),
): Promise<void> {
  installProtocolOnlyStreams();
  const descriptorStore = new WorkflowRunnerDescriptorStore<WorkflowRunnerV2ExecutionDescriptor>(
    config.descriptorRoot,
    undefined,
    WORKFLOW_RUNNER_V2_DESCRIPTOR_CODEC,
  );
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
  const session = new WorkflowRunnerV2Session<PreparedWorkflowSource, WorkflowModule>({
    workspaceId: config.workspaceId,
    runnerBuildHash: config.runnerBuildHash,
    runtimeVersion: process.versions.node,
    descriptorStore,
    sourceLoader: createSealedWorkflowRunnerV2SourceLoader(config.workspaceRoot),
    send: (exactBytes) => {
      writeSync(1, exactBytes, undefined, 'utf8');
    },
    close,
    execute: (workflow, descriptor, context) =>
      executeWorkflowRunnerV2QualificationJob(workflow, descriptor, context, config.workspaceRoot),
  });
  const fatal = async (error: unknown) => {
    if (closed) return;
    writeSync(2, boundedDiagnostic(error), undefined, 'utf8');
    await close(1);
  };
  const decoder = new WorkflowRunnerV2JsonlDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) {
        const message = decodeWorkflowRunnerV2Frame(frame);
        void session.receive(message).catch(fatal);
      }
    } catch (error) {
      void fatal(error);
    }
  });
  process.stdin.on('end', () => {
    try {
      decoder.finish();
      if (!closed) void fatal(new Error('Workflow runner v2 control stream ended unexpectedly.'));
    } catch (error) {
      void fatal(error);
    }
  });
  process.stdin.on('error', fatal);
  await session.start();
  let lastHeartbeat = 0;
  let heartbeatInFlight: Promise<void> | undefined;
  timers.heartbeat = setInterval(() => {
    const interval = session.heartbeatIntervalMs ?? 0;
    if (interval <= 0 || heartbeatInFlight || Date.now() - lastHeartbeat < interval) return;
    heartbeatInFlight = session
      .heartbeat()
      .then((sent) => {
        if (sent) lastHeartbeat = Date.now();
      })
      .catch(fatal)
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, 250);
  timers.retry = setInterval(() => {
    void session.retryOutstanding().catch(fatal);
  }, 2_000);
}

async function loadWorkflowExecutionAuthority(): Promise<typeof import('./execute.js')> {
  // Keep executable authority loading behind WorkflowRunnerSession's advancing
  // lease_accept receipt. The executor is module-private and is only invoked by
  // the accepted session callback; pure status classification is tested apart
  // from execution authority.
  return await import('./execute.js');
}
