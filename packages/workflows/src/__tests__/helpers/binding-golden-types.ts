import type { WorkflowRunnerAuthorityBindingOperation } from '../../workflow-runner-authority-binding-contract.js';
type Json = Record<string, unknown>;
export interface ExactVector {
  readonly value: unknown;
  readonly canonicalBytes: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly prepared: {
    readonly schema: string;
    readonly bodyHash: string;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
  };
}

export interface ExchangeVectors {
  readonly stage: ExactVector;
  readonly stageReceipt: ExactVector;
  readonly resolution: ExactVector;
  readonly resolutionReceipt: ExactVector;
}

export interface ControlDeliveryArtifact {
  readonly operation: WorkflowRunnerAuthorityBindingOperation;
  readonly message: unknown;
  readonly receipt: ExactVector;
  readonly budgetSourceResult: unknown | null;
  readonly priorEventDeliveryRef: string | null;
}

export interface Golden {
  readonly sourceLocks: Record<string, string>;
  readonly operationMatrix: Array<{
    operation: WorkflowRunnerAuthorityBindingOperation;
    targetKind: string;
    runnerDelta: { revision: number; generation: number };
    sourceEvidenceState: 'prepared' | 'committed';
    sourcePlane: 'checkpoint_control' | 'effect_v2_sibling' | 'budget_account' | 'resume_control';
    sourceRevisionDelta: number;
    sourceGenerationDelta: number;
    sourceReceiptSchema: string | null;
    authorityReceiptHashAlgorithm:
      | 'binding_receipt_domain_sha256'
      | 'canonical_durable_receipt_sha256'
      | null;
  }>;
  readonly positive: {
    readonly operations: Record<WorkflowRunnerAuthorityBindingOperation, ExchangeVectors>;
    readonly semanticVariants: Record<string, ExchangeVectors>;
    readonly controlDelivery: {
      readonly accepted: Record<WorkflowRunnerAuthorityBindingOperation, ExactVector>;
      readonly reconciliationRequired: ExactVector;
      readonly artifacts: Record<string, ControlDeliveryArtifact>;
      readonly priorEventDeliveries: Record<
        string,
        { readonly message: unknown; readonly receipt: ExactVector }
      >;
      readonly byKind: Record<
        | 'event_receipt'
        | 'budget_authorization'
        | 'effect_authorization'
        | 'resume_offer'
        | 'cancel_request',
        string
      >;
      readonly budgetAuthorization: Record<'reserved' | 'rejected', string>;
      readonly budgetDatabaseReconciliation: {
        readonly message: unknown;
        readonly receipt: ExactVector;
        readonly decision: null;
      };
      readonly messages: {
        readonly accepted: Record<WorkflowRunnerAuthorityBindingOperation, unknown>;
        readonly reconciliationRequired: unknown;
      };
    };
    readonly runtimeAdmission: {
      readonly request: { readonly value: unknown };
      readonly receipt: { readonly value: unknown };
    };
  };
  readonly negative: Array<{
    readonly id: string;
    readonly operation: string;
    readonly input: Json;
    readonly expectedError: { readonly code: string; readonly path: string };
  }>;
}
