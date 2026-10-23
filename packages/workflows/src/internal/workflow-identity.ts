import {
  verifyWorkflowSourceManifest,
  verifyWorkflowSourceSnapshot,
  WorkflowSourceEvidenceError,
  type WorkflowSourceSnapshot,
} from './workflow-source-snapshot.js';
import { createHash } from 'node:crypto';
import type {
  RunResult,
  WorkflowFormat,
  WorkflowMeta,
  WorkflowRuntime,
  WorkflowModule,
  WorkflowIdentity,
  WorkflowIdentityEvidence,
} from '../types.js';
import { canonicalJson } from './canonical-json.js';
import { WORKFLOW_BINDING_HASH_REGEX } from './workflow-binding-field-rules.js';

export interface WorkflowIdentitySource {
  readonly meta: WorkflowMeta;
  readonly hash?: string;
  readonly workflowIdentity?: WorkflowIdentity;
  readonly format?: WorkflowFormat;
  readonly sourceBody?: string;
  readonly preview?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<unknown>;
  readonly run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>;
}

const SHA256 = WORKFLOW_BINDING_HASH_REGEX;

/** Resolve the same strong executable identity for initialize, CLI, and worker resume paths. */
export function resolveWorkflowIdentityHash(
  workflow: WorkflowIdentitySource,
  manifest: WorkflowMeta = workflow.meta,
): string {
  if (workflow.workflowIdentity !== undefined) {
    const proof = boundIdentities.get(workflow);
    if (
      !proof ||
      workflow.workflowIdentity.domain !== 'openslack.workflow-runner.workflow-source.v2' ||
      proof.workflowSourceHash !== workflow.workflowIdentity.digest ||
      proof.rawHash !== workflow.hash
    ) {
      throw new TypeError('Go workflow identity requires verified source evidence.');
    }
    verifyWorkflowSourceManifest(proof, manifest);
    return proof.workflowSourceHash;
  }
  if (workflow.hash !== undefined) {
    if (!SHA256.test(workflow.hash)) {
      throw new TypeError('Workflow identity hash must be a full lowercase SHA-256 digest.');
    }
    return workflow.hash;
  }
  if (workflow.sourceBody !== undefined) return sha256(workflow.sourceBody);

  const previewSource = functionSource(workflow.preview);
  const runSource = functionSource(workflow.run);
  if (previewSource === null && runSource === null) {
    throw new TypeError(
      'Workflow executable identity cannot be derived without source or functions.',
    );
  }
  return sha256(canonicalJson({ manifest, previewSource, runSource }));
}

export function hashWorkflowSource(source: string | Uint8Array): string {
  return sha256(source);
}

function functionSource(
  value: WorkflowIdentitySource['preview'] | WorkflowIdentitySource['run'],
): string | null {
  return value === undefined ? null : Function.prototype.toString.call(value);
}

function sha256(value: string | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof value === 'string') hash.update(value, 'utf8');
  else hash.update(value);
  return hash.digest('hex');
}

const boundIdentities = new WeakMap<WorkflowIdentitySource, WorkflowSourceSnapshot>();

/** Called only after the owning boundary has verified route or descriptor identity. */
export function bindWorkflowSourceIdentity(
  workflow: WorkflowModule,
  bytes: Uint8Array,
  snapshot: WorkflowSourceSnapshot,
): WorkflowModule {
  verifyWorkflowSourceSnapshot(snapshot, bytes, workflow.meta);
  if (workflow.hash !== snapshot.rawHash)
    throw new WorkflowSourceEvidenceError(
      'LOADER_SOURCE_MISMATCH',
      'Loaded workflow differs from source snapshot.',
      { domain: 'raw-sha256', stored: workflow.hash, current: snapshot.rawHash },
    );
  const bound = {
    ...workflow,
    sourceSnapshot: snapshot,
    workflowIdentity: Object.freeze({
      domain: 'openslack.workflow-runner.workflow-source.v2' as const,
      digest: snapshot.workflowSourceHash,
    }),
  };
  boundIdentities.set(bound, snapshot);
  return Object.freeze(bound);
}

/** Decode the legacy storage field without rewriting it or guessing a hash domain. */
export function matchStoredWorkflowIdentity(
  stored: string | undefined,
  workflow: WorkflowIdentitySource,
  manifest: WorkflowMeta = workflow.meta,
  recordedDomain?: WorkflowIdentity['domain'],
): WorkflowIdentity | undefined {
  const comparison = compareStoredWorkflowIdentity(stored, workflow, manifest, recordedDomain);
  return comparison.matches ? (comparison.stored as WorkflowIdentity) : undefined;
}

/** Resolve once against the execution manifest; unknown historical domains stay unknown. */
export function compareStoredWorkflowIdentity(
  stored: string | undefined,
  workflow: WorkflowIdentitySource,
  manifest: WorkflowMeta = workflow.meta,
  recordedDomain?: WorkflowIdentity['domain'],
): { matches: boolean; stored?: WorkflowIdentityEvidence; current: WorkflowIdentityEvidence } {
  const digest = resolveWorkflowIdentityHash(workflow, manifest);
  const proof = boundIdentities.get(workflow);
  const current: WorkflowIdentityEvidence = {
    digest,
    domain: proof
      ? 'openslack.workflow-runner.workflow-source.v2'
      : workflow.hash !== undefined
        ? 'unknown'
        : workflow.sourceBody !== undefined
          ? 'raw-sha256'
          : 'function-source-sha256',
    provenance: proof || workflow.hash === undefined ? 'inferred' : 'unknown',
  };
  const strong = stored !== undefined && SHA256.test(stored);
  const inferred =
    proof && strong
      ? stored === digest
        ? 'openslack.workflow-runner.workflow-source.v2'
        : stored === proof.rawHash
          ? 'raw-sha256'
          : undefined
      : undefined;
  const domain = recordedDomain ?? inferred ?? 'unknown';
  const expected = !proof
    ? undefined
    : domain === 'raw-sha256'
      ? proof.rawHash
      : domain === 'openslack.workflow-runner.workflow-source.v2'
        ? digest
        : undefined;
  return {
    matches: strong && expected !== undefined && stored === expected,
    stored:
      stored === undefined
        ? undefined
        : {
            digest: stored,
            domain,
            provenance:
              recordedDomain !== undefined ? 'recorded' : inferred ? 'inferred' : 'unknown',
          },
    current,
  };
}

export type WorkflowBindingReason =
  | 'RUN_MISMATCH'
  | 'WORKSPACE_MISMATCH'
  | 'WORKFLOW_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'SOURCE_DRIFT'
  | 'MANIFEST_DRIFT'
  | 'INPUT_MISMATCH';
export interface WorkflowBindingIdentity {
  readonly runId?: string;
  readonly workspaceId?: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash?: string;
}
/** Cheap ownership checks precede content checks; callers retain boundary-specific errors. */
export function compareWorkflowBinding(
  expected: Partial<WorkflowBindingIdentity>,
  actual: Partial<WorkflowBindingIdentity>,
): WorkflowBindingReason | undefined {
  const checks = [
    ['runId', 'RUN_MISMATCH'],
    ['workspaceId', 'WORKSPACE_MISMATCH'],
    ['workflowId', 'WORKFLOW_MISMATCH'],
    ['workflowVersion', 'VERSION_MISMATCH'],
    ['workflowSourceHash', 'SOURCE_DRIFT'],
    ['manifestHash', 'MANIFEST_DRIFT'],
    ['inputHash', 'INPUT_MISMATCH'],
  ] as const;
  for (const [key, reason] of checks)
    if (expected[key] !== undefined && expected[key] !== actual[key]) return reason;
  return undefined;
}
