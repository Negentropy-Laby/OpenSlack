import { describe, expect, it } from 'vitest';
import {
  evaluateCleanupBrokerResult,
  evaluatePRBranchCleanupResult,
  createPRBranchCleanupAuditEvent,
  projectPRBranchCleanupEvent,
} from '../cleanup-result.js';
import { PR_BRANCH_CLEANUP_STATES, type PRBranchCleanupResult } from '../cleanup-types.js';
import type { CleanupBrokerResponse } from '../cleanup-broker-client.js';

const receipt = {
  schema: 'openslack.cleanup_response.v1',
  mode: 'execute',
  permitId: 'permit',
  operationId: 'operation',
  permitState: 'consumed',
  state: 'DELETED',
  attempted: true,
  auditStatus: 'RECORDED',
  claimRequirement: 'not_required',
  claimStatus: 'not_evaluated',
  reason: 'CLEANUP_DELETED',
} satisfies CleanupBrokerResponse;
describe('cleanup result and audit projections', () => {
  it.each(PR_BRANCH_CLEANUP_STATES)('evaluates terminal state %s consistently', (state) => {
    const result = { state, auditStatus: 'RECORDED' } as PRBranchCleanupResult;
    expect(evaluatePRBranchCleanupResult(result, true)).toBe(
      ['DELETED', 'ALREADY_ABSENT'].includes(state) ? 0 : 1,
    );
    expect(evaluatePRBranchCleanupResult(result, false)).toBe(
      ['CLEANUP_READY', 'ALREADY_ABSENT'].includes(state) ? 0 : 1,
    );
    expect(evaluateCleanupBrokerResult({ ...receipt, state }).exitCode).toBe(
      ['DELETED', 'ALREADY_ABSENT'].includes(state) ? 0 : 1,
    );
    expect(evaluatePRBranchCleanupResult({ ...result, auditStatus: 'FAILED' }, true)).toBe(1);
  });
  it.each(['execute', 'status'] as const)(
    'reports accepted %s with exit zero without claiming completion',
    (mode) => {
      const evaluated = evaluateCleanupBrokerResult({
        ...receipt,
        mode,
        state: 'OPERATION_IN_PROGRESS',
        attempted: false,
        permitState: 'reserved',
        auditStatus: 'NOT_REQUIRED',
      });
      expect(evaluated.exitCode).toBe(0);
      expect(evaluated.completed).toBe(false);
      expect(evaluated.notice).toContain('has not completed');
      expect(
        evaluateCleanupBrokerResult({
          ...receipt,
          mode,
          state: 'OPERATION_IN_PROGRESS',
          permitState: 'reconciliation_required',
        }).exitCode,
      ).toBe(1);
    },
  );
  it('distinguishes preview eligibility from Permit consumption and audit failure', () => {
    expect(
      evaluateCleanupBrokerResult({
        ...receipt,
        mode: 'preview',
        state: 'CLEANUP_READY',
        attempted: false,
        permitState: 'issued',
        auditStatus: 'NOT_REQUIRED',
      }).exitCode,
    ).toBe(0);
    expect(evaluateCleanupBrokerResult({ ...receipt, permitState: 'unknown' }).exitCode).toBe(1);
    expect(evaluateCleanupBrokerResult({ ...receipt, auditStatus: 'FAILED' }).exitCode).toBe(1);
    expect(evaluateCleanupBrokerResult({ ...receipt, state: 'OPERATION_NOT_FOUND' }).exitCode).toBe(
      1,
    );
  });
  it.each(['unknown', 'expired', 'revoked', 'reserved', 'consumed'] as const)(
    'refuses preview eligibility under %s Permit state',
    (permitState) => {
      for (const state of ['CLEANUP_READY', 'ALREADY_ABSENT'] as const) {
        expect(
          evaluateCleanupBrokerResult({
            ...receipt,
            mode: 'preview',
            state,
            attempted: false,
            auditStatus: 'NOT_REQUIRED',
            permitState,
          }).exitCode,
        ).toBe(1);
      }
    },
  );
  it('uses one audit payload for notifications and durable lifecycle events', () => {
    const result = {
      state: 'DELETED',
      operationId: 'operation',
      prNumber: 42,
      repository: 'owner/repo',
      branch: 'topic',
      attempted: true,
      evidenceTimestamp: '2026-10-09T00:00:00Z',
    } as PRBranchCleanupResult;
    const event = createPRBranchCleanupAuditEvent(
      { context: { kind: 'human-cli' }, execute: true },
      result,
      'outcome',
    );
    expect(event.authorizationSource).toBe('human-cli:--execute');
    expect(projectPRBranchCleanupEvent(event)).toMatchObject({
      type: 'pr.cleanup_branch.executed',
      metadata: {
        outcome: 'DELETED',
        attempted: true,
        evidence_timestamp: result.evidenceTimestamp,
      },
    });
    expect(
      createPRBranchCleanupAuditEvent(
        { context: { kind: 'human-cli' }, execute: false },
        result,
        'outcome',
      ).authorizationSource,
    ).toBe('preview-only');
  });
});
