import {
  hashWorkflowRunnerEffect,
  hashWorkflowRunnerDomain,
} from './workflow-runner-descriptor.js';

export interface WorkflowEffectBoundaryIntentInput {
  readonly runId: string;
  readonly operation: string;
  readonly detail: string;
}

export interface WorkflowEffectBoundaryHandle {
  readonly effectId: string;
  readonly effectKind: string;
  readonly effectHash: string;
  readonly capabilityHash: string;
  readonly requiresHumanDecision: boolean;
}

export interface WorkflowEffectBoundaryOutcomeInput {
  readonly status: 'rejected' | 'executed' | 'failed' | 'reconciliation_required';
  readonly evidence: unknown;
}

/**
 * TypeScript owns this boundary. A protocol implementation may durably report
 * intent and outcome, but it cannot decide approval or execute the effect.
 */
export interface WorkflowEffectBoundary {
  intent(input: WorkflowEffectBoundaryIntentInput): Promise<WorkflowEffectBoundaryHandle>;
  outcome(
    handle: WorkflowEffectBoundaryHandle,
    input: WorkflowEffectBoundaryOutcomeInput,
  ): Promise<void>;
}

export interface WorkflowRunnerEffectEventPort {
  emitIntent(handle: WorkflowEffectBoundaryHandle): Promise<void>;
  emitOutcome(input: {
    readonly effectId: string;
    readonly status: WorkflowEffectBoundaryOutcomeInput['status'];
    readonly outcomeHash: string;
  }): Promise<void>;
}

export function createWorkflowRunnerProtocolEffectBoundary(options: {
  readonly port: WorkflowRunnerEffectEventPort;
  readonly requiresHumanDecision: (operation: string) => boolean;
}): WorkflowEffectBoundary {
  return Object.freeze({
    async intent(input: WorkflowEffectBoundaryIntentInput): Promise<WorkflowEffectBoundaryHandle> {
      const effectHash = hashWorkflowRunnerEffect({
        detail: input.detail,
        operation: input.operation,
        runId: input.runId,
      });
      const handle = Object.freeze({
        effectId: `workflow-effect:sha256:${effectHash}`,
        effectKind: input.operation,
        effectHash,
        capabilityHash: hashWorkflowRunnerDomain('effect-capability', input.operation),
        requiresHumanDecision: options.requiresHumanDecision(input.operation),
      });
      await options.port.emitIntent(handle);
      return handle;
    },
    async outcome(
      handle: WorkflowEffectBoundaryHandle,
      input: WorkflowEffectBoundaryOutcomeInput,
    ): Promise<void> {
      const outcomeHash = hashWorkflowRunnerEffect({
        effectId: handle.effectId,
        evidence: input.evidence,
        status: input.status,
      });
      await options.port.emitOutcome({
        effectId: handle.effectId,
        status: input.status,
        outcomeHash,
      });
    },
  });
}
