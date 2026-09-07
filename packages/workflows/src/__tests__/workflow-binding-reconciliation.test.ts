import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import {
  checkpointState,
  recoveryFrame,
  recoveryView,
  resumeIntentFixture,
} from './workflow-recovery-fixtures.js';
import {
  settlementFixture,
  sourceCommitFixture,
  sourceFenceFixture,
} from './workflow-reconciliation-fixtures.js';
import { canonicalWorkflowControlAuthorityJson as canonical } from '../workflow-control-authority-contract.js';
import { createWorkflowBindingReconciliationClient } from '../workflow-binding-reconciliation.js';
import { validateWorkflowBindingSettlement } from '../workflow-binding-reconciliation-contract.js';
import { createWorkflowRunRecoveryEvidenceClient } from '../workflow-runner-authority-binding-client.js';
import {
  recoveryCheckpointState,
  validateWorkflowRunRecoveryEvidence,
} from '../workflow-run-recovery-evidence.js';

const config = {
  origin: 'http://127.0.0.1:18080',
  workspaceId: 'workspace.test',
  bearerToken: 'recovery-test-token-12345678901234567890',
  descriptorRoot: resolve('test-descriptors'),
};
const response = (value: unknown) =>
  new Response(canonical(value) + '\n', { headers: { 'content-type': 'application/json' } });

describe('exact binding settlement evidence', () => {
  it.each([0, 1])(
    'reconstructs a source-committed resume with %i prior checkpoints and no runner resolution',
    (count) => {
      const f = resumeIntentFixture(count);
      // The original initial head has an empty phase, never phase -1.
      if (count === 0) {
        f.intent.expected.currentPhaseId = null;
        f.intent.expected.currentPhaseIndex = null;
      }
      const stageOnly = {
        ...f.frame,
        state: 'reconciliation_required',
        resolution: null,
        resolutionReceipt: null,
      };
      const proof = {
        ...recoveryView([
          ...(count ? [recoveryFrame(f.intent.prior, 'checkpoint_commit')] : []),
          stageOnly,
        ]),
        schema: 'openslack.workflow_runner_recovery_evidence.v2' as const,
        settlements: [sourceCommitFixture(f)],
      };
      expect(() => recoveryCheckpointState(proof)).toThrow('no reconstructable source intent');
      const intents = new Map([[f.stage.bindingId, canonical(f.intent) + '\n']]);
      expect(recoveryCheckpointState(proof, undefined, intents)).toMatchObject({
        revision: f.intent.next.revision,
        resumeGeneration: 1,
        activeBinding: f.intent.next.activeBinding,
        checkpoints: f.intent.prior.checkpoints,
      });
      const changed = {
        ...f.intent,
        expected: { ...f.intent.expected, revision: 90 },
        record: { ...f.intent.record, revision: 91 },
      };
      expect(() =>
        recoveryCheckpointState(
          proof,
          undefined,
          new Map([[f.stage.bindingId, canonical(changed) + '\n']]),
        ),
      ).toThrow('exact committed source request');
    },
  );
  it('preserves a closed negative conclusion and rejects a cross-bound or altered proof', () => {
    const f = resumeIntentFixture();
    const receipt = sourceFenceFixture(f.stage);
    expect(() => validateWorkflowBindingSettlement(receipt, f.stage)).not.toThrow();
    for (const changed of [
      { ...receipt, runId: 'run.foreign' },
      { ...receipt, proof: receipt.proof.replace('resume.', 'other.') },
      { ...receipt, outcome: 'committed' as const },
    ])
      expect(() => validateWorkflowBindingSettlement(changed, f.stage)).toThrow();
  });
});

describe('recovery v2 pagination', () => {
  it('pages bindings, diagnostics, attempts and settlements without changing exact bytes', async () => {
    const f = resumeIntentFixture();
    const binding = {
      ...f.frame,
      state: 'reconciliation_required',
      resolution: null,
      resolutionReceipt: null,
    };
    const settlement = sourceFenceFixture(f.stage);
    const base = recoveryView([]);
    const records = [
      { key: 'attempt.attempt.active', kind: 'active_attempt', value: 'attempt.active' },
      { key: `binding.${binding.bindingId}`, kind: 'binding', value: binding },
      {
        key: `settlement.${binding.bindingId}`,
        kind: 'settlement',
        value: canonical(settlement) + '\n',
      },
    ];
    const urls: string[] = [];
    const client = createWorkflowRunRecoveryEvidenceClient({
      ...config,
      fetch: async (input) => {
        const index = urls.length;
        urls.push(String(input));
        return response({
          schema: 'openslack.workflow_runner_recovery_evidence.v2',
          workspaceId: base.workspaceId,
          runId: base.runId,
          route: base.route,
          complete: false,
          snapshot: base.snapshot,
          nextCursor: index === 2 ? null : records[index]!.key,
          records: [records[index]],
        });
      },
    });
    const result = await client.readRecoveryEvidence(base.runId, f.stage.bindingId);
    expect(result.bindings).toEqual([binding]);
    expect(result.settlements).toEqual([settlement]);
    expect(result.activeAttempts).toEqual(['attempt.active']);
    expect(result.complete).toBe(false);
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain('bindingId=');
    expect(urls[1]).toContain('afterBindingId=attempt.attempt.active');
    validateWorkflowRunRecoveryEvidence(result);
  });
  it('rejects settlement evidence that is orphaned from its immutable stage', async () => {
    const f = resumeIntentFixture();
    const settlement = sourceFenceFixture(f.stage);
    const base = recoveryView([]);
    const client = createWorkflowRunRecoveryEvidenceClient({
      ...config,
      fetch: async () =>
        response({
          schema: 'openslack.workflow_runner_recovery_evidence.v2',
          workspaceId: base.workspaceId,
          runId: base.runId,
          route: base.route,
          complete: true,
          snapshot: base.snapshot,
          nextCursor: null,
          records: [
            {
              key: `settlement.${f.stage.bindingId}`,
              kind: 'settlement',
              value: canonical(settlement) + '\n',
            },
          ],
        }),
    });
    await expect(client.readRecoveryEvidence(base.runId)).rejects.toThrow('no original binding');
  });
});

describe('reconciliation transport', () => {
  it.each([429, 503])(
    'keeps %i outcomes unknown and preserves the exact operation key',
    async (status) => {
      const calls: RequestInit[] = [];
      const client = createWorkflowBindingReconciliationClient({
        ...config,
        fetch: async (_url, init) => {
          calls.push(init!);
          return new Response(null, { status });
        },
      });
      const f = resumeIntentFixture();
      const receipt = sourceFenceFixture(f.stage);
      await expect(client.readReceipt(f.stage.runId, receipt.idempotencyKey)).rejects.toMatchObject(
        { code: 'WORKFLOW_RUN_RECOVERY_UNKNOWN' },
      );
      expect(calls[0]?.method).toBe('GET');
    },
  );
  it('rejects malformed integrity without leaking private response bodies', async () => {
    const client = createWorkflowBindingReconciliationClient({
      ...config,
      fetch: async () =>
        new Response('private-response', { headers: { 'content-type': 'text/plain' } }),
    });
    const error = await client.preview('run.recovery').catch((error) => error);
    expect(error.code).toBe('WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED');
    expect(error.message).not.toContain('private-response');
  });
  it('cancels before fetch and does not send an apply or receipt lookup', async () => {
    const fetch = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('private-cancellation'));
    const client = createWorkflowBindingReconciliationClient({ ...config, fetch });
    await expect(
      client.preview('run.recovery', undefined, controller.signal),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_OPERATION_CANCELLED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a preview that labels an unrelated resolution as this stage', () => {
    const frame = recoveryFrame(checkpointState(), 'checkpoint_commit');
    const stage = JSON.parse(frame.stage);
    const receipt = settlementFixture(stage, 'resolution', frame.resolution!);
    expect(() =>
      validateWorkflowBindingSettlement(
        { ...receipt, proof: frame.resolution! + ' ' },
        stage,
        frame.resolution,
      ),
    ).toThrow();
  });
});
