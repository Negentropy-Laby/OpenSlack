import { WORKFLOW_BINDING_HASH_REGEX } from './internal/workflow-binding-field-rules.js';
import { types as utilTypes } from 'node:util';
import { runMetaWorkflowIdentity } from './internal/workflow-run-identity.js';
import {
  bindWorkflowSourceIdentity,
  compareWorkflowBinding,
  compareStoredWorkflowIdentity,
} from './internal/workflow-identity.js';
import { WorkflowSourceEvidenceError } from './internal/workflow-source-snapshot.js';
import { isWorkflowResumeStatus } from './internal/workflow-resume-state.js';
import type { RunMeta } from './run-store.js';
import type {
  PhaseCheckpoint,
  RunStatus,
  WorkflowMeta,
  WorkflowModule,
  WorkflowIdentityEvidence,
} from './types.js';
import type { WorkflowRunReadOnlyStore } from './workflow-run-projection.js';
import {
  validateWorkflowRunRouteReceipt,
  type WorkflowRunRouteReceipt,
} from './workflow-run-routing.js';

declare const resumeIdentityBrand: unique symbol;
export type WorkflowResumeIdentity = WorkflowModule & {
  readonly [resumeIdentityBrand]: true;
};
const resumeIdentityRuns = new WeakMap<WorkflowModule, string>();

export class WorkflowResumeRecoveryRequiredError extends Error {
  readonly code = 'WORKFLOW_RESUME_RECOVERY_REQUIRED' as const;

  constructor(
    readonly runId: string,
    reason: string,
    options?: ErrorOptions,
    readonly reasonCode = 'EVIDENCE_INVALID',
    readonly identities?:
      | {
          stored?: string;
          current?: string;
          domain?: 'runner-v2-source' | 'runner-v2-manifest' | 'raw-sha256';
        }
      | {
          stored?: WorkflowIdentityEvidence;
          current?: WorkflowIdentityEvidence;
        },
  ) {
    super(`Workflow run ${runId} requires operator recovery: ${reason}`, options);
    this.name = 'WorkflowResumeRecoveryRequiredError';
  }
}

/** Process-local ownership of a validated receipt copy, not remote authentication.
 * Source and manifest digests must still match the route; execution rechecks authority.
 */
export interface GoWorkflowResumeContext {
  readonly runId: string;
}
const resumeContexts = new WeakMap<GoWorkflowResumeContext, WorkflowRunRouteReceipt>();

/** Validate ownership once at entry; policy expiry is not an existing run's lease. */
export function validateGoWorkflowResumeContext(
  runId: string,
  route: WorkflowRunRouteReceipt,
  workspaceId: string,
): GoWorkflowResumeContext {
  let validated: WorkflowRunRouteReceipt;
  try {
    validated = validateWorkflowRunRouteReceipt(route);
  } catch (cause) {
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      'route receipt is invalid',
      { cause },
      'ROUTE_INVALID',
    );
  }
  if (validated.route.backend !== 'go') {
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      'route is not Go-owned',
      undefined,
      'ROUTE_INVALID',
    );
  }
  const ownership = compareWorkflowBinding(
    { runId: validated.runId, workspaceId: validated.workspaceId },
    { runId, workspaceId },
  );
  if (ownership) {
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      'run or workspace does not match the route',
      undefined,
      ownership,
    );
  }
  const context = Object.freeze({ runId });
  // The validator returns a canonical copy, never the caller's mutable receipt.
  resumeContexts.set(context, validated);
  return context;
}

/** Bind source evidence only after the entry boundary has validated Go ownership. */
export function bindGoWorkflowResumeIdentity(
  context: GoWorkflowResumeContext,
  workflow: WorkflowModule,
  sourceBytes: Uint8Array,
): WorkflowResumeIdentity {
  const route = resumeContexts.get(context);
  const runId = context.runId;
  const reject = (reasonCode: string, reason: string): never => {
    throw new WorkflowResumeRecoveryRequiredError(runId, reason, undefined, reasonCode);
  };
  if (!route) {
    return reject('ROUTE_INVALID', 'resume context requires validated route evidence');
  }
  const cheap = compareWorkflowBinding(
    { workflowId: route.workflowId, workflowVersion: route.workflowVersion },
    { workflowId: workflow.meta.name, workflowVersion: workflow.meta.version ?? '0.0.0' },
  );
  if (cheap) reject(cheap, 'workflow identity does not match the route');
  const snapshot = workflow.sourceSnapshot;
  if (!snapshot) {
    return reject(
      'SOURCE_EVIDENCE_MISSING',
      'Go resume requires a supported file workflow with loader source evidence; embedded builtins are unsupported',
    );
  }
  let bound: WorkflowModule;
  try {
    bound = bindWorkflowSourceIdentity(workflow, sourceBytes, snapshot);
  } catch (cause) {
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      'source or manifest changed since loading',
      { cause },
      cause instanceof WorkflowSourceEvidenceError ? cause.reasonCode : 'LOADER_SOURCE_MISMATCH',
      cause instanceof WorkflowSourceEvidenceError ? cause.identities : undefined,
    );
  }
  const drift = compareWorkflowBinding(
    { workflowSourceHash: route.workflowSourceHash, manifestHash: route.manifestHash },
    {
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
  resumeIdentityRuns.set(bound, runId);
  return bound as WorkflowResumeIdentity;
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
  storedIdentity?: WorkflowIdentityEvidence;
  currentIdentity?: WorkflowIdentityEvidence;
  /** Current run status. */
  status: RunStatus | null;
  /** Whether the manifest hash matches the stored one. */
  manifestMatch: boolean;
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

/** Status-only observation; never a source verification or execution authorization. */
export interface ResumeEligibilityResult {
  eligible: boolean;
  status: RunStatus | null;
  reason?: string;
  reasonCode?: string;
  cause?: unknown;
}

/** Read-only state gate; run before importing or hashing a workflow. */
export async function checkResumeEligibility(
  runStore: WorkflowRunReadOnlyStore,
  runId: string,
): Promise<ResumeEligibilityResult> {
  const { canResume, status, reason, reasonCode, cause } = await checkResumeState(runStore, runId);
  return { eligible: canResume, status, reason, reasonCode, cause };
}

/** Store observations must be inert plain data before clone/getter traversal. */
function ownReadEvidence<T>(value: T): T {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'function' || typeof current === 'symbol')
      throw new TypeError('Workflow evidence must be inert data.');
    if (current === null || typeof current !== 'object') continue;
    if (utilTypes.isProxy(current)) throw new TypeError('Workflow evidence cannot be a Proxy.');
    if (seen.has(current)) continue;
    seen.add(current);
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
      throw new TypeError('Workflow evidence must use plain objects.');
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if (!('value' in descriptor)) throw new TypeError('Workflow evidence cannot have accessors.');
      pending.push(descriptor.value);
    }
  }
  return structuredClone(value);
}

async function checkResumeState(
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
    status = ownReadEvidence(await runStore.getRunStatus(runId));
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
  identity: WorkflowResumeIdentity,
): Promise<ResumeCheckResult> {
  return (await createWorkflowResumePreflight(runStore, runId)).check(identity);
}

/** Bound read-only observation. Never accepted by the execution/authority APIs. */
export async function createWorkflowResumePreflight(
  runStore: WorkflowRunReadOnlyStore,
  runId: string,
) {
  let eligibility = await checkResumeState(runStore, runId);
  let meta: RunMeta | null = null;
  if (eligibility.canResume) {
    try {
      meta = ownReadEvidence(await runStore.loadMeta(runId));
      if (meta === null) {
        eligibility = {
          ...eligibility,
          canResume: false,
          manifestMatch: false,
          reasonCode: 'EVIDENCE_INVALID',
          reason: `Run ${runId} durable metadata is missing.`,
        };
      }
    } catch (cause) {
      eligibility = {
        ...eligibility,
        canResume: false,
        reasonCode: 'EVIDENCE_INVALID',
        reason: `Run ${runId} durable metadata is invalid.`,
        cause,
      };
    }
  }
  // Owned copies and closures bind this observation to one store/run. Callers
  // cannot pass fabricated observations to checkResumable or prepareResume.
  return Object.freeze({
    get eligibility(): ResumeEligibilityResult {
      const { canResume, status, reason, reasonCode, cause } = eligibility;
      return { eligible: canResume, status: structuredClone(status), reason, reasonCode, cause };
    },
    get meta() {
      return structuredClone(meta);
    },
    check: async (identity: WorkflowResumeIdentity) => {
      const result = await checkObservedResume(runId, identity, eligibility, meta);
      return { ...result, status: structuredClone(result.status) };
    },
    prepare: (identity: WorkflowResumeIdentity) =>
      prepareObservedResume(runStore, runId, identity, eligibility, meta),
  });
}

async function checkObservedResume(
  runId: string,
  identity: WorkflowResumeIdentity,
  observed: ResumeCheckResult,
  meta: RunMeta | null,
): Promise<ResumeCheckResult> {
  const eligibility = observed;
  if (!eligibility.canResume) return eligibility;
  const status = eligibility.status;

  // A valid source digest alone is not a formally bound resume identity.
  const storedIdentity: WorkflowIdentityEvidence | undefined = meta
    ? runMetaWorkflowIdentity(meta)
    : undefined;
  if (!isResumeIdentity(identity) || resumeIdentityRuns.get(identity) !== runId) {
    return {
      canResume: false,
      status,
      manifestMatch: false,
      storedIdentity,
      reasonCode: 'IDENTITY_UNVERIFIED',
      reason: `Run ${runId} requires a formally bound full executable SHA-256 identity for this run.`,
    };
  }
  try {
    const comparison = compareStoredWorkflowIdentity(
      meta?.manifestHash,
      identity,
      identity.meta,
      meta?.manifestHashDomain,
    );
    const strong = meta !== null && WORKFLOW_BINDING_HASH_REGEX.test(meta.manifestHash);
    return {
      canResume: comparison.matches,
      status,
      manifestMatch: comparison.matches,
      storedIdentity: comparison.stored,
      currentIdentity: comparison.current,
      reasonCode: comparison.matches ? undefined : 'IDENTITY_UNVERIFIED',
      reason: comparison.matches
        ? undefined
        : !strong
          ? `Run ${runId} uses a legacy weak workflow identity and requires recovery.`
          : 'Manifest hash mismatch: stored workflow identity cannot be verified against the loaded source and route.',
    };
  } catch (cause) {
    return {
      canResume: false,
      status,
      manifestMatch: false,
      storedIdentity,
      cause,
      reasonCode: 'IDENTITY_UNVERIFIED',
      reason: `Run ${runId} has no usable verified workflow identity.`,
    };
  }
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
  identity: WorkflowResumeIdentity,
): Promise<ResumeState> {
  return (await createWorkflowResumePreflight(runStore, runId)).prepare(identity);
}

async function prepareObservedResume(
  runStore: WorkflowRunReadOnlyStore,
  runId: string,
  identity: WorkflowResumeIdentity,
  eligibility: ResumeCheckResult,
  observedMeta: RunMeta | null,
): Promise<ResumeState> {
  // Validate the run is resumable
  const check = await checkObservedResume(runId, identity, eligibility, observedMeta);
  if (!check.canResume) {
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      check.reason ?? `run cannot be resumed automatically`,
      check.cause === undefined ? undefined : { cause: check.cause },
      check.reasonCode,
      { stored: check.storedIdentity, current: check.currentIdentity },
    );
  }

  const manifest = isResumeIdentity(identity) ? identity.meta : identity;

  const meta = structuredClone(observedMeta);
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
