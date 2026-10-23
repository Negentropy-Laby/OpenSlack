import { types as utilTypes } from 'node:util';
import { WORKFLOW_BINDING_HASH_REGEX } from './workflow-binding-field-rules.js';
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

export const WORKFLOW_SOURCE_EVIDENCE_REASONS = Object.freeze([
  'SOURCE_EVIDENCE_MISSING',
  'SOURCE_EVIDENCE_UNRECOGNIZED',
  'SOURCE_BYTES_MISSING',
  'SOURCE_KIND_UNSUPPORTED',
  'SOURCE_DRIFT',
  'SOURCE_IDENTITY_DRIFT',
  'MANIFEST_DRIFT',
  'MANIFEST_INVALID',
  'LOADER_SOURCE_MISMATCH',
] as const);
export type WorkflowSourceEvidenceReason = (typeof WORKFLOW_SOURCE_EVIDENCE_REASONS)[number];
export const WORKFLOW_SOURCE_EVIDENCE_DOMAINS = Object.freeze([
  'runner-v2-source',
  'runner-v2-manifest',
  'raw-sha256',
] as const);
const manifestDiagnostics = new WeakMap<
  WorkflowSourceEvidenceError,
  { path: string; fields: readonly string[] }
>();
export const WORKFLOW_MANIFEST_DIAGNOSTIC_FIELDS = Object.freeze([
  'name',
  'description',
  'phases',
  'title',
  'detail',
  'version',
  'inputs',
  'permissions',
  'sideEffects',
  'forbidden',
  'budgetPolicy',
] as const);

/** Safe digest-only diagnostics; ownership of a snapshot does not authenticate a route. */
export class WorkflowSourceEvidenceError extends TypeError {
  readonly code = 'WORKFLOW_SOURCE_EVIDENCE_INVALID' as const;
  constructor(
    readonly reasonCode: WorkflowSourceEvidenceReason,
    message: string,
    readonly identities?: Readonly<{
      domain: (typeof WORKFLOW_SOURCE_EVIDENCE_DOMAINS)[number];
      stored?: string;
      current?: string;
    }>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowSourceEvidenceError';
  }
}

/** Frontends share presentation; a typed cause is never expanded into raw exception text. */
export function workflowSourceEvidenceDiagnostic(error: WorkflowSourceEvidenceError) {
  const messages: Record<WorkflowSourceEvidenceReason, string> = {
    SOURCE_EVIDENCE_MISSING: 'Loader source evidence is missing; reload a supported file workflow.',
    SOURCE_EVIDENCE_UNRECOGNIZED: 'Loader source evidence is unrecognized.',
    SOURCE_BYTES_MISSING: 'Workflow source bytes are missing.',
    SOURCE_KIND_UNSUPPORTED:
      'Embedded builtin execution is unsupported without file-loader source evidence; preview or export it.',
    SOURCE_DRIFT: 'Workflow source changed since loading.',
    SOURCE_IDENTITY_DRIFT:
      'Workflow file identity changed even though its source digest is unchanged.',
    MANIFEST_DRIFT: 'Workflow manifest changed since loading.',
    MANIFEST_INVALID: 'Workflow manifest is invalid.',
    LOADER_SOURCE_MISMATCH: 'Loaded workflow does not match its source evidence.',
  };
  const ownValue = (record: unknown, key: string): unknown => {
    if (!record || typeof record !== 'object' || utilTypes.isProxy(record)) return undefined;
    return Object.getOwnPropertyDescriptor(record, key)?.value;
  };
  const rawReason = ownValue(error, 'reasonCode');
  const reason =
    WORKFLOW_SOURCE_EVIDENCE_REASONS.find((value) => value === rawReason) ??
    'SOURCE_EVIDENCE_UNRECOGNIZED';
  const details = manifestDiagnostics.get(error);
  const identities = ownValue(error, 'identities');
  const rawDomain = ownValue(identities, 'domain');
  const domain = WORKFLOW_SOURCE_EVIDENCE_DOMAINS.find((value) => value === rawDomain);
  const safeHash = (value: unknown) =>
    typeof value === 'string' && WORKFLOW_BINDING_HASH_REGEX.test(value) ? value : undefined;
  return {
    code: 'WORKFLOW_SOURCE_EVIDENCE_INVALID' as const,
    reasonCode: reason,
    message: `${messages[reason]}${details ? ` File: ${details.path}${details.fields.length ? `; fields: ${details.fields.join(', ')}` : ''}.` : ''}`,
    identities: domain
      ? {
          domain,
          stored: safeHash(ownValue(identities, 'stored')),
          current: safeHash(ownValue(identities, 'current')),
        }
      : undefined,
  };
}

export function renderWorkflowSourceEvidence(
  error: WorkflowSourceEvidenceError,
  guidance: string,
): string[] {
  const diagnostic = workflowSourceEvidenceDiagnostic(error);
  return [
    `${diagnostic.code} [${diagnostic.reasonCode}]: ${diagnostic.message}`,
    ...(diagnostic.identities ? [JSON.stringify(diagnostic.identities)] : []),
    guidance,
  ];
}

/** Internal loader annotation; raw parser messages are never presentation data. */
export function withWorkflowManifestDiagnostic(
  error: WorkflowSourceEvidenceError,
  path: string,
  fields: readonly string[],
): WorkflowSourceEvidenceError {
  manifestDiagnostics.set(error, {
    path: path.replace(/[\u0000-\u001f\u007f]/gu, '?').slice(0, 512),
    fields: WORKFLOW_MANIFEST_DIAGNOSTIC_FIELDS.filter((field) => fields.includes(field)),
  });
  return error;
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
