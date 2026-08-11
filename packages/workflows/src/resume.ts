import type {
  ExecutionMode,
  PhaseCheckpoint,
  RunStatus,
  WorkflowMeta,
  WorkflowModule,
} from './types.js';
import type { RunStore, RunMeta } from './run-store.js';
import { WorkflowResumeRecoveryRequiredError } from './execute.js';
import { resolveWorkflowIdentityHash } from './internal/workflow-identity.js';
import { isWorkflowResumeStatus } from './internal/workflow-resume-state.js';

export type WorkflowResumeIdentity = Pick<
  WorkflowModule,
  'meta' | 'hash' | 'format' | 'sourceBody' | 'preview' | 'run'
>;

/**
 * Result of a resume check: indicates whether a run can be resumed
 * and what state it is in.
 */
export interface ResumeCheckResult {
  /** Whether the run can be resumed. */
  canResume: boolean;
  /** Reason if canResume is false. */
  reason?: string;
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

/**
 * Check whether a run can be resumed.
 *
 * A run is resumable if:
 * 1. It exists on disk
 * 2. Its status is one of the strict replay states
 * 3. Its full executable SHA-256 identity matches
 */
export async function checkResumable(
  runStore: RunStore,
  runId: string,
  identity: WorkflowResumeIdentity | WorkflowMeta,
): Promise<ResumeCheckResult> {
  // 1. Check run exists
  const exists = await runStore.runExists(runId);
  if (!exists) {
    return {
      canResume: false,
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
      reason: `Run ${runId} durable state is invalid.`,
      status: null,
      manifestMatch: false,
      cause: error,
    };
  }
  if (status === null) {
    return {
      canResume: false,
      reason: `Run ${runId} status not found`,
      status: null,
      manifestMatch: false,
    };
  }

  // 3. Check status is a strict replay state.
  if (!isWorkflowResumeStatus(status.status)) {
    return {
      canResume: false,
      reason: `Run ${runId} has status "${status.status}", expected a resumable state`,
      status,
      manifestMatch: false,
    };
  }

  // 4. Check full executable identity. Manifest-only callers remain source
  // compatible but cannot establish a strong identity and therefore fail closed.
  let meta: RunMeta | null;
  try {
    meta = await runStore.loadMeta(runId);
  } catch (error) {
    return {
      canResume: false,
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
      reason: `Run ${runId} has no usable strong workflow identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
      status,
      manifestMatch: false,
      storedManifestHash: storedHash,
    };
  }
  if (storedHash === undefined || !/^[0-9a-f]{64}$/u.test(storedHash)) {
    return {
      canResume: false,
      reason: `Run ${runId} uses a legacy weak workflow identity and requires recovery.`,
      status,
      manifestMatch: false,
      storedManifestHash: storedHash,
      currentManifestHash: currentHash,
    };
  }
  const manifestMatch = storedHash === currentHash;

  return {
    canResume: manifestMatch,
    reason: manifestMatch
      ? undefined
      : `Manifest hash mismatch: stored="${storedHash}", current="${currentHash}". ` +
        'Workflow source has changed since the run was paused.',
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
  runStore: RunStore,
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
 * Force-resume a run even when the manifest hash does not match.
 *
 * This sets the run status back to "running" and returns the resume
 * state with whatever checkpoints are still valid.
 *
 * **Warning**: This should only be used when the operator explicitly
 * acknowledges the risk.
 */
export async function forceResume(
  runStore: RunStore,
  runId: string,
  manifest: WorkflowMeta,
): Promise<ResumeState> {
  const exists = await runStore.runExists(runId);
  if (!exists) {
    throw new Error(`Run ${runId} not found`);
  }

  const status = await runStore.loadStatus(runId);
  if (status === null) {
    throw new Error(`Run ${runId} status not found`);
  }

  if (status.status !== 'paused') {
    throw new Error(`Run ${runId} has status "${status.status}", expected "paused"`);
  }

  // Transition back to running
  await runStore.transitionStatus(runId, 'running');

  // Load meta
  const meta = await runStore.loadMeta(runId);
  if (meta === null) {
    throw new Error(`Run ${runId} metadata not found`);
  }

  // Collect completed phase checkpoints
  const completedPhases: PhaseCheckpoint[] = [];
  for (const phaseDef of manifest.phases) {
    const checkpoint = await runStore.loadPhaseCheckpoint(runId, phaseDef.title);
    if (checkpoint !== null && checkpoint.status === 'completed') {
      completedPhases.push(checkpoint);
    } else {
      break;
    }
  }

  const nextPhaseIndex = completedPhases.length;

  return {
    runId,
    completedPhases,
    nextPhaseIndex,
    cachedAgentResults: new Map(),
    meta,
  };
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
