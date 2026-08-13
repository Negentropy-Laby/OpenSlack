import { types as nodeTypes } from 'node:util';
import type { WorkflowEffectBoundaryHandle } from '../workflow-runner-effect-boundary.js';

export class WorkflowEffectApprovalPendingError extends Error {
  readonly code = 'WORKFLOW_EFFECT_APPROVAL_PENDING' as const;

  constructor(
    readonly runId: string,
    readonly approvalId: string,
  ) {
    super(`Workflow effect ${approvalId} is awaiting an exact v2 human decision.`);
    this.name = 'WorkflowEffectApprovalPendingError';
  }
}

export class WorkflowEffectAuthorizationRequiredError extends Error {
  readonly code = 'WORKFLOW_EFFECT_AUTHORIZATION_REQUIRED' as const;

  constructor(readonly operation: string) {
    super(`Workflow effect ${operation} requires the authenticated TypeScript authorization path.`);
    this.name = 'WorkflowEffectAuthorizationRequiredError';
  }
}

export class WorkflowEffectAuthorizationRejectedError extends Error {
  readonly code = 'WORKFLOW_EFFECT_AUTHORIZATION_REJECTED' as const;

  constructor(
    readonly approvalId: string,
    readonly approvalDecisionHash: string,
  ) {
    super(`Workflow effect ${approvalId} was rejected by its exact v2 human decision.`);
    this.name = 'WorkflowEffectAuthorizationRejectedError';
  }
}

export class WorkflowEffectReconciliationRequiredError extends Error {
  readonly code = 'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkflowEffectReconciliationRequiredError';
  }
}

export interface WorkflowEffectPreparedAuthorization {
  readonly kind: 'workflow_effect_prepared_authorization';
  readonly handle: WorkflowEffectBoundaryHandle;
}

export interface WorkflowEffectClaimAuthorization {
  readonly kind: 'workflow_effect_claim_authorization';
  readonly executionId: string;
}

export type WorkflowEffectAuthorizationDisposition =
  | {
      readonly disposition: 'claimed';
      readonly authority: WorkflowEffectClaimAuthorization;
      readonly executionId: string;
    }
  | {
      readonly disposition: 'replay';
      readonly value: unknown;
      readonly executionId: string;
      readonly outcomeHash: string;
    };

export interface WorkflowEffectAuthorizationPort {
  prepare(input: {
    readonly runId: string;
    readonly evaluationIndex: number;
    readonly operation: string;
    readonly detail: string;
  }): Promise<WorkflowEffectPreparedAuthorization>;
  authorize(
    prepared: WorkflowEffectPreparedAuthorization,
    signal?: AbortSignal,
  ): Promise<WorkflowEffectAuthorizationDisposition>;
  complete(
    authority: WorkflowEffectClaimAuthorization,
    value: unknown,
  ): Promise<{ readonly outcomeHash: string }>;
  reconcile(authority: WorkflowEffectClaimAuthorization, causeCode: string): Promise<void>;
}

const PORTS = new WeakSet<object>();

/** Module-private composition seam; this file is not a public package export. */
export function registerWorkflowEffectAuthorizationPort(
  value: WorkflowEffectAuthorizationPort,
): void {
  PORTS.add(value);
}

export function assertWorkflowEffectAuthorizationPort(
  value: WorkflowEffectAuthorizationPort,
): WorkflowEffectAuthorizationPort {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || !PORTS.has(value)) {
    throw new TypeError('Workflow effect authorization port is not host-minted.');
  }
  return value;
}
