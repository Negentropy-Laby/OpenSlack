import { describe, expect, it } from 'vitest';
import {
  applyWorkflowEffectApprovalDecision,
  createPendingWorkflowEffectApproval,
  createWorkflowEffectDecisionAuthority,
  validateWorkflowEffectApproval,
  workflowEffectApprovalBytes,
  WORKFLOW_EFFECT_APPROVAL_SCHEMA,
} from '../index.js';
import { canonicalWorkflowEffectJson, parseWorkflowEffectJson } from '../workflow-effect-json.js';

const effectHash = 'a'.repeat(64);
const approvedReasonHash = 'd'.repeat(64);
const rejectedReasonHash = 'e'.repeat(64);

function pending(now = Date.now()) {
  return createPendingWorkflowEffectApproval({
    runId: 'run-001',
    approvalId: 'approval-001',
    correlationId: 'business-correlation-001',
    workflowId: 'delivery.create',
    workflowVersion: '1.2.3',
    workflowHash: 'b'.repeat(64),
    inputHash: 'c'.repeat(64),
    effectId: `workflow-effect:sha256:${effectHash}`,
    effectHash,
    requiredCapability: 'workflow.effect.decide',
    createdAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
}

function authority() {
  return createWorkflowEffectDecisionAuthority({
    workspaceId: 'workspace-main',
    humanPrincipalIds: ['human-reviewer'],
    capabilities: ['workflow.effect.decide'],
    maxBindingTtlMs: 60_000,
  });
}

function binding(
  value = authority(),
  now = Date.now(),
  decision: 'approved' | 'rejected' = 'approved',
  reasonHash = decision === 'approved' ? approvedReasonHash : rejectedReasonHash,
) {
  return value.issueHumanDecisionBinding({
    principalId: 'human-reviewer',
    capability: 'workflow.effect.decide',
    runId: 'run-001',
    approvalId: 'approval-001',
    correlationId: 'business-correlation-001',
    approvalExpiresAt: new Date(now + 60_000).toISOString(),
    decision,
    reasonHash,
    expiresAt: new Date(now + 30_000).toISOString(),
  });
}

describe('workflow effect approval v2 contract', () => {
  it('creates a closed actor-agnostic pending record with all effect bindings', () => {
    const record = pending();
    expect(record).toMatchObject({
      schema: WORKFLOW_EFFECT_APPROVAL_SCHEMA,
      runId: 'run-001',
      approvalId: 'approval-001',
      correlationId: 'business-correlation-001',
      workflowId: 'delivery.create',
      workflowVersion: '1.2.3',
      workflowHash: 'b'.repeat(64),
      inputHash: 'c'.repeat(64),
      effectId: `workflow-effect:sha256:${effectHash}`,
      effectHash,
      requiredCapability: 'workflow.effect.decide',
      revision: 0,
      status: 'pending',
      decision: null,
      auditProjection: null,
    });
    expect(record).not.toHaveProperty('actorId');
    expect(Object.isFrozen(record)).toBe(true);
    expect(validateWorkflowEffectApproval(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(
      workflowEffectApprovalBytes({
        ...record,
        correlationId: 'business-correlation-002',
      }),
    ).not.toEqual(workflowEffectApprovalBytes(record));
  });

  it('accepts exactly one pending-to-terminal human decision', () => {
    const now = Date.now();
    const decisionAuthority = authority();
    const humanBinding = binding(decisionAuthority, now);
    const approved = applyWorkflowEffectApprovalDecision(
      pending(now),
      'approved',
      humanBinding,
      decisionAuthority,
      approvedReasonHash,
      new Date(now + 1_000).toISOString(),
    );
    expect(approved).toMatchObject({
      correlationId: 'business-correlation-001',
      revision: 1,
      status: 'approved',
      decision: {
        principalId: 'human-reviewer',
        workspaceId: 'workspace-main',
        capability: 'workflow.effect.decide',
        reasonHash: approvedReasonHash,
      },
      auditProjection: {
        status: 'pending',
      },
    });
    expect(approved.decision!.attestationNonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(approved.auditProjection!.eventId).toMatch(/^WFAPPROVAL-AUDIT-[0-9a-f]{64}$/);
    expect(() =>
      validateWorkflowEffectApproval({
        ...approved,
        auditProjection: {
          status: 'pending',
          eventId: `WFAPPROVAL-AUDIT-${'f'.repeat(64)}`,
        },
      }),
    ).toThrow(/deterministic decision event/);
    expect(() =>
      applyWorkflowEffectApprovalDecision(
        approved,
        'rejected',
        humanBinding,
        decisionAuthority,
        rejectedReasonHash,
        new Date(now + 2_000).toISOString(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_TRANSITION_DENIED' }));
  });

  it('rejects copied, forged, cross-authority, and unauthorized human bindings', () => {
    const now = Date.now();
    const first = authority();
    const second = authority();
    const genuine = binding(first, now);
    for (const value of [
      { ...genuine },
      {
        principalId: 'human-reviewer',
        workspaceId: 'workspace-main',
        capability: 'workflow.effect.decide',
        expiresAt: genuine.expiresAt,
      },
    ]) {
      expect(() =>
        applyWorkflowEffectApprovalDecision(
          pending(now),
          'approved',
          value as never,
          first,
          approvedReasonHash,
          new Date(now + 1_000).toISOString(),
        ),
      ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID' }));
    }
    expect(() =>
      applyWorkflowEffectApprovalDecision(
        pending(now),
        'rejected',
        genuine,
        first,
        rejectedReasonHash,
        new Date(now + 1_000).toISOString(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID' }));
    expect(() =>
      applyWorkflowEffectApprovalDecision(
        pending(now),
        'approved',
        genuine,
        first,
        rejectedReasonHash,
        new Date(now + 1_000).toISOString(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID' }));
    expect(() =>
      applyWorkflowEffectApprovalDecision(
        pending(now),
        'approved',
        genuine,
        second,
        approvedReasonHash,
        new Date(now + 1_000).toISOString(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID' }));
    expect(() =>
      first.issueHumanDecisionBinding({
        principalId: 'automation-worker',
        capability: 'workflow.effect.decide',
        runId: 'run-001',
        approvalId: 'approval-001',
        correlationId: 'business-correlation-001',
        approvalExpiresAt: new Date(now + 60_000).toISOString(),
        decision: 'approved',
        reasonHash: approvedReasonHash,
        expiresAt: new Date(now + 30_000).toISOString(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID' }));
  });

  it('binds a human decision to the exact business correlation and approval expiry', () => {
    const now = Date.now();
    const decisionAuthority = authority();
    for (const scoped of [
      {
        correlationId: 'business-correlation-other',
        approvalExpiresAt: new Date(now + 60_000).toISOString(),
      },
      {
        correlationId: 'business-correlation-001',
        approvalExpiresAt: new Date(now + 90_000).toISOString(),
      },
    ]) {
      const humanBinding = decisionAuthority.issueHumanDecisionBinding({
        principalId: 'human-reviewer',
        capability: 'workflow.effect.decide',
        runId: 'run-001',
        approvalId: 'approval-001',
        correlationId: scoped.correlationId,
        approvalExpiresAt: scoped.approvalExpiresAt,
        decision: 'approved',
        reasonHash: approvedReasonHash,
        expiresAt: new Date(now + 30_000).toISOString(),
      });
      expect(() =>
        applyWorkflowEffectApprovalDecision(
          pending(now),
          'approved',
          humanBinding,
          decisionAuthority,
          approvedReasonHash,
          new Date(now + 1_000).toISOString(),
        ),
      ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID' }));
    }
  });

  it('rejects mismatched effect identity, capability, expiry, and noncanonical timestamps', () => {
    const record = pending();
    expect(() =>
      validateWorkflowEffectApproval({
        ...record,
        effectHash: 'd'.repeat(64),
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_INVALID' }));
    expect(() =>
      validateWorkflowEffectApproval({
        ...record,
        createdAt: record.createdAt.replace(/\.\d{3}Z$/, 'Z'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_INVALID' }));

    const now = Date.now();
    const decisionAuthority = authority();
    const humanBinding = binding(decisionAuthority, now);
    expect(() =>
      applyWorkflowEffectApprovalDecision(
        pending(now),
        'approved',
        humanBinding,
        decisionAuthority,
        approvedReasonHash,
        new Date(now + 61_000).toISOString(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_EXPIRED' }));
  });

  it('rejects proxies and accessors before invoking traps', () => {
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          return Object.prototype;
        },
        ownKeys() {
          traps += 1;
          return [];
        },
      },
    );
    expect(() => validateWorkflowEffectApproval(proxy)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_INVALID' }),
    );
    expect(() => createWorkflowEffectDecisionAuthority(proxy as never)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID' }),
    );
    expect(traps).toBe(0);

    let getters = 0;
    const record = { ...pending() };
    Object.defineProperty(record, 'runId', {
      enumerable: true,
      get() {
        getters += 1;
        return 'run-hidden';
      },
    });
    expect(() => validateWorkflowEffectApproval(record)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_INVALID' }),
    );
    expect(getters).toBe(0);
  });

  it('rejects unknown fields and malformed revision/status combinations', () => {
    const record = pending();
    expect(() => validateWorkflowEffectApproval({ ...record, extra: true })).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_INVALID' }),
    );
    expect(() => validateWorkflowEffectApproval({ ...record, revision: 1 })).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_INVALID' }),
    );
    expect(() =>
      validateWorkflowEffectApproval({ ...record, status: 'approved', revision: 1 }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_INVALID' }));
  });

  it('rejects decoded duplicate JSON keys and unsafe canonical JSON shapes', () => {
    expect(() =>
      parseWorkflowEffectJson(Buffer.from('{"schema":1,"\\u0073chema":2}', 'utf8')),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_EFFECT_JSON_DUPLICATE_KEY' }));
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap invoked');
        },
      },
    );
    expect(() => canonicalWorkflowEffectJson(proxy)).toThrowError(TypeError);
    let getters = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        getters += 1;
        return true;
      },
    });
    expect(() => canonicalWorkflowEffectJson(accessor)).toThrowError(TypeError);
    expect(getters).toBe(0);
  });
});
