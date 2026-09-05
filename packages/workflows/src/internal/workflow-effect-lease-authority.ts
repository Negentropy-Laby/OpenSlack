import { types as nodeTypes } from 'node:util';
import type {
  WorkflowRunnerEffectIntentMessage,
  WorkflowRunnerEventReceiptMessage,
  WorkflowRunnerPreparedMessage,
} from '../workflow-runner-contract.js';
import type {
  WorkflowEffectBoundary,
  WorkflowEffectBoundaryHandle,
} from '../workflow-runner-effect-boundary.js';

export interface WorkflowEffectIntentPreparation {
  readonly message: WorkflowRunnerEffectIntentMessage;
  readonly prepared: WorkflowRunnerPreparedMessage;
}

export interface WorkflowEffectIntentEvidence extends WorkflowEffectIntentPreparation {
  readonly receipt: WorkflowRunnerEventReceiptMessage;
}

export interface WorkflowEffectLeaseBinding {
  readonly workspaceId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly descriptorExpiresAt: string;
  readonly expectedControlBuildHash: string;
  emitIntent(
    handle: WorkflowEffectBoundaryHandle,
    beforeSend: (preparation: WorkflowEffectIntentPreparation) => Promise<void>,
  ): Promise<WorkflowEffectIntentEvidence>;
}

/** Opaque host capability minted only by an accepted sealed v2 worker lease. */
export interface WorkflowEffectLeaseAuthority {
  readonly kind: 'accepted_workflow_effect_lease';
}

const AUTHORITIES = new WeakMap<object, WorkflowEffectLeaseBinding>();
const BOUNDARIES = new WeakMap<object, WorkflowEffectLeaseAuthority>();
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;

function canonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateBinding(value: WorkflowEffectLeaseBinding): WorkflowEffectLeaseBinding {
  if (
    !value ||
    typeof value !== 'object' ||
    nodeTypes.isProxy(value) ||
    ![
      value.workspaceId,
      value.runId,
      value.correlationId,
      value.workflowId,
      value.workflowVersion,
    ].every((entry) => typeof entry === 'string' && SAFE_ID.test(entry)) ||
    ![
      value.workflowSourceHash,
      value.manifestHash,
      value.inputHash,
      value.expectedControlBuildHash,
    ].every((entry) => typeof entry === 'string' && HASH.test(entry)) ||
    !canonicalTimestamp(value.descriptorExpiresAt) ||
    typeof value.emitIntent !== 'function' ||
    nodeTypes.isProxy(value.emitIntent)
  ) {
    throw new TypeError('Workflow effect lease binding is invalid.');
  }
  return Object.freeze({ ...value });
}

export function createWorkflowEffectLeaseAuthority(
  binding: WorkflowEffectLeaseBinding,
): WorkflowEffectLeaseAuthority {
  const authority = Object.freeze({ kind: 'accepted_workflow_effect_lease' as const });
  AUTHORITIES.set(authority, validateBinding(binding));
  return authority;
}

export function bindWorkflowEffectBoundaryToLease(
  boundary: WorkflowEffectBoundary,
  authority: WorkflowEffectLeaseAuthority,
): void {
  workflowEffectLeaseBindingFromAuthority(authority);
  if (!boundary || typeof boundary !== 'object' || nodeTypes.isProxy(boundary)) {
    throw new TypeError('Workflow effect boundary is invalid.');
  }
  if (BOUNDARIES.has(boundary)) {
    throw new TypeError('Workflow effect boundary is already bound to an accepted lease.');
  }
  BOUNDARIES.set(boundary, authority);
}

export function workflowEffectLeaseAuthorityFromBoundary(
  boundary: WorkflowEffectBoundary,
): WorkflowEffectLeaseAuthority {
  if (!boundary || typeof boundary !== 'object' || nodeTypes.isProxy(boundary)) {
    throw new TypeError('Workflow effect boundary is invalid.');
  }
  const authority = BOUNDARIES.get(boundary);
  if (!authority) {
    throw new TypeError('Workflow effect boundary is not bound to an accepted runner lease.');
  }
  return authority;
}

export function workflowEffectLeaseBindingFromAuthority(
  authority: WorkflowEffectLeaseAuthority,
): WorkflowEffectLeaseBinding {
  if (!authority || typeof authority !== 'object' || nodeTypes.isProxy(authority)) {
    throw new TypeError('Workflow effect lease authority is invalid.');
  }
  const binding = AUTHORITIES.get(authority);
  if (!binding) {
    throw new TypeError('Workflow effect lease authority is not host-minted.');
  }
  return binding;
}
