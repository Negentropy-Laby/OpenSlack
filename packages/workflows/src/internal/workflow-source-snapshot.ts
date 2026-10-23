import type { WorkflowMeta } from '../types.js';
import { canonicalJson } from './canonical-json.js';
import { hashWorkflowSource } from './workflow-identity.js';
import {
  hashWorkflowRunnerV2Source,
  hashWorkflowRunnerV2Manifest,
} from '../workflow-runner-v2-descriptor.js';

/** Opaque, process-local evidence. Bytes are privately owned and copied on access. */
export interface WorkflowSourceSnapshot {
  readonly rawHash: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
}
const snapshots = new WeakMap<WorkflowSourceSnapshot, { bytes: Buffer; manifest: string }>();

export type WorkflowSourceEvidenceReason =
  | 'SOURCE_EVIDENCE_MISSING'
  | 'SOURCE_EVIDENCE_UNRECOGNIZED'
  | 'SOURCE_BYTES_MISSING'
  | 'SOURCE_DRIFT'
  | 'MANIFEST_DRIFT'
  | 'MANIFEST_INVALID'
  | 'LOADER_SOURCE_MISMATCH';

/** Safe digest-only diagnostics; ownership of a snapshot does not authenticate a route. */
export class WorkflowSourceEvidenceError extends TypeError {
  readonly code = 'WORKFLOW_SOURCE_EVIDENCE_INVALID' as const;
  constructor(
    readonly reasonCode: WorkflowSourceEvidenceReason,
    message: string,
    readonly identities?: Readonly<{
      domain: 'runner-v2-source' | 'runner-v2-manifest' | 'raw-sha256';
      stored?: string;
      current?: string;
    }>,
  ) {
    super(message);
    this.name = 'WorkflowSourceEvidenceError';
  }
}

/** Unwrap only our typed evidence, including a boundary's typed cause. */
export function workflowSourceEvidenceCause(
  error: unknown,
): WorkflowSourceEvidenceError | undefined {
  if (error instanceof WorkflowSourceEvidenceError) return error;
  return error instanceof Error && error.cause instanceof WorkflowSourceEvidenceError
    ? error.cause
    : undefined;
}

function ownedSnapshot(snapshot: WorkflowSourceSnapshot) {
  const entry = snapshots.get(snapshot);
  if (!entry)
    throw new WorkflowSourceEvidenceError(
      'SOURCE_EVIDENCE_UNRECOGNIZED',
      'Unrecognized workflow source snapshot.',
    );
  return entry;
}

export function createWorkflowSourceSnapshot(
  bytes: Uint8Array,
  manifest: WorkflowMeta,
): WorkflowSourceSnapshot {
  const owned = Buffer.from(bytes);
  const manifestValue = structuredClone(manifest);
  let sourceHash: string | undefined;
  let manifestHash: string | undefined;
  const result = Object.freeze({
    rawHash: hashWorkflowSource(owned),
    get workflowSourceHash() {
      return (sourceHash ??= hashWorkflowRunnerV2Source(owned));
    },
    get manifestHash() {
      return (manifestHash ??= hashWorkflowRunnerV2Manifest(manifestValue));
    },
  });
  snapshots.set(result, { bytes: owned, manifest: canonicalJson(manifest) });
  return result;
}
export function workflowSourceSnapshotBytes(snapshot: WorkflowSourceSnapshot): Uint8Array {
  const entry = ownedSnapshot(snapshot);
  return Buffer.from(entry.bytes);
}

/** Verify manifest integrity without copying source bytes or claiming a disk re-read. */
export function verifyWorkflowSourceManifest(
  snapshot: WorkflowSourceSnapshot,
  manifest: WorkflowMeta,
): WorkflowSourceSnapshot {
  const entry = ownedSnapshot(snapshot);
  if (entry.manifest !== canonicalJson(manifest)) {
    throw new WorkflowSourceEvidenceError(
      'MANIFEST_DRIFT',
      'Workflow source or manifest changed since its snapshot was loaded.',
      {
        domain: 'runner-v2-manifest',
        stored: snapshot.manifestHash,
        current: hashWorkflowRunnerV2Manifest(manifest),
      },
    );
  }
  return snapshot;
}

/** Loaded-module boundaries must never manufacture missing loader evidence. */
export function requireWorkflowSourceSnapshot(
  snapshot: WorkflowSourceSnapshot | undefined,
  bytes: Uint8Array,
  manifest: WorkflowMeta,
): WorkflowSourceSnapshot {
  if (!snapshot)
    throw new WorkflowSourceEvidenceError(
      'SOURCE_EVIDENCE_MISSING',
      'Loaded workflow requires source evidence; reload a supported file workflow.',
    );
  return verifyWorkflowSourceSnapshot(snapshot, bytes, manifest);
}

export function verifyWorkflowSourceSnapshot(
  snapshot: WorkflowSourceSnapshot,
  bytes: Uint8Array,
  manifest: WorkflowMeta,
): WorkflowSourceSnapshot {
  const entry = ownedSnapshot(snapshot);
  if (!(bytes instanceof Uint8Array)) {
    throw new WorkflowSourceEvidenceError(
      'SOURCE_BYTES_MISSING',
      'Workflow source bytes are required.',
    );
  }
  if (!entry.bytes.equals(bytes)) {
    throw new WorkflowSourceEvidenceError(
      'SOURCE_DRIFT',
      'Workflow source or manifest changed since its snapshot was loaded.',
      {
        domain: 'runner-v2-source',
        stored: snapshot.workflowSourceHash,
        current: hashWorkflowRunnerV2Source(bytes),
      },
    );
  }
  return verifyWorkflowSourceManifest(snapshot, manifest);
}
