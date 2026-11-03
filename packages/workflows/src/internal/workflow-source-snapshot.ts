import { types as utilTypes } from 'node:util';
import { WORKFLOW_IDENTITY, type WorkflowIdentityEvidence } from '@openslack/core';
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

/** A freshly computed owned snapshot is inferred evidence, not a persisted record. */
export function snapshotWorkflowIdentity(
  snapshot: WorkflowSourceSnapshot,
): WorkflowIdentityEvidence {
  if (!snapshots.has(snapshot))
    throw new WorkflowSourceEvidenceError(
      'SOURCE_EVIDENCE_UNRECOGNIZED',
      'Cannot project an unrecognized workflow snapshot.',
    );
  return Object.freeze({
    digest: snapshot.workflowSourceHash,
    domain: WORKFLOW_IDENTITY.SOURCE_V2,
    provenance: 'inferred',
  });
}

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

/** Never invoke Proxy traps or accessors while inspecting diagnostic data. */
export function workflowDiagnosticOwnValue(record: unknown, key: string): unknown {
  if (!record || typeof record !== 'object' || utilTypes.isProxy(record)) return undefined;
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

/** Equivalent to a bounded prototype check, stopping before every Proxy in the chain. */
export function workflowDiagnosticHasPrototype(value: unknown, expected: object): boolean {
  let current = value;
  for (let depth = 0; depth < 64; depth++) {
    if (!current || typeof current !== 'object' || utilTypes.isProxy(current)) return false;
    if (current === expected) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}

/** Shared digest-only projection. Stderr callers deliberately omit frontend messages. */
export function workflowSourceEvidenceProjection(error: unknown) {
  if (!workflowDiagnosticHasPrototype(error, WorkflowSourceEvidenceError.prototype))
    return undefined;
  const rawReason = workflowDiagnosticOwnValue(error, 'reasonCode');
  const reason =
    WORKFLOW_SOURCE_EVIDENCE_REASONS.find((value) => value === rawReason) ??
    'SOURCE_EVIDENCE_UNRECOGNIZED';
  const identities = workflowDiagnosticOwnValue(error, 'identities');
  const rawDomain = workflowDiagnosticOwnValue(identities, 'domain');
  const domain = WORKFLOW_SOURCE_EVIDENCE_DOMAINS.find((value) => value === rawDomain);
  const safeHash = (value: unknown) =>
    typeof value === 'string' && WORKFLOW_BINDING_HASH_REGEX.test(value) ? value : undefined;
  return {
    code: 'WORKFLOW_SOURCE_EVIDENCE_INVALID' as const,
    reasonCode: reason,
    identities: domain
      ? {
          domain,
          stored: safeHash(workflowDiagnosticOwnValue(identities, 'stored')),
          current: safeHash(workflowDiagnosticOwnValue(identities, 'current')),
        }
      : undefined,
  };
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
  const projection = workflowSourceEvidenceProjection(error) ?? {
    code: 'WORKFLOW_SOURCE_EVIDENCE_INVALID' as const,
    reasonCode: 'SOURCE_EVIDENCE_UNRECOGNIZED' as const,
    identities: undefined,
  };
  const reason = projection.reasonCode;
  const details = manifestDiagnostics.get(error);
  return {
    ...projection,
    message: `${messages[reason]}${details ? ` File: ${details.path}${details.fields.length ? `; fields: ${details.fields.join(', ')}` : ''}.` : ''}`,
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
export function sanitizeWorkflowDiagnosticPath(path: string): string {
  let result = '';
  for (const scalar of path) {
    const code = scalar.codePointAt(0)!;
    const safe =
      code < 32 || (code >= 127 && code <= 159)
        ? '?'
        : code >= 0xd800 && code <= 0xdfff
          ? '\ufffd'
          : scalar;
    if (result.length + safe.length > 512) break;
    result += safe;
  }
  return result;
}

export function withWorkflowManifestDiagnostic(
  error: WorkflowSourceEvidenceError,
  path: string,
  fields: readonly string[],
): WorkflowSourceEvidenceError {
  manifestDiagnostics.set(error, {
    path: sanitizeWorkflowDiagnosticPath(path),
    fields: WORKFLOW_MANIFEST_DIAGNOSTIC_FIELDS.filter((field) => fields.includes(field)),
  });
  return error;
}

/** Unwrap only our typed evidence, including a boundary's typed cause. */
export function workflowSourceEvidenceCause(
  error: unknown,
): WorkflowSourceEvidenceError | undefined {
  if (workflowDiagnosticHasPrototype(error, WorkflowSourceEvidenceError.prototype))
    return error as WorkflowSourceEvidenceError;
  if (!workflowDiagnosticHasPrototype(error, Error.prototype)) return undefined;
  const cause = workflowDiagnosticOwnValue(error, 'cause');
  return workflowDiagnosticHasPrototype(cause, WorkflowSourceEvidenceError.prototype)
    ? (cause as WorkflowSourceEvidenceError)
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
