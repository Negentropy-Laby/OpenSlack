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
  const entry = snapshots.get(snapshot);
  if (!entry) throw new TypeError('Unrecognized workflow source snapshot.');
  return Buffer.from(entry.bytes);
}
export function verifyWorkflowSourceSnapshot(
  snapshot: WorkflowSourceSnapshot,
  bytes: Uint8Array,
  manifest: WorkflowMeta,
): WorkflowSourceSnapshot {
  const entry = snapshots.get(snapshot);
  if (!entry || !entry.bytes.equals(bytes) || entry.manifest !== canonicalJson(manifest)) {
    throw new TypeError('Workflow source or manifest changed since its snapshot was loaded.');
  }
  return snapshot;
}
