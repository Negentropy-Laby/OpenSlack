import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  createCanonicalGovernedPlan,
  GOVERNED_EXECUTION_STATUSES,
  GOVERNED_PLAN_CONTRACT_ERROR_CODES,
  GOVERNED_PLAN_CONTRACT_LIMITS,
  GOVERNED_PLAN_STATES,
  hashGovernedValue,
  hashOpaqueValue,
  validateGovernedPlanRecord,
} from '../governed-plan.js';
import { projectGovernedPlanReadModel } from '../governed-plan-read-model.js';
import {
  GOVERNED_PLAN_STATE_TRANSITIONS,
  canGovernedPlanStateTransition,
  GOVERNED_PLAN_STORE_ALGORITHMS,
  GOVERNED_PLAN_STORE_ERROR_CODES,
  GOVERNED_PLAN_STORE_LIMITS,
} from '../governed-plan-store.js';
import {
  GOVERNED_PLAN_AUDIT_EVENT_TYPES,
  GOVERNED_PLAN_SERVICE_ERROR_CODES,
  GOVERNED_PLAN_SERVICE_LIMITS,
} from '../governed-plan-service.js';

function record() {
  const plan = createCanonicalGovernedPlan({
    kind: 'scenario.instantiate',
    goal: 'Instantiate governed scenario',
    input: { scenarioId: 'contract-to-delivery-lite' },
    actions: [
      { actionId: 'scenario.instantiate', input: { scenarioId: 'contract-to-delivery-lite' } },
    ],
    effects: [{ type: 'scenario.instance', summary: 'Create instance', risk: 'medium' }],
  });
  return validateGovernedPlanRecord({
    schema: 'openslack.governed_plan.v1',
    revision: 1,
    planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
    state: 'pending',
    createdAt: '2026-08-02T06:00:00.000Z',
    updatedAt: '2026-08-02T06:00:00.000Z',
    expiresAt: '2026-08-02T06:15:00.000Z',
    canonicalPlan: plan,
    bindings: {
      actorId: 'qoder.local',
      workspaceId: 'workspace.demo',
      correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174000',
      inputHash: hashGovernedValue(plan.input),
      planHash: hashGovernedValue(plan),
      sourceVersionHash: hashGovernedValue({ github: 'abc' }),
      permissionSnapshotHash: hashGovernedValue({ allowed: true }),
      actionCatalogHash: hashGovernedValue(['scenario.instantiate']),
      executorBindingHash: hashGovernedValue(['scenario.instantiate@v1']),
      buildNonceHash: hashOpaqueValue('build-nonce-0123456789'),
      processNonceHash: hashOpaqueValue('process-nonce-0123456789'),
    },
    confirmationTokenHash: hashOpaqueValue('confirmation-token-0123456789'),
  });
}

describe('governed plan GS4 contract freeze', () => {
  it('projects a deeply frozen credential-free read model', () => {
    const projected = projectGovernedPlanReadModel(record());
    const serialized = JSON.stringify(projected);

    expect(projected).toMatchObject({
      schema: 'openslack.governed_plan_read_model.v1',
      state: 'pending',
      actionCount: 1,
      effectCount: 1,
      confirmationBound: true,
      final: false,
    });
    expect(Object.isFrozen(projected)).toBe(true);
    for (const forbidden of [
      'confirmationTokenHash',
      'sourceVersionHash',
      'permissionSnapshotHash',
      'actionCatalogHash',
      'executorBindingHash',
      'buildNonceHash',
      'processNonceHash',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('keeps the generated manifest aligned to exported runtime constants', () => {
    const manifestPath = new URL('../../contracts/governed-plan/v1/manifest.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      authority: string;
      authorityBoundary: {
        writer: string;
        goRole: string;
        runtimeStore: string;
        memoryBankIsRuntimeStore: boolean;
      };
      states: unknown;
      executionStatuses: unknown;
      stateTransitions: unknown;
      schemaScope: string;
      semanticValidationRequired: boolean;
      semanticConstraints: unknown;
      auditEventTypes: unknown;
      limits: { contract: unknown; store: unknown; service: unknown };
      errorCodes: { contract: unknown; store: unknown; service: unknown };
    };

    expect(manifest.authority).toBe('typescript');
    expect(manifest.authorityBoundary).toEqual({
      writer: '@openslack/operator',
      goRole: 'credential-free-read-model-only',
      runtimeStore: '.openslack.local/operator/governed-plans',
      memoryBankIsRuntimeStore: false,
    });
    expect(manifest.states).toEqual(GOVERNED_PLAN_STATES);
    expect(manifest.executionStatuses).toEqual(GOVERNED_EXECUTION_STATUSES);
    expect(manifest.schemaScope).toBe('structural-prefilter');
    expect(manifest.semanticValidationRequired).toBe(true);
    expect(manifest.semanticConstraints).toEqual(expect.arrayContaining(['utf8-byte-limits']));
    expect(manifest.stateTransitions).toEqual(GOVERNED_PLAN_STATE_TRANSITIONS);
    for (const from of GOVERNED_PLAN_STATES) {
      for (const to of GOVERNED_PLAN_STATES) {
        expect(canGovernedPlanStateTransition(from, to)).toBe(
          (GOVERNED_PLAN_STATE_TRANSITIONS[from] as readonly string[]).includes(to),
        );
      }
    }
    expect(manifest.auditEventTypes).toEqual(GOVERNED_PLAN_AUDIT_EVENT_TYPES);
    expect(manifest.limits).toEqual({
      contract: GOVERNED_PLAN_CONTRACT_LIMITS,
      store: GOVERNED_PLAN_STORE_LIMITS,
      service: GOVERNED_PLAN_SERVICE_LIMITS,
    });
    expect(manifest.errorCodes).toEqual({
      contract: GOVERNED_PLAN_CONTRACT_ERROR_CODES,
      store: GOVERNED_PLAN_STORE_ERROR_CODES,
      service: GOVERNED_PLAN_SERVICE_ERROR_CODES,
    });
    expect((manifest as { algorithms?: unknown }).algorithms).toEqual(
      expect.objectContaining(GOVERNED_PLAN_STORE_ALGORITHMS),
    );
  });

  it('compiles every closed schema in strict mode and accepts the authority vectors', () => {
    const contractRoot = new URL('../../contracts/governed-plan/v1/', import.meta.url);
    const readJson = (relativePath: string): object =>
      JSON.parse(readFileSync(new URL(relativePath, contractRoot), 'utf8')) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const actionPlan = ajv.compile(readJson('schemas/governed-action-plan.v1.schema.json'));
    const recordSchema = ajv.compile(readJson('schemas/governed-plan.v1.schema.json'));
    const auditSchema = ajv.compile(readJson('schemas/governed-plan-audit.v1.schema.json'));
    const readModel = ajv.compile(readJson('schemas/governed-plan-read-model.v1.schema.json'));
    const vectors = readJson('golden-vectors.json') as {
      cases: readonly {
        operation: string;
        input: { record?: unknown };
        expected?: { readModel?: unknown };
      }[];
    };

    const validCases = vectors.cases.filter(
      (testCase) => testCase.operation === 'validate_project_record',
    );
    expect(validCases).toHaveLength(9);
    for (const testCase of validCases) {
      const candidate = testCase.input.record;
      expect(recordSchema(candidate), JSON.stringify(recordSchema.errors)).toBe(true);
      expect(validateGovernedPlanRecord(candidate).state).toBe(
        (candidate as { state: string }).state,
      );
      expect(
        actionPlan((candidate as { canonicalPlan: unknown }).canonicalPlan),
        JSON.stringify(actionPlan.errors),
      ).toBe(true);
      expect(readModel(testCase.expected?.readModel), JSON.stringify(readModel.errors)).toBe(true);
    }
    for (const type of GOVERNED_PLAN_AUDIT_EVENT_TYPES) {
      expect(
        auditSchema({
          schema: 'openslack.governed_plan_audit.v1',
          eventId: 'GAUDIT-123e4567-e89b-42d3-a456-426614174000',
          type,
          occurredAt: '2026-08-02T06:00:00.000Z',
          planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
          kind: 'scenario.instantiate',
          actorId: 'qoder.local',
          workspaceId: 'workspace.demo',
          correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174000',
          state: 'pending',
          revision: 1,
          evidenceRefs: [],
        }),
        JSON.stringify(auditSchema.errors),
      ).toBe(true);
    }

    const valid = record();
    for (const status of GOVERNED_EXECUTION_STATUSES) {
      expect(
        validateGovernedPlanRecord({
          ...valid,
          revision: 3,
          state: 'succeeded',
          execution: {
            executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174000',
            ownerPid: 42,
            startedAt: '2026-08-02T06:01:00.000Z',
            completedAt: '2026-08-02T06:02:00.000Z',
            outcomes: [
              {
                actionId: 'scenario.instantiate',
                status,
                summary: 'Frozen execution status',
                evidenceRefs: [],
              },
            ],
          },
        }).execution?.outcomes[0]?.status,
      ).toBe(status);
    }
    expect(() => validateGovernedPlanRecord({ ...valid, state: 'not-a-governed-state' })).toThrow(
      'state is invalid',
    );
    expect(() =>
      validateGovernedPlanRecord({
        ...valid,
        revision: 3,
        state: 'succeeded',
        execution: {
          executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174000',
          ownerPid: 42,
          startedAt: '2026-08-02T06:01:00.000Z',
          completedAt: '2026-08-02T06:02:00.000Z',
          outcomes: [
            {
              actionId: 'scenario.instantiate',
              status: 'unknown',
              summary: 'Rejected execution status',
              evidenceRefs: [],
            },
          ],
        },
      }),
    ).toThrow('status is invalid');
    expect(recordSchema({ ...valid, revision: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(
      readModel({
        ...projectGovernedPlanReadModel(valid),
        final: true,
        executionTerminal: true,
        reconciliationRequired: true,
      }),
    ).toBe(false);

    const structurallyValidButTooManyBytes = {
      ...valid.canonicalPlan,
      goal: '😀'.repeat(GOVERNED_PLAN_CONTRACT_LIMITS.maxGoalBytes),
    };
    expect(actionPlan(structurallyValidButTooManyBytes)).toBe(true);
    expect(() =>
      createCanonicalGovernedPlan({
        kind: structurallyValidButTooManyBytes.kind,
        goal: structurallyValidButTooManyBytes.goal,
        input: structurallyValidButTooManyBytes.input,
        actions: structurallyValidButTooManyBytes.actions,
        effects: structurallyValidButTooManyBytes.effects,
      }),
    ).toThrow('goal is invalid');
  });
});
