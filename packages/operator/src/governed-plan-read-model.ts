import {
  validateGovernedPlanRecord,
  type GovernedPlanRecord,
  type GovernedPlanState,
} from './governed-plan.js';
import { isGovernedPlanExecutionTerminal } from './governed-plan-store.js';

export interface GovernedPlanExecutionReadModel {
  readonly executionId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcomeCount: number;
  readonly evidenceRefCount: number;
  readonly blocker?: string;
  readonly failure?: string;
}

export interface GovernedPlanReadModel {
  readonly schema: 'openslack.governed_plan_read_model.v1';
  readonly planId: string;
  readonly revision: number;
  readonly state: GovernedPlanState;
  readonly kind: string;
  readonly goal: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly actionCount: number;
  readonly effectCount: number;
  readonly inputHash: string;
  readonly planHash: string;
  readonly confirmationBound: true;
  readonly executionTerminal: boolean;
  readonly final: boolean;
  readonly reconciliationRequired: boolean;
  readonly execution?: GovernedPlanExecutionReadModel;
}

function isFinal(state: GovernedPlanState): boolean {
  return state !== 'pending' && state !== 'executing';
}

export function projectGovernedPlanReadModel(value: unknown): GovernedPlanReadModel {
  const record: GovernedPlanRecord = validateGovernedPlanRecord(value);
  const execution = record.execution;
  const executionProjection =
    execution === undefined
      ? undefined
      : Object.freeze({
          executionId: execution.executionId,
          startedAt: execution.startedAt,
          ...(execution.completedAt === undefined ? {} : { completedAt: execution.completedAt }),
          outcomeCount: execution.outcomes.length,
          evidenceRefCount: execution.outcomes.reduce(
            (total, outcome) => total + outcome.evidenceRefs.length,
            0,
          ),
          ...(execution.blocker === undefined ? {} : { blocker: execution.blocker }),
          ...(execution.failure === undefined ? {} : { failure: execution.failure }),
        });
  return Object.freeze({
    schema: 'openslack.governed_plan_read_model.v1',
    planId: record.planId,
    revision: record.revision,
    state: record.state,
    kind: record.canonicalPlan.kind,
    goal: record.canonicalPlan.goal,
    actorId: record.bindings.actorId,
    workspaceId: record.bindings.workspaceId,
    correlationId: record.bindings.correlationId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    actionCount: record.canonicalPlan.actions.length,
    effectCount: record.canonicalPlan.effects.length,
    inputHash: record.bindings.inputHash,
    planHash: record.bindings.planHash,
    confirmationBound: true,
    executionTerminal: isGovernedPlanExecutionTerminal(record.state),
    final: isFinal(record.state),
    reconciliationRequired: record.state === 'reconciliation_required',
    ...(executionProjection === undefined ? {} : { execution: executionProjection }),
  });
}
