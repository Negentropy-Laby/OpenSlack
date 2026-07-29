import { describe, expect, it } from 'vitest';
import {
  assertContractDeliveryLiteWorkflowPlan,
  compileWorkflowStartPlan,
  CONTRACT_DELIVERY_LITE_EXECUTOR_ID,
  CONTRACT_DELIVERY_LITE_FIXTURE_ID,
  CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
  createContractDeliveryLiteWorkflowReceipt,
  createContractDeliveryLiteWorkflowResolverEntry,
  createSealedWorkflowPlanResolver,
  deriveContractDeliveryLiteWorkflowRunId,
  normalizeContractDeliveryLiteWorkflowInput,
  validateContractDeliveryLiteWorkflowReceipt,
} from '../index.js';

function plan() {
  return compileWorkflowStartPlan({
    resolver: createSealedWorkflowPlanResolver({
      entries: [createContractDeliveryLiteWorkflowResolverEntry()],
    }),
    workflowId: CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
    input: {
      mode: 'local_rehearsal',
      fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
      scenarioInstanceId: 'scenario:sha256:abc',
      scenarioCorrelationId: 'correlation-scenario-1',
    },
    authorityBindings: [],
    actorId: 'agent-principal:sha256:abc',
    workspaceId: 'workspace-1',
    correlationId: 'correlation-workflow-1',
    createdAt: '2026-07-29T00:00:00.000Z',
    expiresAt: '2026-07-29T01:00:00.000Z',
  });
}

describe('reviewed Contract-to-Delivery local Workflow contract', () => {
  it('seals one exact executor and produces a deterministic local-only receipt', () => {
    const compiled = plan();
    const input = assertContractDeliveryLiteWorkflowPlan(compiled);
    const first = createContractDeliveryLiteWorkflowReceipt(compiled);
    const second = createContractDeliveryLiteWorkflowReceipt(compiled);

    expect(compiled.workflow.executorId).toBe(CONTRACT_DELIVERY_LITE_EXECUTOR_ID);
    expect(input).toEqual({
      mode: 'local_rehearsal',
      fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
      scenarioInstanceId: 'scenario:sha256:abc',
      scenarioCorrelationId: 'correlation-scenario-1',
    });
    expect(first).toEqual(second);
    expect(first.workflowRunId).toBe(deriveContractDeliveryLiteWorkflowRunId(compiled));
    expect(first).toMatchObject({
      evidenceLevel: 'LOCAL_REHEARSAL_PASS',
      origins: {
        workflow: 'governed_local_store',
        workItem: 'demo_fixture',
        deliverable: 'demo_fixture',
        acceptance: 'demo_fixture',
        outcome: 'demo_fixture',
        notificationIntent: 'not_created',
        notificationDelivery: 'blocked_not_configured',
        liveGitHub: 'not_run',
        liveCapstone: 'LIVE_CAPSTONE_PENDING',
        qoderDesktop: 'not_run',
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(validateContractDeliveryLiteWorkflowReceipt(first, compiled)).toEqual(first);
  });

  it('rejects unknown controls, accessors, proxies, and receipt drift', () => {
    expect(() =>
      normalizeContractDeliveryLiteWorkflowInput({
        mode: 'local_rehearsal',
        fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
        scenarioInstanceId: 'scenario:sha256:abc',
        scenarioCorrelationId: 'correlation-scenario-1',
        command: 'forbidden',
      } as never),
    ).toThrow('missing or unknown fields');

    let getterHits = 0;
    const accessor = Object.defineProperty(
      {
        mode: 'local_rehearsal',
        fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
        scenarioCorrelationId: 'correlation-scenario-1',
      },
      'scenarioInstanceId',
      {
        enumerable: true,
        get() {
          getterHits += 1;
          return 'scenario:sha256:abc';
        },
      },
    );
    expect(() => normalizeContractDeliveryLiteWorkflowInput(accessor as never)).toThrow(
      'missing or unknown fields',
    );
    expect(getterHits).toBe(0);

    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          return Object.prototype;
        },
      },
    );
    expect(() => normalizeContractDeliveryLiteWorkflowInput(proxy as never)).toThrow(
      'must be inert data',
    );
    expect(traps).toBe(0);

    const compiled = plan();
    const receipt = createContractDeliveryLiteWorkflowReceipt(compiled);
    expect(() =>
      validateContractDeliveryLiteWorkflowReceipt(
        { ...receipt, evidenceLevel: 'QODER_VERIFIED' },
        compiled,
      ),
    ).toThrow('does not match');
  });
});
