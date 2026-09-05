import type { WorkflowControlAuthorityMessage } from './workflow-control-authority-contract.js';
import {
  hashWorkflowRunnerAuthorityBindingEvidence,
  validateWorkflowRunnerBudgetSourceResult,
  workflowRunnerAuthorityBindingMissingProviderUsageHash,
  type WorkflowRunnerAuthorityBindingOperation,
  type WorkflowRunnerAuthorityEvidence,
  type WorkflowRunnerAuthorityResolutionReceipt,
  type WorkflowRunnerAuthorityStageReceipt,
  type WorkflowRunnerBudgetSourceResult,
} from './workflow-runner-authority-binding-contract.js';
import {
  parseWorkflowBudgetAuthorityBytes,
  validateWorkflowBudgetPreparedRequest,
  type WorkflowBudgetPreparedRequest,
  type WorkflowBudgetReserveRequest,
  type WorkflowBudgetSettlementRequest,
} from './workflow-budget-authority-contract.js';
import type { WorkflowRunnerAuthorityBindingStage } from './workflow-runner-authority-binding-contract.js';
import type {
  WorkflowRunnerAuthoritySourceAdapter,
  WorkflowRunnerAuthoritySourceProbe,
} from './workflow-runner-authority-binding-runtime.js';
import type { WorkflowRunnerV2AuthoritySourceResolver } from './workflow-runner-v2-runtime-delivery.js';

export type WorkflowRunnerDurableAuthorityPointRead = (
  stage: WorkflowRunnerAuthorityBindingStage,
  signal?: AbortSignal,
) => Promise<WorkflowRunnerAuthoritySourceProbe>;

export interface WorkflowRunnerDurableAuthorityMutationPort {
  pointRead: WorkflowRunnerDurableAuthorityPointRead;
  commit(
    stage: WorkflowRunnerAuthorityBindingStage,
    stageReceipt: WorkflowRunnerAuthorityStageReceipt,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityEvidence>;
}

function exactEvidence(
  operation: WorkflowRunnerAuthorityBindingOperation,
  evidence: WorkflowRunnerAuthorityEvidence,
): WorkflowRunnerAuthorityEvidence {
  hashWorkflowRunnerAuthorityBindingEvidence(evidence, operation);
  return evidence;
}

function createCommittedAuthorityAdapter(
  operation: WorkflowRunnerAuthorityBindingOperation,
  port: WorkflowRunnerDurableAuthorityMutationPort,
): WorkflowRunnerAuthoritySourceAdapter {
  return Object.freeze({
    async probe(stage: WorkflowRunnerAuthorityBindingStage, signal?: AbortSignal) {
      if (stage.operation !== operation) throw new Error('Authority source operation drifted.');
      const result = await port.pointRead(stage, signal);
      return result.state === 'committed'
        ? { ...result, evidence: exactEvidence(operation, result.evidence) }
        : result;
    },
    async commit(
      stage: WorkflowRunnerAuthorityBindingStage,
      stageReceipt: WorkflowRunnerAuthorityStageReceipt,
      signal?: AbortSignal,
    ) {
      if (stage.operation !== operation) throw new Error('Authority source operation drifted.');
      return exactEvidence(operation, await port.commit(stage, stageReceipt, signal));
    },
  });
}

/** C checkpoint adapter: exact commit evidence is point-read before any mutation. */
export function createWorkflowRunnerCheckpointSourceAdapter(
  port: WorkflowRunnerDurableAuthorityMutationPort,
): WorkflowRunnerAuthoritySourceAdapter {
  return createCommittedAuthorityAdapter('checkpoint_commit', port);
}

/** D effect adapter: authorize claim and completion outcome remain distinct siblings. */
export function createWorkflowRunnerEffectSourceAdapter(
  operation: 'effect_authorize' | 'effect_complete',
  port: WorkflowRunnerDurableAuthorityMutationPort,
): WorkflowRunnerAuthoritySourceAdapter {
  return createCommittedAuthorityAdapter(operation, port);
}

/** C resume adapter: generation advancement is never inferred from descriptor generation alone. */
export function createWorkflowRunnerResumeSourceAdapter(
  port: WorkflowRunnerDurableAuthorityMutationPort,
): WorkflowRunnerAuthoritySourceAdapter {
  return createCommittedAuthorityAdapter('resume_advance', port);
}

export interface WorkflowRunnerBudgetE2Port {
  pointRead(
    stage: WorkflowRunnerAuthorityBindingStage,
    resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt,
    signal?: AbortSignal,
  ): Promise<
    | { readonly state: 'not_committed' }
    | { readonly state: 'unknown'; readonly reason: string }
    | {
        readonly state: 'committed';
        readonly budgetSourceResult?: WorkflowRunnerBudgetSourceResult;
      }
  >;
  mutate(
    stage: WorkflowRunnerAuthorityBindingStage,
    resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerBudgetSourceResult | undefined>;
}

/**
 * E adapter. E1 prepared evidence is immutable and available before resolve;
 * E2 reserve/settle runs only after the accepted resolution. Reserve yields the
 * exact durable result used by the later decision ACK; settle must yield none.
 */
export function createWorkflowRunnerBudgetSourceAdapter(options: {
  readonly operation: 'budget_reserve' | 'budget_settle';
  readonly preparedEvidence: WorkflowRunnerAuthorityEvidence;
  readonly e2: WorkflowRunnerBudgetE2Port;
}): WorkflowRunnerAuthoritySourceAdapter {
  const evidence = exactEvidence(options.operation, options.preparedEvidence);
  if (evidence.schema !== 'openslack.workflow_runner_budget_authority_evidence.v1') {
    throw new Error('Budget adapter requires exact prepared E1 evidence.');
  }
  return Object.freeze({
    async probe(stage: WorkflowRunnerAuthorityBindingStage) {
      if (stage.operation !== options.operation)
        throw new Error('Budget source operation drifted.');
      return { state: 'committed' as const, evidence };
    },
    async commit() {
      throw new Error(
        'Prepared budget evidence cannot be mutated during the pre-resolution phase.',
      );
    },
    async probePostResolution(
      stage: WorkflowRunnerAuthorityBindingStage,
      resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt,
      signal?: AbortSignal,
    ) {
      const result = await options.e2.pointRead(stage, resolutionReceipt, signal);
      if (result.state !== 'committed') return result;
      if (options.operation === 'budget_settle' && result.budgetSourceResult !== undefined) {
        throw new Error('Budget settlement cannot expose a reserve-only source result.');
      }
      if (options.operation === 'budget_reserve') {
        if (!result.budgetSourceResult) {
          throw new Error('Budget reserve point-read omitted its durable source result.');
        }
        return {
          state: 'committed' as const,
          budgetSourceResult: validateWorkflowRunnerBudgetSourceResult(
            result.budgetSourceResult,
            evidence.preparedRequest,
          ),
        };
      }
      return { state: 'committed' as const };
    },
    async commitPostResolution(
      stage: WorkflowRunnerAuthorityBindingStage,
      resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt,
      signal?: AbortSignal,
    ) {
      const result = await options.e2.mutate(stage, resolutionReceipt, signal);
      if (options.operation === 'budget_settle') {
        if (result !== undefined) {
          throw new Error('Budget settlement cannot expose a reserve-only source result.');
        }
        return undefined;
      }
      if (!result) throw new Error('Budget reserve mutation omitted its durable source result.');
      return validateWorkflowRunnerBudgetSourceResult(result, evidence.preparedRequest);
    },
  });
}

/**
 * Builds the closed F2a E1 evidence from one exact E2 prepared request. The
 * provider/model/run/attempt/account/policy/rate identities are parsed from the
 * immutable prepared bytes rather than copied from a reduced runner event.
 */
export function createWorkflowRunnerPreparedBudgetSourceAdapter(options: {
  readonly operation: 'budget_reserve' | 'budget_settle';
  readonly preparedRequest: WorkflowBudgetPreparedRequest;
  readonly resumeGeneration: number;
  readonly e2: WorkflowRunnerBudgetE2Port;
}): WorkflowRunnerAuthoritySourceAdapter {
  const preparedRequest = validateWorkflowBudgetPreparedRequest(options.preparedRequest);
  const expectedOperation = options.operation === 'budget_reserve' ? 'reserve' : 'settle';
  if (preparedRequest.operation !== expectedOperation) {
    throw new Error('Budget prepared operation differs from its F2b binding operation.');
  }
  const request = parseWorkflowBudgetAuthorityBytes(Buffer.from(preparedRequest.body, 'utf8')) as
    | WorkflowBudgetReserveRequest
    | WorkflowBudgetSettlementRequest;
  const settlement =
    options.operation === 'budget_settle'
      ? (request as WorkflowBudgetSettlementRequest)
      : undefined;
  const providerUsageReceiptHash = settlement
    ? (settlement.providerUsage?.receiptHash ??
      settlement.usageReceiptHash ??
      workflowRunnerAuthorityBindingMissingProviderUsageHash(preparedRequest.requestHash))
    : null;
  return createWorkflowRunnerBudgetSourceAdapter({
    operation: options.operation,
    preparedEvidence: {
      schema: 'openslack.workflow_runner_budget_authority_evidence.v1',
      sourceAuthority: {
        plane: 'budget_account',
        evidenceState: 'prepared',
        expectedRevision: request.expectedAccountRevision,
        acceptedRevision: null,
        expectedResumeGeneration: options.resumeGeneration,
        acceptedResumeGeneration: options.resumeGeneration,
        requestHash: preparedRequest.requestHash,
        receiptSchema: null,
        receiptHash: null,
        recordHash: null,
        authorityBuildHash: request.route.authorityBuildHash,
      },
      preparedRequest,
      providerHash: request.expectedProviderHash,
      modelHash: request.expectedModelHash,
      providerRunHash: request.expectedProviderRunHash,
      providerAttempt: request.providerAttempt,
      accountId: request.accountId,
      policyHash: request.policyHash,
      rateNanoUsdPerToken: request.rateNanoUsdPerToken,
      providerUsageReceiptHash,
    },
    e2: options.e2,
  });
}

export interface WorkflowRunnerV2AuthoritySourceFactories {
  checkpoint(
    target: WorkflowControlAuthorityMessage,
  ): Promise<WorkflowRunnerAuthoritySourceAdapter>;
  effect(
    operation: 'effect_authorize' | 'effect_complete',
    target: WorkflowControlAuthorityMessage,
  ): Promise<WorkflowRunnerAuthoritySourceAdapter>;
  budget(
    operation: 'budget_reserve' | 'budget_settle',
    target: WorkflowControlAuthorityMessage,
  ): Promise<WorkflowRunnerAuthoritySourceAdapter>;
  resume(target: WorkflowControlAuthorityMessage): Promise<WorkflowRunnerAuthoritySourceAdapter>;
}

/** Closed six-operation resolver used by the production v2 runtime composition. */
export class WorkflowRunnerV2AuthoritySources implements WorkflowRunnerV2AuthoritySourceResolver {
  readonly #factories: WorkflowRunnerV2AuthoritySourceFactories;

  constructor(factories: WorkflowRunnerV2AuthoritySourceFactories) {
    this.#factories = factories;
  }

  resolve(
    operation: WorkflowRunnerAuthorityBindingOperation,
    target: WorkflowControlAuthorityMessage,
  ): Promise<WorkflowRunnerAuthoritySourceAdapter> {
    switch (operation) {
      case 'checkpoint_commit':
        return this.#factories.checkpoint(target);
      case 'effect_authorize':
      case 'effect_complete':
        return this.#factories.effect(operation, target);
      case 'budget_reserve':
      case 'budget_settle':
        return this.#factories.budget(operation, target);
      case 'resume_advance':
        return this.#factories.resume(target);
    }
  }
}
