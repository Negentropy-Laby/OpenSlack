import { WORKFLOW_BINDING_HASH_REGEX } from './internal/workflow-binding-field-rules.js';
import {
  bindWorkflowSourceIdentity,
  compareWorkflowBinding,
  matchStoredWorkflowIdentity,
  resolveWorkflowIdentityHash,
} from './internal/workflow-identity.js';
import {
  createWorkflowSourceSnapshot,
  verifyWorkflowSourceSnapshot,
} from './internal/workflow-source-snapshot.js';
import { isWorkflowResumeStatus } from './internal/workflow-resume-state.js';
import type { RunMeta } from './run-store.js';
import type {
  PhaseCheckpoint,
  RunStatus,
  WorkflowMeta,
  WorkflowModule,
  WorkflowIdentity,
} from './types.js';
import type { WorkflowRunReadOnlyStore } from './workflow-run-projection.js';
import {
  validateWorkflowRunRouteReceipt,
  type WorkflowRunRouteReceipt,
} from './workflow-run-routing.js';

export type WorkflowResumeIdentity = Pick<
  WorkflowModule,
  'meta' | 'hash' | 'workflowIdentity' | 'format' | 'sourceBody' | 'preview' | 'run'
>;

export class WorkflowResumeRecoveryRequiredError extends Error {
  readonly code = 'WORKFLOW_RESUME_RECOVERY_REQUIRED' as const;

  constructor(
    readonly runId: string,
    reason: string,
    options?: ErrorOptions,
    readonly reasonCode = 'EVIDENCE_INVALID',
    readonly identities?: {
      stored?: string;
      current?: string;
      domain?: 'runner-v2-source' | 'runner-v2-manifest';
    },
  ) {
    super(`Workflow run ${runId} requires operator recovery: ${reason}`, options);
    this.name = 'WorkflowResumeRecoveryRequiredError';
  }
}

/** Validate receipt ownership and source evidence, without treating policy expiry as a run lease. */
export function bindGoWorkflowResumeIdentity(
  runId: string,
  workflow: WorkflowModule,
  sourceBytes: Uint8Array,
  route: WorkflowRunRouteReceipt,
  workspaceId: string,
): WorkflowModule {
  const reject = (reasonCode: string, reason: string): never => {
    throw new WorkflowResumeRecoveryRequiredError(runId, reason, undefined, reasonCode);
  };
  try {
    validateWorkflowRunRouteReceipt(route);
  } catch (cause) {
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      'route receipt is invalid',
      { cause },
      'ROUTE_INVALID',
    );
  }
  if (route.route.backend !== 'go') reject('ROUTE_INVALID', 'route is not Go-owned');
  // Ownership is checked before hashing; existing receipts keep their original selection time.
  const cheap = compareWorkflowBinding(
    { ...route, workflowSourceHash: '', manifestHash: '' },
    {
      runId,
      workspaceId,
      workflowId: workflow.meta.name,
      workflowVersion: workflow.meta.version ?? '0.0.0',
      workflowSourceHash: '',
      manifestHash: '',
      inputHash: route.inputHash,
    },
  );
  if (cheap) reject(cheap, 'run, workspace or workflow identity does not match the route');
  const snapshot =
    workflow.sourceSnapshot ?? createWorkflowSourceSnapshot(sourceBytes, workflow.meta);
  try {
    verifyWorkflowSourceSnapshot(snapshot, sourceBytes, workflow.meta);
  } catch (cause) {
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      'source or manifest changed since loading',
      { cause },
      'LOADER_SOURCE_MISMATCH',
    );
  }
  // This detects the loader-read versus subsequent source-read TOCTOU window.
  if (workflow.hash !== snapshot.rawHash)
    reject('LOADER_SOURCE_MISMATCH', 'loaded module differs from the source bytes');
  const drift = compareWorkflowBinding(
    { ...route, runId: undefined, workspaceId: undefined, inputHash: undefined },
    {
      workflowId: workflow.meta.name,
      workflowVersion: workflow.meta.version ?? '0.0.0',
      workflowSourceHash: snapshot.workflowSourceHash,
      manifestHash: snapshot.manifestHash,
    },
  );
  if (drift) {
    const manifestDrift = drift === 'MANIFEST_DRIFT';
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      'workflow source or manifest differs from the immutable route',
      undefined,
      drift,
      {
        domain: manifestDrift ? 'runner-v2-manifest' : 'runner-v2-source',
        stored: manifestDrift ? route.manifestHash : route.workflowSourceHash,
        current: manifestDrift ? snapshot.manifestHash : snapshot.workflowSourceHash,
      },
    );
  }
  return bindWorkflowSourceIdentity(workflow, sourceBytes, snapshot);
}

/**
 * Result of a resume check: indicates whether a run can be resumed
 * and what state it is in.
 */
export interface ResumeCheckResult {
  /** Whether the run can be resumed. */
  canResume: boolean;
  /** Reason if canResume is false. */
  reason?: string;
  reasonCode?: string;
  storedIdentity?: WorkflowIdentity;
  currentIdentity?: WorkflowIdentity;
  /** Current run status. */
  status: RunStatus | null;
  /** Whether the manifest hash matches the stored one. */
  manifestMatch: boolean;
  /** The stored manifest hash. */
  storedManifestHash?: string;
  /** The current manifest hash. */
  currentManifestHash?: string;
  /** Original durable-state validation cause, when available. */
  cause?: unknown;
}

/**
 * Result of a resume operation: cached phase results and the phase
 * index to resume from.
 */
export interface ResumeState {
  /** The run ID to resume. */
  runId: string;
  /** Completed phase checkpoints from the previous run. */
  completedPhases: PhaseCheckpoint[];
  /** Index of the next phase to execute (in manifest.phases). */
  nextPhaseIndex: number;
  /** Cached agent results keyed by cache key. */
  cachedAgentResults: Map<string, unknown>;
  /** The original run metadata. */
  meta: RunMeta;
}

/** Read-only state gate; run before importing or hashing a workflow. */
export async function checkResumeEligibility(
  runStore: WorkflowRunReadOnlyStore,
  runId: string,
): Promise<ResumeCheckResult> {
  // 1. Check run exists
  let exists: boolean;
  try {
    exists = await runStore.runExists(runId);
  } catch (cause) {
    return {
      canResume: false,
      reasonCode: 'EVIDENCE_INVALID',
      reason: 'Workflow evidence is unavailable; inspect its typed diagnostics before recovery.',
      status: null,
      manifestMatch: false,
      cause,
    };
  }
  if (!exists) {
    return {
      canResume: false,
      reasonCode: 'RUN_NOT_FOUND',
      reason: `Run ${runId} not found`,
      status: null,
      manifestMatch: false,
    };
  }

  // 2. Load current status
  let status: RunStatus | null;
  try {
    status = await runStore.getRunStatus(runId);
  } catch (error) {
    return {
      canResume: false,
      reasonCode: 'EVIDENCE_INVALID',
      reason: `Run ${runId} durable state is invalid.`,
      status: null,
      manifestMatch: false,
      cause: error,
    };
  }
  if (status === null) {
    return {
      canResume: false,
      reasonCode: 'EVIDENCE_INVALID',
      reason: `Run ${runId} status not found`,
      status: null,
      manifestMatch: false,
    };
  }

  // 3. Check status is a strict replay state.
  if (!isWorkflowResumeStatus(status.status)) {
    return {
      canResume: false,
      reasonCode: 'STATUS_NOT_RESUMABLE',
      reason: `Run ${runId} has status "${status.status}", expected a resumable state`,
      status,
      manifestMatch: false,
    };
  }

  return { canResume: true, status, manifestMatch: false };
}

/**
 * Check whether a run can be resumed.
 *
 * A run is resumable if:
 * 1. It exists on disk
 * 2. Its status is one of the strict replay states
 * 3. Its full executable SHA-256 identity matches
 */
export async function checkResumable(
  runStore: WorkflowRunReadOnlyStore,
  runId: string,
  identity: WorkflowResumeIdentity | WorkflowMeta,
): Promise<ResumeCheckResult> {
  const eligibility = await checkResumeEligibility(runStore, runId);
  if (!eligibility.canResume) return eligibility;
  const status = eligibility.status;

  // 4. Check full executable identity. Manifest-only callers remain source
  // compatible but cannot establish a strong identity and therefore fail closed.
  let meta: RunMeta | null;
  try {
    meta = await runStore.loadMeta(runId);
  } catch (error) {
    return {
      canResume: false,
      reasonCode: 'EVIDENCE_INVALID',
      reason: `Run ${runId} durable metadata is invalid.`,
      status,
      manifestMatch: false,
      cause: error,
    };
  }
  const storedHash = meta?.manifestHash;
  if (!isResumeIdentity(identity)) {
    return {
      canResume: false,
      reasonCode: 'IDENTITY_UNVERIFIED',
      reason: `Run ${runId} requires a loaded workflow with a full executable SHA-256 identity.`,
      status,
      manifestMatch: false,
      storedManifestHash: storedHash,
    };
  }
  let currentHash: string;
  try {
    currentHash = resolveWorkflowIdentityHash(identity, identity.meta);
  } catch (error) {
    return {
      canResume: false,
      reasonCode: 'IDENTITY_UNVERIFIED',
      reason: `Run ${runId} has no usable strong workflow identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
      status,
      manifestMatch: false,
      storedManifestHash: storedHash,
    };
  }
  if (storedHash === undefined || !WORKFLOW_BINDING_HASH_REGEX.test(storedHash)) {
    return {
      canResume: false,
      reason: `Run ${runId} uses a legacy weak workflow identity and requires recovery.`,
      status,
      manifestMatch: false,
      reasonCode: 'IDENTITY_UNVERIFIED',
      storedManifestHash: storedHash,
      currentManifestHash: currentHash,
    };
  }
  const storedIdentity = matchStoredWorkflowIdentity(storedHash, identity);
  const manifestMatch = storedIdentity !== undefined;

  return {
    canResume: manifestMatch,
    reasonCode: manifestMatch ? undefined : 'IDENTITY_UNVERIFIED',
    storedIdentity,
    currentIdentity: identity.workflowIdentity ?? { domain: 'raw-sha256', digest: currentHash },
    reason: manifestMatch
      ? undefined
      : `Manifest hash mismatch: stored="${storedHash}", current="${currentHash}". ` +
        'Stored workflow identity cannot be verified against the loaded source and route.',
    status,
    manifestMatch,
    storedManifestHash: storedHash,
    currentManifestHash: currentHash,
  };
}

/**
 * Prepare resume state for a paused run.
 *
 * Loads cached phase results and agent results so the runtime can
 * skip already-completed work.
 *
 * @throws if the run cannot be resumed
 */
export async function prepareResume(
  runStore: WorkflowRunReadOnlyStore,
  runId: string,
  identity: WorkflowResumeIdentity | WorkflowMeta,
): Promise<ResumeState> {
  // Validate the run is resumable
  const check = await checkResumable(runStore, runId, identity);
  if (!check.canResume) {
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      check.reason ?? `run cannot be resumed automatically`,
      check.cause === undefined ? undefined : { cause: check.cause },
      check.reasonCode,
      { stored: check.storedManifestHash, current: check.currentManifestHash },
    );
  }

  const manifest = isResumeIdentity(identity) ? identity.meta : identity;

  let meta: RunMeta | null;
  try {
    meta = await runStore.loadMeta(runId);
  } catch (error) {
    throw new WorkflowResumeRecoveryRequiredError(runId, 'durable metadata is invalid', {
      cause: error,
    });
  }
  if (meta === null) {
    throw new WorkflowResumeRecoveryRequiredError(runId, 'durable metadata is missing');
  }

  // Collect completed phase checkpoints
  const completedPhases: PhaseCheckpoint[] = [];
  for (const phaseDef of manifest.phases) {
    const checkpoint = await runStore.loadPhaseCheckpoint(runId, phaseDef.title);
    if (checkpoint !== null && checkpoint.status === 'completed') {
      completedPhases.push(checkpoint);
    } else {
      // Stop at the first non-completed phase
      break;
    }
  }

  // Determine next phase index
  const nextPhaseIndex = completedPhases.length;

  // Note: agent result loading is lazy; the runtime loads them via
  // the RunStore's loadAgentResult when processing agent calls.
  // Here we return an empty map; actual loading happens on demand.
  const cachedAgentResults = new Map<string, unknown>();

  return {
    runId,
    completedPhases,
    nextPhaseIndex,
    cachedAgentResults,
    meta,
  };
}

function isResumeIdentity(
  value: WorkflowResumeIdentity | WorkflowMeta,
): value is WorkflowResumeIdentity {
  return typeof value === 'object' && value !== null && 'meta' in value;
}

/**
 * Replay cached results for completed phases.
 *
 * This is a no-op helper that validates the checkpoint sequence
 * matches the manifest phases in order, and returns the checkpoints
 * for the caller to inject into the runtime.
 *
 * @returns Array of checkpoints for completed phases
 * @throws if checkpoints are out of order relative to manifest
 */
export function replayCachedPhases(
  manifest: WorkflowMeta,
  checkpoints: PhaseCheckpoint[],
): PhaseCheckpoint[] {
  const result: PhaseCheckpoint[] = [];

  for (let i = 0; i < manifest.phases.length; i++) {
    const expectedPhase = manifest.phases[i].title;
    if (i < checkpoints.length) {
      const cp = checkpoints[i];
      if (cp.phase !== expectedPhase) {
        throw new Error(
          `Phase mismatch at index ${i}: expected "${expectedPhase}", got "${cp.phase}"`,
        );
      }
      if (cp.status !== 'completed') {
        throw new Error(`Phase "${cp.phase}" has status "${cp.status}", expected "completed"`);
      }
      result.push(cp);
    } else {
      break;
    }
  }

  return result;
}
