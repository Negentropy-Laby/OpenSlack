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
import type { RunResult, WorkflowMeta, WorkflowModule } from './types.js';
import { RunStore } from './run-store.js';
import { resolveWorkflowRunProjectionRoot } from './workflow-run-projection.js';
import { isWorkflowControlBearerToken } from './workflow-control-routing-identity.js';
import {
  WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA,
  WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
  workflowCheckpointBytesHash,
  workflowCheckpointHash,
  type WorkflowCheckpointControlState,
  type WorkflowCheckpointShadowEnvelope,
} from './workflow-checkpoint-shadow-contract.js';
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
  WorkflowRunnerV2SessionError,
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
} from './workflow-control-authority-client.js';
import {
  createWorkflowRunnerBudgetAuthorityClient,
  type WorkflowRunnerBudgetAuthorityClient,
} from './workflow-runner-budget-authority-client.js';
import { canonicalWorkflowControlAuthorityJson } from './workflow-control-authority-contract.js';
import { exactWorkflowRunnerLoopbackOrigin } from './workflow-runner-control-http.js';
import type { WorkflowControlAuthorityMessage } from './workflow-control-authority-contract.js';
import type {
  WorkflowRunnerCheckpointAuthorityEvidence,
  WorkflowRunnerResumeAuthorityEvidence,
} from './workflow-runner-authority-binding-contract.js';

export const WORKFLOW_RUNNER_WORKER_ENABLED_ENV = 'OPENSLACK_WORKFLOW_RUNNER_ENABLED' as const;
export const WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED_ENV =
  'OPENSLACK_WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED' as const;
export const WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ENABLED_ENV =
  'WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ENABLED' as const;
export const WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ENABLED_ENV =
  'OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ENABLED' as const;

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

interface WorkflowRunnerV2WorkerConfigBase {
  readonly enabled: true;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly descriptorRoot: string;
  readonly runnerBuildHash: string;
}

export interface WorkflowRunnerV2QualificationWorkerConfig extends WorkflowRunnerV2WorkerConfigBase {
  readonly mode: 'qualification';
  readonly runtimeDelivery?: never;
  readonly runAuthority?: never;
}

export interface WorkflowRunnerV2GoAuthorityWorkerConfig extends WorkflowRunnerV2WorkerConfigBase {
  readonly mode: 'go-authority';
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

export type WorkflowRunnerV2WorkerConfig =
  | WorkflowRunnerV2QualificationWorkerConfig
  | WorkflowRunnerV2GoAuthorityWorkerConfig;

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
): WorkflowRunnerV2WorkerConfig {
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
  const workspaceRoot = absolutePath(
    environment.OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT,
    'V2 qualification workspace root',
  );
  const runtimeDeliveryKeys = [
    'OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ORIGIN',
    'OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_BEARER_TOKEN',
    'OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_BEARER_SHA256',
    'OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_JOURNAL_ROOT',
    'OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_ORIGIN',
    'OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_BEARER_TOKEN',
    'OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_CALLER_ID',
  ] as const;
  const runtimeDeliveryEnabled =
    environment[WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ENABLED_ENV] === '1';
  const runtimeDeliveryFlag = environment[WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ENABLED_ENV];
  if (
    runtimeDeliveryFlag !== undefined &&
    runtimeDeliveryFlag !== '0' &&
    runtimeDeliveryFlag !== '1'
  ) {
    throw new WorkflowRunnerWorkerConfigError('V2 runtime delivery enablement is invalid.');
  }
  if (
    !runtimeDeliveryEnabled &&
    runtimeDeliveryKeys.some((key) => environment[key] !== undefined)
  ) {
    throw new WorkflowRunnerWorkerConfigError(
      'Disabled v2 runtime-delivery configuration must be empty.',
    );
  }
  let runtimeDelivery: WorkflowRunnerV2GoAuthorityWorkerConfig['runtimeDelivery'] | undefined;
  if (runtimeDeliveryEnabled) {
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
    runtimeDelivery = Object.freeze({
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
    });
  }
  const runAuthorityKeys = [
    'OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ORIGIN',
    'OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BEARER_TOKEN',
    'OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BEARER_SHA256',
    'OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_CALLER_ID',
    'OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BUILD_SHA',
  ] as const;
  const runAuthorityFlag = environment[WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ENABLED_ENV];
  if (runAuthorityFlag !== undefined && runAuthorityFlag !== '0' && runAuthorityFlag !== '1') {
    throw new WorkflowRunnerWorkerConfigError('V2 run authority enablement is invalid.');
  }
  const runAuthorityEnabled = runAuthorityFlag === '1';
  if (!runAuthorityEnabled && runAuthorityKeys.some((key) => environment[key] !== undefined)) {
    throw new WorkflowRunnerWorkerConfigError(
      'Disabled v2 run authority configuration must be empty.',
    );
  }
  if (runAuthorityEnabled && !runtimeDeliveryEnabled) {
    throw new WorkflowRunnerWorkerConfigError(
      'V2 run authority requires the complete runtime-delivery profile.',
    );
  }
  let runAuthority: WorkflowRunnerV2GoAuthorityWorkerConfig['runAuthority'] | undefined;
  if (runAuthorityEnabled) {
    const bearerToken = environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BEARER_TOKEN ?? '';
    const bearerHash = environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BEARER_SHA256 ?? '';
    const callerId = environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_CALLER_ID ?? '';
    const expectedBuildHash =
      environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BUILD_SHA ?? '';
    if (
      !isWorkflowControlBearerToken(bearerToken) ||
      !HASH.test(bearerHash) ||
      createHash('sha256').update(bearerToken, 'utf8').digest('hex') !== bearerHash ||
      !SAFE_ID.test(callerId) ||
      !HASH.test(expectedBuildHash)
    ) {
      throw new WorkflowRunnerWorkerConfigError('V2 run authority identity is invalid.');
    }
    runAuthority = Object.freeze({
      origin: loopbackOrigin(
        environment.OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ORIGIN,
        'V2 run authority origin',
      ),
      bearerToken,
      callerId,
      expectedBuildHash,
    });
  }
  const common = Object.freeze({
    enabled: true as const,
    workspaceId,
    workspaceRoot,
    descriptorRoot: absolutePath(
      environment.OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT,
      'V2 qualification descriptor root',
    ),
    runnerBuildHash,
  });
  if (!runAuthorityEnabled) {
    if (runtimeDelivery !== undefined) {
      throw new WorkflowRunnerWorkerConfigError(
        'V2 runtime delivery requires the complete Go-authority profile.',
      );
    }
    return Object.freeze({ ...common, mode: 'qualification' as const });
  }
  return Object.freeze({
    ...common,
    mode: 'go-authority' as const,
    runtimeDelivery: runtimeDelivery!,
    runAuthority: runAuthority!,
  });
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function sourceRoot(
  workflowSource: Exclude<WorkflowRunnerExecutionDescriptor['workflowSource'], 'builtin'>,
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
  readonly workflowSource: WorkflowRunnerExecutionDescriptor['workflowSource'];
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

export function createSealedWorkflowRunnerSourceLoader(
  workspaceRoot: string,
): WorkflowRunnerSourceLoader<PreparedWorkflowSource> {
  const core = createSealedWorkflowSourceLoaderCore<WorkflowRunnerExecutionDescriptor>(
    workspaceRoot,
    {
      hashSource: hashWorkflowRunnerSource,
      hashManifest: hashWorkflowRunnerManifest,
      messages: {
        unsafeRoot: 'Sealed workflow catalog root is unsafe.',
        nonCanonicalRoot: 'Sealed workflow catalog root must be canonical and non-symlinked.',
        ambiguousEntry: 'Sealed workflow catalog entry is missing or ambiguous.',
        unsafeSource: 'Sealed workflow source has an unsafe type.',
        escapedSource: 'Sealed workflow source escapes its catalog root.',
        changedRoot: 'Sealed workflow catalog root changed during validation.',
        sourceHash: 'Sealed workflow source hash does not match the descriptor.',
        changedSource: 'Sealed workflow source changed after lease acceptance.',
        loadedIdentity: 'Loaded workflow identity does not match the sealed descriptor.',
      },
    },
  );
  return Object.freeze({
    prepare: core.prepare,
    load: (descriptor: WorkflowRunnerExecutionDescriptor, prepared: PreparedWorkflowSource) =>
      core.load(prepared, descriptor),
  });
}

export function createSealedWorkflowRunnerV2SourceLoader(
  workspaceRoot: string,
  runtimeDeliveryEnabled = false,
): WorkflowRunnerV2SourceLoader<PreparedWorkflowSource, WorkflowModule> {
  return createSealedWorkflowSourceLoaderCore<WorkflowRunnerV2ExecutionDescriptor>(workspaceRoot, {
    hashSource: hashWorkflowRunnerV2Source,
    hashManifest: hashWorkflowRunnerV2Manifest,
    beforePrepare(descriptor) {
      if (!runtimeDeliveryEnabled && descriptor.resumeGeneration !== 0) {
        throw new WorkflowRunnerV2RuntimeBoundaryUnavailableError('resume');
      }
    },
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
    if (
      !account ||
      account.accountId !== descriptor.budgetPolicy.accountId ||
      account.policyHash !== descriptor.budgetPolicy.policyHash
    ) {
      throw new WorkflowRunnerV2BudgetBoundaryError(
        'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
        'Budget authority account head is missing or differs from the sealed descriptor.',
      );
    }
    return account;
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
        async pointRead() {
          const result = await budgetAuthority.client.pointRead(preparedRequest);
          if (!result) return { state: 'not_committed' as const };
          if (result.sourceResult) capture?.(result.sourceResult.decision);
          return {
            state: 'committed' as const,
            ...(result.sourceResult === undefined
              ? {}
              : { budgetSourceResult: result.sourceResult }),
          };
        },
        async mutate() {
          const result = await budgetAuthority.client.mutate(preparedRequest);
          if (result.sourceResult) capture?.(result.sourceResult.decision);
          return result.sourceResult;
        },
      },
    });
  };

  return Object.freeze({
    async reserve(input: ProviderAttemptReserveInput) {
      const account = await readBudgetHead();
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
        expectedRunRevision: account?.runRevision ?? descriptor.runRevision,
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
        reservations.delete(reservation.reservationId);
        if (!folded.settled) {
          throw new WorkflowRunnerV2BudgetBoundaryError(
            'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
            'Provider usage is missing, unreported, or exceeded its reservation.',
          );
        }
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
      reservations.delete(reservation.reservationId);
      if (!folded.settled) {
        throw new WorkflowRunnerV2BudgetBoundaryError(
          'WORKFLOW_RUNNER_V2_BUDGET_RECONCILIATION_REQUIRED',
          'Provider usage is missing, unreported, or exceeded its reservation.',
        );
      }
    },
  });
}

function checkpointEnvelope(
  state: WorkflowCheckpointControlState,
  operation: 'checkpoint_commit' | 'resume_advance',
  checkpointPhaseIndex?: number,
): WorkflowCheckpointShadowEnvelope {
  const active = state.activeBinding;
  const checkpoint =
    operation === 'checkpoint_commit' && checkpointPhaseIndex !== undefined
      ? (state.checkpoints[checkpointPhaseIndex] ?? null)
      : null;
  const priorCheckpoint =
    operation === 'resume_advance' ? (state.checkpoints.at(-1) ?? null) : null;
  const observation = {
    schema: WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
    authority: 'typescript' as const,
    goRole: 'observer_only' as const,
    runId: state.runId,
    revision: state.revision,
    resumeGeneration: state.resumeGeneration,
    checkpoint,
    priorCheckpoint,
    nextPhaseId: operation === 'resume_advance' ? `phase-${state.checkpoints.length}` : null,
    nextPhaseIndex: operation === 'resume_advance' ? state.checkpoints.length : null,
    workflowSourceHash: active.workflowSourceHash,
    manifestHash: active.manifestHash,
    inputHash: active.inputHash,
    runner: {
      workspaceId: active.workspaceId,
      jobId: active.jobId,
      attemptId: active.attemptId,
      leaseId: active.leaseId,
      fencingToken: active.fencingToken,
      correlationId: active.correlationId,
      runnerBuildHash: active.runnerBuildHash,
    },
  };
  return Object.freeze({
    schema: WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA,
    goRole: 'observer_only' as const,
    sourceSequence: state.revision - 1,
    operation,
    observation,
    observationHash: workflowCheckpointHash(observation),
  });
}

function checkpointEvidence(
  state: WorkflowCheckpointControlState,
  authorityBuildHash: string,
  phaseIndex: number,
): WorkflowRunnerCheckpointAuthorityEvidence {
  const envelope = checkpointEnvelope(state, 'checkpoint_commit', phaseIndex);
  const envelopeHash = createHash('sha256')
    .update(canonicalWorkflowControlAuthorityJson(envelope), 'utf8')
    .digest('hex');
  return Object.freeze({
    schema: 'openslack.workflow_runner_checkpoint_authority_evidence.v1',
    sourceAuthority: {
      plane: 'checkpoint_control' as const,
      evidenceState: 'committed' as const,
      expectedRevision: state.revision - 1,
      acceptedRevision: state.revision,
      expectedResumeGeneration: state.resumeGeneration,
      acceptedResumeGeneration: state.resumeGeneration,
      requestHash: envelopeHash,
      receiptSchema: 'openslack.workflow_runner_checkpoint_authority_receipt.v1',
      receiptHash: createHash('sha256')
        .update(
          canonicalWorkflowControlAuthorityJson({
            schema: 'openslack.workflow_runner_checkpoint_authority_receipt.v1',
            envelopeHash,
            acceptedRevision: state.revision,
          }),
          'utf8',
        )
        .digest('hex'),
      recordHash: envelope.observationHash,
      authorityBuildHash,
    },
    envelope,
    envelopeHash,
  });
}

function resumeEvidence(
  state: WorkflowCheckpointControlState,
  target: WorkflowControlAuthorityMessage,
): WorkflowRunnerResumeAuthorityEvidence {
  const envelope = checkpointEnvelope(state, 'resume_advance');
  const envelopeHash = createHash('sha256')
    .update(canonicalWorkflowControlAuthorityJson(envelope), 'utf8')
    .digest('hex');
  const priorCheckpoint = envelope.observation.priorCheckpoint;
  if (
    !priorCheckpoint ||
    target.attemptId === null ||
    target.authorityBuildHash === null ||
    typeof target.payload.leaseExpiresAt !== 'string'
  ) {
    throw new Error('Resume source evidence lacks its prior checkpoint or lease identity.');
  }
  return Object.freeze({
    schema: 'openslack.workflow_runner_resume_authority_evidence.v1',
    sourceAuthority: {
      plane: 'resume_control' as const,
      evidenceState: 'committed' as const,
      expectedRevision: state.revision - 1,
      acceptedRevision: state.revision,
      expectedResumeGeneration: state.resumeGeneration - 1,
      acceptedResumeGeneration: state.resumeGeneration,
      requestHash: envelopeHash,
      receiptSchema: 'openslack.workflow_runner_resume_authority_receipt.v1',
      receiptHash: createHash('sha256')
        .update(
          canonicalWorkflowControlAuthorityJson({
            schema: 'openslack.workflow_runner_resume_authority_receipt.v1',
            envelopeHash,
            acceptedRevision: state.revision,
            acceptedResumeGeneration: state.resumeGeneration,
          }),
          'utf8',
        )
        .digest('hex'),
      recordHash: envelope.observationHash,
      authorityBuildHash: target.authorityBuildHash,
    },
    envelope,
    envelopeHash,
    priorCheckpointId: priorCheckpoint.checkpointId,
    priorCheckpointHash: createHash('sha256')
      .update(canonicalWorkflowControlAuthorityJson(priorCheckpoint), 'utf8')
      .digest('hex'),
    nextPhaseId: envelope.observation.nextPhaseId!,
    nextPhaseIndex: envelope.observation.nextPhaseIndex!,
    logicalResumeAttemptId: `logical.resume.${createHash('sha256')
      .update(`${target.attemptId}\0${state.resumeGeneration}`, 'utf8')
      .digest('hex')}`,
    expiresAt: target.payload.leaseExpiresAt,
  });
}

function createWorkflowRunnerV2DefaultAuthoritySourceFactories(
  config: WorkflowRunnerV2GoAuthorityWorkerConfig,
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
      const store = new RunStore({
        baseDir: join(config.workspaceRoot, '.openslack.local', 'workflows'),
      });
      const committedState = async () => {
        const state = await store.loadCheckpointControl(target.workflowRunId!);
        return state &&
          state.activeBinding.workspaceId === target.workspaceId &&
          state.activeBinding.jobId === target.jobId &&
          state.activeBinding.attemptId === target.attemptId &&
          state.activeBinding.leaseId === target.leaseId &&
          state.activeBinding.fencingToken === target.fencingToken &&
          state.resumeGeneration === target.resumeGeneration! + 1
          ? state
          : null;
      };
      return createWorkflowRunnerResumeSourceAdapter({
        pointRead: async () => {
          const state = await committedState();
          return state
            ? { state: 'committed' as const, evidence: resumeEvidence(state, target) }
            : { state: 'not_committed' as const };
        },
        commit: async () => {
          const prior = await store.loadCheckpointControl(target.workflowRunId!);
          const priorCheckpoint = prior?.checkpoints.at(-1);
          if (!prior || !priorCheckpoint) {
            throw new Error('Resume source lacks its durable prior checkpoint.');
          }
          const binding = {
            ...prior.activeBinding,
            workspaceId: target.workspaceId!,
            jobId: target.jobId!,
            workflowRunId: target.workflowRunId!,
            attemptId: target.attemptId!,
            leaseId: target.leaseId!,
            fencingToken: target.fencingToken!,
            correlationId: target.correlationId,
          };
          await store.beginCheckpointResumeGeneration(
            target.workflowRunId!,
            binding,
            `phase-${priorCheckpoint.phaseIndex + 1}`,
            priorCheckpoint.phaseIndex + 1,
          );
          const state = await committedState();
          if (!state) throw new Error('Resume source commit is not point-readable.');
          return resumeEvidence(state, target);
        },
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
    runAuthority?: WorkflowControlAuthorityPort,
    mode: 'qualification' | 'go-authority' = 'qualification',
  ) {
    super({
      baseDir,
      descriptor,
      ...(mode === 'go-authority'
        ? { mode: 'authority' as const, authority: runAuthority! }
        : { mode: 'qualification' as const }),
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

/** @internal Exact v2 worker execution seam used by the bundled qualification worker. */
export async function executeWorkflowRunnerV2QualificationJob(
  workflow: WorkflowModule,
  descriptor: WorkflowRunnerV2ExecutionDescriptor,
  context: WorkflowRunnerV2ExecutionContext,
  workspaceRoot: string,
  runtimeDeliveryEnabled: boolean,
  budgetAuthority?: WorkflowRunnerV2BudgetAuthorityBoundary,
  runAuthority?: WorkflowControlAuthorityPort,
  mode: 'qualification' | 'go-authority' = 'qualification',
): Promise<RunResult> {
  const selectedGo = descriptor.authorityRoute.backend === 'go';
  if (mode === 'go-authority' && !selectedGo) {
    throw new Error('The new-record canary worker accepts only Go-owned v2 descriptors.');
  }
  if (mode === 'qualification' && selectedGo) {
    throw new Error('Qualification-only v2 execution rejects Go-owned descriptors.');
  }
  if (mode === 'qualification' && runAuthority) {
    throw new Error('Qualification-only v2 execution cannot receive the production run authority.');
  }
  const goOwned = mode === 'go-authority';
  if (goOwned && !runtimeDeliveryEnabled) {
    throw new Error('Go-owned v2 execution requires the complete runtime-delivery profile.');
  }
  if (goOwned && !runAuthority) {
    throw new Error('Go-owned v2 execution requires the Workflow Control run authority.');
  }
  if (!goOwned && runAuthority) {
    throw new Error('TypeScript-owned v2 execution cannot receive a Go run authority.');
  }
  const baseDir = resolveWorkflowRunProjectionRoot(workspaceRoot, goOwned ? 'go' : 'ts-local');
  const store = runtimeDeliveryEnabled
    ? new WorkflowRunnerV2CheckpointRunStore(baseDir, context, descriptor, runAuthority, mode)
    : new RunStore({ baseDir });
  const exists = await store.runExists(descriptor.workflowRunId);
  const status = exists ? await store.loadStatus(descriptor.workflowRunId) : null;
  const disposition = classifyWorkflowRunnerRunState(
    descriptor.workflowRunId,
    exists,
    status?.status ?? null,
  );
  if (disposition === 'resume' && !runtimeDeliveryEnabled) {
    throw new WorkflowRunnerV2RuntimeBoundaryUnavailableError('resume');
  }
  const { executeResumeWithStore, executeRunWithStore } = await loadWorkflowExecutionAuthority();
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
          providerAttemptPort: createWorkflowRunnerV2ProviderAttemptPort(
            descriptor,
            context,
            budgetAuthority,
          ),
        },
      });
    })(),
  };
  const effectAuthorizationPort = runtimeDeliveryEnabled
    ? await createWorkflowRunnerV2EffectAuthorizationPort({
        workspaceRoot,
        descriptor,
        context,
      })
    : undefined;
  if (disposition === 'resume') {
    return executeResumeWithStore(
      workflow,
      common,
      store,
      runtimeDeliveryEnabled ? context.checkpointAuthority : undefined,
      effectAuthorizationPort,
    );
  }
  return executeRunWithStore(
    workflow,
    common,
    store,
    runtimeDeliveryEnabled ? context.checkpointAuthority : undefined,
    effectAuthorizationPort,
  );
}

export async function createWorkflowRunnerV2QualificationRuntimeDelivery(
  config: WorkflowRunnerV2GoAuthorityWorkerConfig,
  authority: WorkflowControlAuthorityPort,
  sourceFactories: WorkflowRunnerV2AuthoritySourceFactories = createWorkflowRunnerV2DefaultAuthoritySourceFactories(
    config,
  ),
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
    sources: new WorkflowRunnerV2AuthoritySources(sourceFactories),
    projection: {
      async classify(descriptor) {
        const store = new WorkflowRunnerV2GoProjectionRunStore({
          baseDir: resolveWorkflowRunProjectionRoot(config.workspaceRoot, 'go'),
          descriptor,
          mode: 'authority',
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

export interface WorkflowRunnerV2QualificationWorkerDependencies {
  readonly authoritySourceFactories?: WorkflowRunnerV2AuthoritySourceFactories;
  readonly runAuthority?: WorkflowControlAuthorityPort;
}

export async function runWorkflowRunnerV2QualificationWorker(
  config: WorkflowRunnerV2WorkerConfig = loadWorkflowRunnerV2QualificationWorkerConfig(),
  dependencies: WorkflowRunnerV2QualificationWorkerDependencies = {},
): Promise<void> {
  installProtocolOnlyStreams();
  const descriptorStore = new WorkflowRunnerDescriptorStore<WorkflowRunnerV2ExecutionDescriptor>(
    config.descriptorRoot,
    undefined,
    WORKFLOW_RUNNER_V2_DESCRIPTOR_CODEC,
  );
  await descriptorStore.initialize();
  const runAuthority =
    dependencies.runAuthority ??
    (config.mode === 'go-authority'
      ? new WorkflowControlAuthorityHttpClient({
          origin: config.runAuthority.origin,
          workspaceId: config.workspaceId,
          callerId: config.runAuthority.callerId,
          bearerToken: config.runAuthority.bearerToken,
          expectedBuildHash: config.runAuthority.expectedBuildHash,
        })
      : undefined);
  if (dependencies.runAuthority && config.mode !== 'go-authority') {
    throw new WorkflowRunnerWorkerConfigError(
      'Injected v2 run authority requires an explicitly enabled run-authority profile.',
    );
  }
  const runtimeDelivery =
    config.mode === 'go-authority'
      ? dependencies.authoritySourceFactories
        ? await createWorkflowRunnerV2QualificationRuntimeDelivery(
            config,
            runAuthority!,
            dependencies.authoritySourceFactories,
          )
        : await createWorkflowRunnerV2QualificationRuntimeDelivery(config, runAuthority!)
      : undefined;
  const budgetAuthority: WorkflowRunnerV2BudgetAuthorityBoundary | undefined =
    config.mode === 'go-authority'
      ? Object.freeze({
          callerId: config.runtimeDelivery.budgetCallerId,
          client: createWorkflowRunnerBudgetAuthorityClient({
            origin: config.runtimeDelivery.budgetOrigin,
            workspaceId: config.workspaceId,
            bearerToken: config.runtimeDelivery.budgetBearerToken,
            callerId: config.runtimeDelivery.budgetCallerId,
          }),
        })
      : undefined;
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
    sourceLoader: createSealedWorkflowRunnerV2SourceLoader(
      config.workspaceRoot,
      runtimeDelivery !== undefined,
    ),
    send: (exactBytes) => {
      writeSync(1, exactBytes, undefined, 'utf8');
    },
    close,
    execute: (workflow, descriptor, context) =>
      executeWorkflowRunnerV2QualificationJob(
        workflow,
        descriptor,
        context,
        config.workspaceRoot,
        runtimeDelivery !== undefined,
        budgetAuthority,
        runAuthority,
        config.mode,
      ),
    ...(runtimeDelivery ? { runtimeDelivery } : {}),
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
