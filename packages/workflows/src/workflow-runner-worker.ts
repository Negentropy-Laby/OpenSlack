import {
  checkpointEvidence,
  resumeEvidence,
} from './internal/workflow-runner-checkpoint-evidence.js';
import { createHash } from 'node:crypto';
import { constants as fsConstants, writeSync, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { WorkflowRunnerDescriptorStore } from './workflow-runner-descriptor-store.js';
import { assertWorkflowRunnerSourceIsSelfContained } from './workflow-runner-source-policy.js';
import type { RunResult, WorkflowMeta, WorkflowModule } from './types.js';
import type { RunStore } from './run-store.js';
import { WorkflowRunnerResumeSourceStore } from './internal/workflow-runner-resume-source.js';
import { resolveWorkflowRunProjectionRoot } from './workflow-run-projection.js';
import { isWorkflowControlBearerToken } from './workflow-control-routing-identity.js';
import {
  workflowCheckpointBytesHash,
  workflowCheckpointHash,
  type WorkflowCheckpointControlState,
} from './workflow-checkpoint-shadow-contract.js';
import { classifyWorkflowRunnerRunState } from './workflow-runner-run-state.js';
import { loadWorkflowFile } from './internal/workflow-file-loader.js';
import type {
  ProviderAttemptPort,
  ProviderAttemptReservation,
  ProviderAttemptReserveInput,
  ProviderUsageReceipt,
} from '@openslack/agent-runtime';
import { buildProviderUsageIdentityHashes } from '@openslack/agent-runtime';
import {
  WORKFLOW_BUDGET_AUTHORITY,
  WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION,
  WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM,
  WORKFLOW_BUDGET_AUTHORITY_GO_ROLE,
  WORKFLOW_BUDGET_AUTHORITY_WRITER,
  WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA,
  WORKFLOW_BUDGET_RESERVE_REQUEST_SCHEMA,
  WORKFLOW_BUDGET_SETTLEMENT_REQUEST_SCHEMA,
  hashWorkflowBudgetAuthorityValue,
  parseWorkflowBudgetAuthorityBytes,
  prepareWorkflowBudgetAuthorityRequest,
  workflowBudgetAuthorityChargeNanoUsd,
  type WorkflowBudgetReserveDecision,
  type WorkflowBudgetReserveRequest,
  type WorkflowBudgetSettlementRequest,
} from './workflow-budget-authority-contract.js';
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
  workflowRunnerV2BudgetDecisionMatchesRequest,
  type WorkflowRunnerV2ExecutionContext,
  type WorkflowRunnerV2RuntimeDeliveryPort,
  type WorkflowRunnerV2SourceLoader,
} from './workflow-runner-v2-session.js';
import { createWorkflowRunnerAuthorityBindingClient } from './workflow-runner-authority-binding-client.js';
import { WorkflowRunnerAuthorityBindingJournal } from './workflow-runner-authority-binding-journal.js';
import { WorkflowRunnerAuthorityBindingRuntime } from './workflow-runner-authority-binding-runtime.js';
import {
  createWorkflowRunnerCheckpointSourceAdapter,
  createWorkflowRunnerPreparedBudgetSourceAdapter,
  createWorkflowRunnerResumeSourceAdapter,
  WorkflowRunnerV2AuthoritySources,
  type WorkflowRunnerV2AuthoritySourceFactories,
} from './workflow-runner-runtime-authorities.js';
import { WorkflowRunnerV2RuntimeDelivery } from './workflow-runner-v2-runtime-delivery.js';
import { createWorkflowRunnerV2RuntimeAdmissionClient } from './workflow-runner-v2-runtime-admission.js';
import { createWorkflowRunnerV2EffectAuthorizationPort } from './workflow-runner-v2-effect-authorization.js';
import { WorkflowRunnerV2GoProjectionRunStore } from './workflow-runner-v2-go-projection-store.js';
import {
  WorkflowControlAuthorityHttpClient,
  type WorkflowControlAuthorityPort,
  type WorkflowControlResumeAuthorityPort,
  type WorkflowControlAuthorityRunRead,
} from './workflow-control-authority-client.js';
import {
  createWorkflowRunnerBudgetAuthorityClient,
  type WorkflowRunnerBudgetAuthorityClient,
} from './workflow-runner-budget-authority-client.js';
import { canonicalWorkflowControlAuthorityJson } from './workflow-control-authority-contract.js';
import { exactWorkflowRunnerLoopbackOrigin } from './workflow-runner-control-http.js';
import type { WorkflowControlAuthorityMessage } from './workflow-control-authority-contract.js';
import type {} from './workflow-runner-authority-binding-contract.js';

export const WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ENABLED_ENV =
  'WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ENABLED' as const;
export const WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ENABLED_ENV =
  'OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ENABLED' as const;

export interface WorkflowRunnerV2WorkerConfig {
  readonly enabled: true;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly descriptorRoot: string;
  readonly runnerBuildHash: string;
  readonly runtimeDelivery: {
    readonly companionOrigin: string;
    readonly companionBearerToken: string;
    readonly journalRoot: string;
    readonly budgetOrigin: string;
    readonly budgetBearerToken: string;
    readonly budgetCallerId: string;
  };
  readonly runAuthority: {
    readonly origin: string;
    readonly bearerToken: string;
    readonly callerId: string;
    readonly expectedBuildHash: string;
  };
}

export class WorkflowRunnerWorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunnerWorkerConfigError';
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

function loopbackOrigin(value: string | undefined, name: string): string {
  return exactWorkflowRunnerLoopbackOrigin(
    value ?? '',
    (message) => {
      throw new WorkflowRunnerWorkerConfigError(message);
    },
    {
      invalid: `${name} must be an exact loopback HTTP origin.`,
      nonLoopback: `${name} must be an exact loopback HTTP origin.`,
    },
  );
}

export function loadWorkflowRunnerV2WorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowRunnerV2WorkerConfig {
  if (environment[WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ENABLED_ENV] !== '1') {
    throw new WorkflowRunnerWorkerConfigError(
      'Workflow runner v2 requires the complete runtime-delivery profile.',
    );
  }
  if (environment[WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ENABLED_ENV] !== '1') {
    throw new WorkflowRunnerWorkerConfigError(
      'Workflow runner v2 requires the Workflow Control run authority.',
    );
  }
  const workspaceId = environment.OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID;
  const runnerBuildHash = environment.OPENSLACK_WORKFLOW_RUNNER_BUILD_HASH;
  if (!workspaceId || !SAFE_ID.test(workspaceId)) {
    throw new WorkflowRunnerWorkerConfigError('V2 worker workspace ID is invalid.');
  }
  if (!runnerBuildHash || !HASH.test(runnerBuildHash)) {
    throw new WorkflowRunnerWorkerConfigError('V2 worker build hash is invalid.');
  }
  const workspaceRoot = absolutePath(
    environment.OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT,
    'V2 worker workspace root',
  );
  const companionBearerToken =
    environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_BEARER_TOKEN ?? '';
  const expectedBearerHash =
    environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_BEARER_SHA256 ?? '';
  const budgetBearerToken = environment.OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_BEARER_TOKEN ?? '';
  const budgetCallerId = environment.OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_CALLER_ID ?? '';
  if (
    !isWorkflowControlBearerToken(companionBearerToken) ||
    !HASH.test(expectedBearerHash) ||
    createHash('sha256').update(companionBearerToken, 'utf8').digest('hex') !==
      expectedBearerHash ||
    !isWorkflowControlBearerToken(budgetBearerToken) ||
    !SAFE_ID.test(budgetCallerId)
  ) {
    throw new WorkflowRunnerWorkerConfigError(
      'V2 runtime-delivery bearer or budget caller identity is invalid.',
    );
  }
  const journalRoot = absolutePath(
    environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_JOURNAL_ROOT,
    'V2 runtime-delivery journal root',
  );
  const localStateRoot = join(workspaceRoot, '.openslack.local');
  if (!within(localStateRoot, journalRoot) || journalRoot === localStateRoot) {
    throw new WorkflowRunnerWorkerConfigError(
      'V2 runtime-delivery journal must be beneath the workspace-local state root.',
    );
  }
  const bearerToken = environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BEARER_TOKEN ?? '';
  const bearerHash = environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BEARER_SHA256 ?? '';
  const callerId = environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_CALLER_ID ?? '';
  const expectedBuildHash = environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BUILD_SHA ?? '';
  if (
    !isWorkflowControlBearerToken(bearerToken) ||
    !HASH.test(bearerHash) ||
    createHash('sha256').update(bearerToken, 'utf8').digest('hex') !== bearerHash ||
    !SAFE_ID.test(callerId) ||
    !HASH.test(expectedBuildHash)
  ) {
    throw new WorkflowRunnerWorkerConfigError('V2 run authority identity is invalid.');
  }
  return Object.freeze({
    enabled: true,
    workspaceId,
    workspaceRoot,
    descriptorRoot: absolutePath(
      environment.OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT,
      'V2 worker descriptor root',
    ),
    runnerBuildHash,
    runtimeDelivery: Object.freeze({
      companionOrigin: loopbackOrigin(
        environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ORIGIN,
        'V2 runtime-delivery companion origin',
      ),
      companionBearerToken,
      journalRoot,
      budgetOrigin: loopbackOrigin(
        environment.OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_ORIGIN,
        'V2 budget authority origin',
      ),
      budgetBearerToken,
      budgetCallerId,
    }),
    runAuthority: Object.freeze({
      origin: loopbackOrigin(
        environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ORIGIN,
        'V2 run authority origin',
      ),
      bearerToken,
      callerId,
      expectedBuildHash,
    }),
  });
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function sourceRoot(
  workflowSource: Exclude<WorkflowRunnerV2ExecutionDescriptor['workflowSource'], 'builtin'>,
  workspaceRoot: string,
): Promise<string> {
  switch (workflowSource) {
    case 'openslack-project':
      return join(workspaceRoot, '.openslack', 'workflows');
    case 'claude-project':
      return join(workspaceRoot, '.claude', 'workflows');
    case 'claude-user':
      return join(homedir(), '.claude', 'workflows');
  }
}

interface SealedWorkflowDescriptor {
  readonly workflowSource: WorkflowRunnerV2ExecutionDescriptor['workflowSource'];
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
}

interface SealedSourcePolicy<TDescriptor extends SealedWorkflowDescriptor> {
  readonly hashSource: (bytes: Uint8Array) => string;
  readonly hashManifest: (manifest: WorkflowMeta) => string;
  readonly beforePrepare?: (descriptor: TDescriptor) => void;
  readonly messages: {
    readonly unsafeRoot: string;
    readonly nonCanonicalRoot: string;
    readonly ambiguousEntry: string;
    readonly unsafeSource: string;
    readonly escapedSource: string;
    readonly changedRoot: string;
    readonly sourceHash: string;
    readonly changedSource: string;
    readonly loadedIdentity: string;
  };
}

function createSealedWorkflowSourceLoaderCore<TDescriptor extends SealedWorkflowDescriptor>(
  workspaceRoot: string,
  policy: SealedSourcePolicy<TDescriptor>,
): {
  readonly prepare: (descriptor: TDescriptor) => Promise<PreparedWorkflowSource>;
  readonly load: (
    prepared: PreparedWorkflowSource,
    descriptor: TDescriptor,
  ) => Promise<WorkflowModule>;
} {
  return Object.freeze({
    async prepare(descriptor: TDescriptor): Promise<PreparedWorkflowSource> {
      policy.beforePrepare?.(descriptor);
      if (descriptor.workflowSource === 'builtin') {
        throw new Error('Sealed workflow runners do not support builtin workflow sources.');
      }
      const root = await sourceRoot(descriptor.workflowSource, workspaceRoot);
      await assertNoWindowsReparseComponents(root);
      const rootBefore = await lstat(root, { bigint: true });
      if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
        throw new Error(policy.messages.unsafeRoot);
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
        throw new Error(policy.messages.nonCanonicalRoot);
      }
      const entries = new Set(await readdir(root));
      const candidates = SOURCE_EXTENSIONS.filter((extension) =>
        entries.has(`${descriptor.workflowId}${extension}`),
      ).map((extension) => join(rootReal, `${descriptor.workflowId}${extension}`));
      if (candidates.length !== 1) {
        throw new Error(policy.messages.ambiguousEntry);
      }
      const path = candidates[0]!;
      const pathBefore = await lstat(path, { bigint: true });
      if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
        throw new Error(policy.messages.unsafeSource);
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
        throw new Error(policy.messages.escapedSource);
      }
      const source = await readSealedWorkflowSource(canonical);
      const rootAfter = await lstat(root, { bigint: true });
      if (!sameSourceIdentity(rootBefore, rootAfter)) {
        throw new Error(policy.messages.changedRoot);
      }
      if (policy.hashSource(source.bytes) !== descriptor.workflowSourceHash) {
        throw new Error(policy.messages.sourceHash);
      }
      assertWorkflowRunnerSourceIsSelfContained(source.bytes);
      return Object.freeze({
        path: canonical,
        bytes: source.bytes,
        identity: sourceIdentity(source.stat),
      });
    },
    async load(prepared: PreparedWorkflowSource, descriptor: TDescriptor): Promise<WorkflowModule> {
      // This is the first dynamic import on the worker execution path and the
      // session invokes it only after lease_accept has an advancing receipt.
      const beforeImport = await readSealedWorkflowSource(prepared.path);
      if (
        sourceIdentity(beforeImport.stat) !== prepared.identity ||
        !beforeImport.bytes.equals(prepared.bytes) ||
        policy.hashSource(beforeImport.bytes) !== descriptor.workflowSourceHash
      ) {
        throw new Error(policy.messages.changedSource);
      }
      const workflow = await loadWorkflowFile(prepared.path, {
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
        policy.hashManifest(workflow.meta) !== descriptor.manifestHash ||
        policy.hashSource(afterImport.bytes) !== descriptor.workflowSourceHash
      ) {
        throw new Error(policy.messages.loadedIdentity);
      }
      return workflow;
    },
  });
}

export function createSealedWorkflowRunnerV2SourceLoader(
  workspaceRoot: string,
): WorkflowRunnerV2SourceLoader<PreparedWorkflowSource, WorkflowModule> {
  return createSealedWorkflowSourceLoaderCore<WorkflowRunnerV2ExecutionDescriptor>(workspaceRoot, {
    hashSource: hashWorkflowRunnerV2Source,
    hashManifest: hashWorkflowRunnerV2Manifest,
    messages: {
      unsafeRoot: 'Sealed v2 workflow catalog root is unsafe.',
      nonCanonicalRoot: 'Sealed v2 workflow catalog root must be canonical and non-symlinked.',
      ambiguousEntry: 'Sealed v2 workflow catalog entry is missing or ambiguous.',
      unsafeSource: 'Sealed v2 workflow source has an unsafe type.',
      escapedSource: 'Sealed v2 workflow source escapes its catalog root.',
      changedRoot: 'Sealed v2 workflow catalog root changed during validation.',
      sourceHash: 'Sealed v2 workflow source hash does not match the descriptor.',
      changedSource: 'Sealed v2 workflow source changed after lease acceptance.',
      loadedIdentity: 'Loaded v2 workflow identity does not match the sealed descriptor.',
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

/** Builds the exact E1 reserve bytes before the reduced frozen runner event is emitted. */
export function prepareWorkflowRunnerV2BudgetReserveSource(input: {
  readonly descriptor: WorkflowRunnerV2ExecutionDescriptor;
  readonly provider: ProviderAttemptReserveInput;
  readonly reservationId: string;
  readonly callId: string;
  readonly expectedAccountRevision: number;
  readonly expectedRunRevision: number;
  readonly callerId: string;
  readonly requestedAt: string;
}) {
  const providerIdentity = buildProviderUsageIdentityHashes(
    input.provider.providerId,
    input.provider.modelId,
    input.provider.providerRunId,
  );
  const request: WorkflowBudgetReserveRequest = {
    schema: WORKFLOW_BUDGET_RESERVE_REQUEST_SCHEMA,
    contractVersion: WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION,
    authority: WORKFLOW_BUDGET_AUTHORITY,
    writer: WORKFLOW_BUDGET_AUTHORITY_WRITER,
    goRole: WORKFLOW_BUDGET_AUTHORITY_GO_ROLE,
    goAuthorityClaim: WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM,
    goAuthorityEligible: false,
    workspaceId: input.descriptor.workspaceId,
    runId: input.descriptor.workflowRunId,
    accountId: input.descriptor.budgetPolicy.accountId,
    reservationId: input.reservationId,
    callId: input.callId,
    providerAttempt: input.provider.providerAttempt,
    expectedProviderHash: providerIdentity.providerHash,
    expectedModelHash: providerIdentity.modelHash,
    expectedProviderRunHash: providerIdentity.runHash,
    correlationId: input.descriptor.correlationId,
    policyHash: input.descriptor.budgetPolicy.policyHash,
    route: input.descriptor.authorityRoute,
    expectedAccountRevision: input.expectedAccountRevision,
    expectedRunRevision: input.expectedRunRevision,
    rateNanoUsdPerToken: input.descriptor.budgetPolicy.rateNanoUsdPerToken,
    requested: {
      tokens: input.provider.requestedTokens,
      nanoUsd: workflowBudgetAuthorityChargeNanoUsd(
        input.provider.requestedTokens,
        input.descriptor.budgetPolicy.rateNanoUsdPerToken,
      ),
      calls: '1',
    },
    requestedAt: input.requestedAt,
  };
  return prepareWorkflowBudgetAuthorityRequest('reserve', request, input.callerId);
}

export interface WorkflowRunnerV2BudgetAuthorityBoundary {
  readonly callerId: string;
  readonly client: WorkflowRunnerBudgetAuthorityClient;
  readonly now?: () => string;
}

function assertWorkflowRunnerBudgetRunHead(
  descriptor: WorkflowRunnerV2ExecutionDescriptor,
  context: WorkflowRunnerV2ExecutionContext,
  head: WorkflowControlAuthorityRunRead,
): void {
  const expectedRecord = {
    schema: 'openslack.workflow_control_authority_run_record.v2' as const,
    workspaceId: descriptor.workspaceId,
    runId: descriptor.workflowRunId,
    workflowId: descriptor.workflowId,
    workflowVersion: descriptor.workflowVersion,
    workflowSourceHash: descriptor.workflowSourceHash,
    manifestHash: descriptor.manifestHash,
    inputHash: descriptor.inputHash,
    route: descriptor.authorityRoute,
    state: head.state,
    revision: head.revision,
    currentPhaseId: head.currentPhaseId,
    currentPhaseIndex: head.currentPhaseIndex,
    resumeGeneration: head.resumeGeneration,
  };
  if (
    head.schema !== 'openslack.workflow_control_authority_read.v2' ||
    head.workspaceId !== descriptor.workspaceId ||
    head.runId !== descriptor.workflowRunId ||
    head.workflowId !== descriptor.workflowId ||
    head.workflowVersion !== descriptor.workflowVersion ||
    head.workflowSourceHash !== descriptor.workflowSourceHash ||
    head.manifestHash !== descriptor.manifestHash ||
    head.inputHash !== descriptor.inputHash ||
    canonicalWorkflowControlAuthorityJson(head.route) !==
      canonicalWorkflowControlAuthorityJson(descriptor.authorityRoute) ||
    head.state !== 'running' ||
    !Number.isSafeInteger(head.revision) ||
    head.revision < 1 ||
    head.resumeGeneration !== context.resumeGeneration ||
    canonicalWorkflowControlAuthorityJson(head.record) !==
      canonicalWorkflowControlAuthorityJson(expectedRecord)
  ) {
    throw new WorkflowRunnerV2BudgetBoundaryError(
      'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
      'Workflow Control run head cannot seed the durable budget account.',
    );
  }
}

function foldWorkflowRunnerProviderUsage(
  usage: ProviderUsageReceipt,
  requestedTokens: string,
  rateNanoUsdPerToken: string,
) {
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
  const settled = totalTokens !== null && BigInt(totalTokens) <= BigInt(requestedTokens);
  return Object.freeze({
    settled,
    payload: Object.freeze({
      providerReceiptHash: receiptHash,
      actualTokens: totalTokens ?? '0',
      actualCostNanoUsd:
        totalTokens === null
          ? '0'
          : workflowBudgetAuthorityChargeNanoUsd(totalTokens, rateNanoUsdPerToken),
      actualCalls: usage.calls,
      settlementStatus: settled ? ('settled' as const) : ('reconciliation_required' as const),
    }),
  });
}

export function createWorkflowRunnerV2ProviderAttemptPort(
  descriptor: WorkflowRunnerV2ExecutionDescriptor,
  context: WorkflowRunnerV2ExecutionContext,
  budgetAuthority?: WorkflowRunnerV2BudgetAuthorityBoundary,
  runAuthority?: WorkflowControlAuthorityPort,
): ProviderAttemptPort {
  const reservations = new Map<
    string,
    {
      readonly reservation: ProviderAttemptReservation;
      readonly providerAttempt: string;
      readonly requestedTokens: string;
      readonly reserveDecision?: WorkflowBudgetReserveDecision;
    }
  >();
  const now = budgetAuthority?.now ?? (() => new Date().toISOString());
  let budgetLane: Promise<void> = Promise.resolve();
  const inBudgetLane = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = budgetLane.then(operation);
    budgetLane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const resumeGeneration = context.resumeGeneration;
  if (
    !Number.isSafeInteger(resumeGeneration) ||
    resumeGeneration < descriptor.resumeGeneration ||
    resumeGeneration > descriptor.resumeGeneration + 1
  ) {
    throw new WorkflowRunnerV2BudgetBoundaryError(
      'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
      'Budget source cannot bind an invalid accepted resume generation.',
    );
  }

  const readBudgetHead = async () => {
    if (!budgetAuthority) return undefined;
    const account = await budgetAuthority.client.readAccount(
      descriptor.workflowRunId,
      descriptor.authorityRoute,
    );
    if (!account) return undefined;
    if (
      account.accountId !== descriptor.budgetPolicy.accountId ||
      account.policyHash !== descriptor.budgetPolicy.policyHash
    ) {
      throw new WorkflowRunnerV2BudgetBoundaryError(
        'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
        'Budget authority account head differs from the sealed descriptor.',
      );
    }
    return account;
  };

  const readExpectedRunRevision = async (
    account: Awaited<ReturnType<typeof readBudgetHead>>,
  ): Promise<number> => {
    if (account) return account.runRevision;
    if (!budgetAuthority) return descriptor.runRevision;
    if (!runAuthority) {
      throw new WorkflowRunnerV2BudgetBoundaryError(
        'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
        'A missing durable budget account requires the Workflow Control run authority.',
      );
    }
    const head = await runAuthority.read(descriptor.workflowRunId, descriptor.authorityRoute);
    assertWorkflowRunnerBudgetRunHead(descriptor, context, head);
    return head.revision;
  };

  const authorityBase = Object.freeze({
    contractVersion: WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION,
    authority: WORKFLOW_BUDGET_AUTHORITY,
    writer: WORKFLOW_BUDGET_AUTHORITY_WRITER,
    goRole: WORKFLOW_BUDGET_AUTHORITY_GO_ROLE,
    goAuthorityClaim: WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM,
    goAuthorityEligible: false as const,
  });

  const sourceFor = (
    operation: 'budget_reserve' | 'budget_settle',
    preparedRequest: ReturnType<typeof prepareWorkflowBudgetAuthorityRequest>,
    capture?: (decision: WorkflowBudgetReserveDecision) => void,
  ) => {
    if (!budgetAuthority) return undefined;
    return createWorkflowRunnerPreparedBudgetSourceAdapter({
      operation,
      preparedRequest,
      resumeGeneration,
      e2: {
        async pointRead(_stage, _receipt, signal) {
          const result = await budgetAuthority.client.pointRead(preparedRequest, signal);
          if (!result) return { state: 'not_committed' as const };
          if (result.sourceResult) capture?.(result.sourceResult.decision);
          return {
            state: 'committed' as const,
            ...(result.sourceResult === undefined
              ? {}
              : { budgetSourceResult: result.sourceResult }),
          };
        },
        async mutate(_stage, _receipt, signal) {
          const result = await budgetAuthority.client.mutate(preparedRequest, signal);
          if (result.sourceResult) capture?.(result.sourceResult.decision);
          return result.sourceResult;
        },
      },
    });
  };

  return Object.freeze({
    async reserve(input: ProviderAttemptReserveInput) {
      return inBudgetLane(async () => {
        const account = await readBudgetHead();
        const expectedRunRevision = await readExpectedRunRevision(account);
        const identity = createHash('sha256')
          .update(
            [descriptor.workflowRunId, input.providerRunId, input.providerAttempt].join('\0'),
            'utf8',
          )
          .digest('hex')
          .slice(0, 32);
        const reservationId = `reservation-${identity}`;
        const callId = `call-${identity}`;
        const preparedRequest = prepareWorkflowRunnerV2BudgetReserveSource({
          descriptor,
          provider: input,
          reservationId,
          callId,
          expectedAccountRevision: account?.accountRevision ?? 0,
          expectedRunRevision,
          requestedAt: now(),
          callerId: budgetAuthority?.callerId ?? 'workflow-runner-v2-f1',
        });
        const reserveRequest = parseWorkflowBudgetAuthorityBytes(
          Buffer.from(preparedRequest.body, 'utf8'),
        ) as WorkflowBudgetReserveRequest;
        let durableDecision: WorkflowBudgetReserveDecision | undefined;
        const reservationResult = await context.reserveBudget(
          {
            reservationId,
            callId,
            policyHash: reserveRequest.policyHash,
            requestedTokens: reserveRequest.requested.tokens,
            requestedCostNanoUsd: reserveRequest.requested.nanoUsd,
            requestedCalls: reserveRequest.requested.calls,
          },
          sourceFor('budget_reserve', preparedRequest, (value) => {
            durableDecision = value;
          }),
        );
        const decision = reservationResult.decision;
        durableDecision = reservationResult.budgetSourceResult?.decision ?? durableDecision;
        if (budgetAuthority && !durableDecision) {
          throw new WorkflowRunnerV2BudgetBoundaryError(
            'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
            'Budget reserve completed without its exact durable E2 decision.',
          );
        }
        const decisionPayload = decision.payload;
        if (
          !workflowRunnerV2BudgetDecisionMatchesRequest(decision, {
            reservationId,
            requestedTokens: reserveRequest.requested.tokens,
            requestedCostNanoUsd: reserveRequest.requested.nanoUsd,
            requestedCalls: reserveRequest.requested.calls,
          })
        ) {
          throw new WorkflowRunnerV2BudgetBoundaryError(
            'WORKFLOW_RUNNER_V2_BUDGET_AUTHORIZATION_MISMATCH',
            'Budget authorization does not bind the requested provider attempt.',
          );
        }
        if (decisionPayload.status === 'reconciliation_required') {
          throw new WorkflowRunnerV2BudgetBoundaryError(
            'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
            'Budget reserve outcome requires reconciliation.',
          );
        }
        if (decisionPayload.status !== 'reserved') {
          throw new WorkflowRunnerV2BudgetBoundaryError(
            'WORKFLOW_RUNNER_V2_BUDGET_REJECTED',
            'Budget authority rejected the provider attempt.',
          );
        }
        const reservation = Object.freeze({
          reservationId,
          callId,
          authorizedTokens: reserveRequest.requested.tokens,
        });
        reservations.set(reservationId, {
          reservation,
          providerAttempt: input.providerAttempt,
          requestedTokens: input.requestedTokens,
          ...(durableDecision === undefined ? {} : { reserveDecision: durableDecision }),
        });
        return reservation;
      });
    },
    async settle(reservation: ProviderAttemptReservation, usage: ProviderUsageReceipt) {
      return inBudgetLane(async () => {
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
        if (!budgetAuthority || !opened.reserveDecision) {
          // The F1 provider-only profile retains its reduced event seam and never
          // claims an E2 authority mutation.
          const folded = foldWorkflowRunnerProviderUsage(
            usage,
            opened.requestedTokens,
            descriptor.budgetPolicy.rateNanoUsdPerToken,
          );
          await context.reportBudgetUsage({
            reservationId: reservation.reservationId,
            callId: reservation.callId,
            ...folded.payload,
          });
          if (!folded.settled) {
            throw new WorkflowRunnerV2BudgetBoundaryError(
              'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
              'Provider usage is missing, unreported, or exceeded its reservation.',
            );
          }
          reservations.delete(reservation.reservationId);
          return;
        }

        const account = await readBudgetHead();
        if (!account) {
          throw new WorkflowRunnerV2BudgetBoundaryError(
            'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
            'Budget settlement cannot read its durable account head.',
          );
        }
        const folded = foldWorkflowRunnerProviderUsage(
          usage,
          opened.requestedTokens,
          descriptor.budgetPolicy.rateNanoUsdPerToken,
        );
        const reserveDecisionHash = hashWorkflowBudgetAuthorityValue(
          'reserve-decision',
          opened.reserveDecision,
        );
        const settlementRequest: WorkflowBudgetSettlementRequest = {
          schema: WORKFLOW_BUDGET_SETTLEMENT_REQUEST_SCHEMA,
          ...authorityBase,
          workspaceId: descriptor.workspaceId,
          runId: descriptor.workflowRunId,
          accountId: descriptor.budgetPolicy.accountId,
          reservationId: reservation.reservationId,
          callId: reservation.callId,
          providerAttempt: opened.providerAttempt,
          expectedProviderHash: opened.reserveDecision.request.expectedProviderHash,
          expectedModelHash: opened.reserveDecision.request.expectedModelHash,
          expectedProviderRunHash: opened.reserveDecision.request.expectedProviderRunHash,
          correlationId: descriptor.correlationId,
          policyHash: descriptor.budgetPolicy.policyHash,
          route: descriptor.authorityRoute,
          expectedAccountRevision: account.accountRevision,
          expectedRunRevision: account.runRevision,
          reserveDecisionHash,
          usageEvidenceStatus: 'trusted',
          usageReceiptHash: usage.receiptHash,
          providerUsage: {
            schema: WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA,
            providerHash: usage.providerHash,
            modelHash: usage.modelHash,
            runHash: usage.runHash,
            attempt: usage.attempt,
            calls: usage.calls,
            status: usage.status,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            outcome: usage.outcome,
            requestHash: usage.requestHash,
            outcomeHash: usage.outcomeHash,
            receiptHash: usage.receiptHash,
          },
          rateNanoUsdPerToken: descriptor.budgetPolicy.rateNanoUsdPerToken,
          requestedAt: now(),
        };
        const preparedRequest = prepareWorkflowBudgetAuthorityRequest(
          'settle',
          settlementRequest,
          budgetAuthority.callerId,
        );
        await context.reportBudgetUsage(
          {
            reservationId: reservation.reservationId,
            callId: reservation.callId,
            ...folded.payload,
          },
          sourceFor('budget_settle', preparedRequest),
        );
        if (!folded.settled) {
          throw new WorkflowRunnerV2BudgetBoundaryError(
            'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
            'Provider usage is missing, unreported, or exceeded its reservation.',
          );
        }
        reservations.delete(reservation.reservationId);
      });
    },
  });
}

function createWorkflowRunnerV2DefaultAuthoritySourceFactories(
  config: WorkflowRunnerV2WorkerConfig,
  authority: WorkflowControlResumeAuthorityPort,
): WorkflowRunnerV2AuthoritySourceFactories {
  return Object.freeze({
    async checkpoint() {
      throw new Error('Checkpoint source must be supplied by the authority-aware RunStore.');
    },
    async effect() {
      throw new Error('Effect source must be supplied by the authority-aware effect boundary.');
    },
    async budget() {
      throw new Error('Budget source must be supplied by the exact provider attempt boundary.');
    },
    async resume(target: WorkflowControlAuthorityMessage) {
      if (
        target.workflowRunId === null ||
        target.workspaceId === null ||
        target.jobId === null ||
        target.attemptId === null ||
        target.leaseId === null ||
        target.fencingToken === null ||
        target.resumeGeneration === null
      ) {
        throw new Error('Resume target lacks its exact runner binding.');
      }
      const store = new WorkflowRunnerResumeSourceStore(
        config.workspaceRoot,
        target,
        authority,
        createWorkflowRunnerAuthorityBindingClient({
          origin: config.runtimeDelivery.companionOrigin,
          workspaceId: config.workspaceId,
          bearerToken: config.runtimeDelivery.companionBearerToken,
        }),
      );
      return createWorkflowRunnerResumeSourceAdapter({
        pointRead: (stage, signal) => store.probe(stage, signal),
        commit: async (stage, receipt, signal) =>
          resumeEvidence(await store.commitResume(stage, receipt, signal), target),
      });
    },
  });
}

class WorkflowRunnerV2CheckpointRunStore extends WorkflowRunnerV2GoProjectionRunStore {
  readonly #context: WorkflowRunnerV2ExecutionContext;
  readonly #descriptor: WorkflowRunnerV2ExecutionDescriptor;

  constructor(
    baseDir: string,
    context: WorkflowRunnerV2ExecutionContext,
    descriptor: WorkflowRunnerV2ExecutionDescriptor,
    runAuthority: WorkflowControlAuthorityPort,
  ) {
    super({
      baseDir,
      descriptor,
      authority: runAuthority,
    });
    this.#context = context;
    this.#descriptor = descriptor;
  }

  override async commitWorkflowCheckpoint(
    runId: string,
    bindingValue: Parameters<RunStore['commitWorkflowCheckpoint']>[1],
    phaseId: string,
    phaseIndex: number,
    input: Parameters<RunStore['commitWorkflowCheckpoint']>[4],
  ): ReturnType<RunStore['commitWorkflowCheckpoint']> {
    const artifactHash = workflowCheckpointBytesHash(input.artifact);
    const artifactRef = `checkpoint-control/artifacts/${artifactHash}.json`;
    const checkpointId = `checkpoint-${workflowCheckpointHash({
      runId,
      phaseId,
      phaseIndex,
      artifactRef,
      artifactHash,
      resultHash: input.resultHash ?? null,
      cacheKeyHash: input.cacheKeyHash ?? null,
    })}`;
    let committed: Awaited<ReturnType<RunStore['commitWorkflowCheckpoint']>> | undefined;
    const matches = (state: WorkflowCheckpointControlState | null) => {
      const checkpoint = state?.checkpoints[phaseIndex];
      return checkpoint &&
        checkpoint.checkpointId === checkpointId &&
        checkpoint.phaseId === phaseId &&
        checkpoint.artifactRef === artifactRef &&
        checkpoint.artifactHash === artifactHash &&
        checkpoint.resultHash === (input.resultHash ?? null) &&
        checkpoint.cacheKeyHash === (input.cacheKeyHash ?? null)
        ? state
        : null;
    };
    const source = createWorkflowRunnerCheckpointSourceAdapter({
      pointRead: async () => {
        const state = matches(await this.loadCheckpointControl(runId));
        return state
          ? {
              state: 'committed' as const,
              evidence: checkpointEvidence(
                state,
                this.#descriptor.authorityRoute.authorityBuildHash,
                phaseIndex,
              ),
            }
          : { state: 'not_committed' as const };
      },
      commit: async () => {
        committed = await super.commitWorkflowCheckpoint(
          runId,
          bindingValue,
          phaseId,
          phaseIndex,
          input,
        );
        const state = matches(await this.loadCheckpointControl(runId));
        if (!state) throw new Error('Checkpoint source commit is not point-readable.');
        return checkpointEvidence(
          state,
          this.#descriptor.authorityRoute.authorityBuildHash,
          phaseIndex,
        );
      },
    });
    await this.#context.checkpointCommit(
      {
        checkpointId,
        phaseId,
        phaseIndex,
        commitPoint: 'after_phase_work',
        artifactRef,
        artifactHash,
        resultHash: input.resultHash ?? null,
        cacheKeyHash: input.cacheKeyHash ?? null,
        workflowSourceHash: this.#descriptor.workflowSourceHash,
        manifestHash: this.#descriptor.manifestHash,
        inputHash: this.#descriptor.inputHash,
      },
      source,
    );
    if (committed) return committed;
    const state = matches(await this.loadCheckpointControl(runId));
    const checkpoint = state?.checkpoints[phaseIndex];
    if (!checkpoint || !state) throw new Error('Checkpoint replay result is unavailable.');
    return Object.freeze({
      checkpointId: checkpoint.checkpointId,
      revision: checkpoint.committedRevision,
      resumeGeneration: checkpoint.resumeGeneration,
      duplicate: true,
    });
  }
}

/** @internal Exact Go-authority execution seam used by the sealed v2 worker. */
export async function executeWorkflowRunnerV2AuthorityJob(
  workflow: WorkflowModule,
  descriptor: WorkflowRunnerV2ExecutionDescriptor,
  context: WorkflowRunnerV2ExecutionContext,
  workspaceRoot: string,
  budgetAuthority: WorkflowRunnerV2BudgetAuthorityBoundary,
  runAuthority: WorkflowControlAuthorityPort,
): Promise<RunResult> {
  if (
    descriptor.authorityRoute.backend !== 'go' ||
    descriptor.authorityRoute.authority !== 'workflow-control'
  ) {
    throw new Error('The v2 worker accepts only Go-owned Workflow Control descriptors.');
  }
  const baseDir = resolveWorkflowRunProjectionRoot(workspaceRoot, 'go');
  const store = new WorkflowRunnerV2CheckpointRunStore(baseDir, context, descriptor, runAuthority);
  const exists = await store.runExists(descriptor.workflowRunId);
  const status = exists ? await store.loadStatus(descriptor.workflowRunId) : null;
  const disposition = classifyWorkflowRunnerRunState(
    descriptor.workflowRunId,
    exists,
    status?.status ?? null,
  );
  const { executeGoAuthorityResume, executeGoAuthorityRun } =
    await loadWorkflowExecutionAuthority();
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
      const providerAttemptPort = createWorkflowRunnerV2ProviderAttemptPort(
        descriptor,
        context,
        budgetAuthority,
        runAuthority,
      );
      return createOpenSlackAgentLauncher({
        runStore: createRunStore(workspaceRoot),
        rootDir: workspaceRoot,
        providerAttemptPort,
        openAICompatible: {
          rootDir: workspaceRoot,
        },
      });
    })(),
  };
  const effectAuthorizationPort = await createWorkflowRunnerV2EffectAuthorizationPort({
    workspaceRoot,
    descriptor,
    context,
  });
  if (disposition === 'resume') {
    return executeGoAuthorityResume(
      workflow,
      common,
      store,
      context.checkpointAuthority,
      effectAuthorizationPort,
    );
  }
  return executeGoAuthorityRun(
    workflow,
    common,
    store,
    context.checkpointAuthority,
    effectAuthorizationPort,
  );
}

/** @internal Sealed composition; excluded from the package root and public worker subpath. */
export async function createWorkflowRunnerV2RuntimeDelivery(
  config: WorkflowRunnerV2WorkerConfig,
  authority: WorkflowControlResumeAuthorityPort,
): Promise<WorkflowRunnerV2RuntimeDeliveryPort> {
  const runtime = new WorkflowRunnerAuthorityBindingRuntime({
    journal: new WorkflowRunnerAuthorityBindingJournal(config.runtimeDelivery.journalRoot),
    port: createWorkflowRunnerAuthorityBindingClient({
      origin: config.runtimeDelivery.companionOrigin,
      workspaceId: config.workspaceId,
      bearerToken: config.runtimeDelivery.companionBearerToken,
    }),
  });
  const delivery = new WorkflowRunnerV2RuntimeDelivery({
    runtime,
    sources: new WorkflowRunnerV2AuthoritySources(
      createWorkflowRunnerV2DefaultAuthoritySourceFactories(config, authority),
    ),
    projection: {
      async classify(descriptor) {
        const store = new WorkflowRunnerV2GoProjectionRunStore({
          baseDir: resolveWorkflowRunProjectionRoot(config.workspaceRoot, 'go'),
          descriptor,
          authority,
        });
        const exists = await store.runExists(descriptor.workflowRunId);
        const status = exists ? await store.loadStatus(descriptor.workflowRunId) : null;
        const disposition = classifyWorkflowRunnerRunState(
          descriptor.workflowRunId,
          exists,
          status?.status ?? null,
        );
        return disposition === 'initialize' ? 'initial' : 'resume';
      },
    },
    admissions: createWorkflowRunnerV2RuntimeAdmissionClient({
      origin: config.runtimeDelivery.companionOrigin,
      workspaceId: config.workspaceId,
      bearerToken: config.runtimeDelivery.companionBearerToken,
    }),
  });
  await delivery.initialize();
  return delivery;
}

export async function runWorkflowRunnerV2Worker(
  config: WorkflowRunnerV2WorkerConfig = loadWorkflowRunnerV2WorkerConfig(),
): Promise<void> {
  installProtocolOnlyStreams();
  const descriptorStore = new WorkflowRunnerDescriptorStore<WorkflowRunnerV2ExecutionDescriptor>(
    config.descriptorRoot,
    undefined,
    WORKFLOW_RUNNER_V2_DESCRIPTOR_CODEC,
  );
  await descriptorStore.initialize();
  const runAuthority = new WorkflowControlAuthorityHttpClient({
    origin: config.runAuthority.origin,
    workspaceId: config.workspaceId,
    callerId: config.runAuthority.callerId,
    bearerToken: config.runAuthority.bearerToken,
    expectedBuildHash: config.runAuthority.expectedBuildHash,
  });
  const runtimeDelivery = await createWorkflowRunnerV2RuntimeDelivery(config, runAuthority);
  const budgetAuthority: WorkflowRunnerV2BudgetAuthorityBoundary = Object.freeze({
    callerId: config.runtimeDelivery.budgetCallerId,
    client: createWorkflowRunnerBudgetAuthorityClient({
      origin: config.runtimeDelivery.budgetOrigin,
      workspaceId: config.workspaceId,
      bearerToken: config.runtimeDelivery.budgetBearerToken,
      callerId: config.runtimeDelivery.budgetCallerId,
    }),
  });
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
    reportFatal: (error) => {
      writeSync(2, boundedDiagnostic(error), undefined, 'utf8');
    },
    close,
    execute: (workflow, descriptor, context) =>
      executeWorkflowRunnerV2AuthorityJob(
        workflow,
        descriptor,
        context,
        config.workspaceRoot,
        budgetAuthority,
        runAuthority,
      ),
    runtimeDelivery,
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

async function loadWorkflowExecutionAuthority() {
  // Keep executable authority loading behind WorkflowRunnerV2Session's advancing
  // lease_accept receipt. The executor is module-private and is only invoked by
  // the accepted session callback; pure status classification is tested apart
  // from execution authority.
  return await import('./execute.js');
}
