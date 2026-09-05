import { describe, expect, it } from 'vitest';
import {
  checkpointState,
  recoveryFrame,
  recoveryView,
  recoveryHead,
} from './workflow-recovery-fixtures.js';
import {
  assertRecoveryFrontier,
  historicalResumeEvidence,
  parseWorkflowRunRecoveryEvidence,
  recoveryCheckpointState,
} from '../workflow-run-recovery-evidence.js';
import { createWorkflowRunRecoveryEvidenceClient } from '../workflow-runner-authority-binding-client.js';
import { createWorkflowRunnerAuthorityBindingClient } from '../workflow-runner-authority-binding-client.js';
import { WorkflowControlAuthorityHttpClient } from '../workflow-control-authority-client.js';
import { createWorkflowRunnerBudgetAuthorityClient } from '../workflow-runner-budget-authority-client.js';
import { prepareWorkflowRunnerAuthorityBindingStage } from '../workflow-runner-authority-binding-contract.js';
import { workflowCheckpointHash } from '../workflow-checkpoint-shadow-contract.js';
import { resumeIntentFixture } from './workflow-recovery-fixtures.js';
import { parseWorkflowResumeIntent } from '../internal/workflow-runner-resume-source.js';
import { WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES } from '../run-store.js';
import { canonicalWorkflowControlAuthorityJson as canonical } from '../workflow-control-authority-contract.js';

describe('durable checkpoint recovery evidence', () => {
  it('accepts long immutable intents and rejects altered lineage before any receipt lookup', () => {
    const { intent, stage, target } = resumeIntentFixture(1023);
    const bytes = canonical(intent) + '\n';
    expect(Buffer.byteLength(bytes)).toBeGreaterThan(1_048_576);
    expect(Buffer.byteLength(bytes)).toBeLessThan(WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES);
    expect(parseWorkflowResumeIntent(bytes, stage, target)).toEqual(intent);
    const changed = {
      ...intent,
      next: {
        ...intent.next,
        seenBindingHashes: ['f'.repeat(64), intent.next.seenBindingHashes[1]!],
      },
    };
    expect(() => parseWorkflowResumeIntent(canonical(changed) + '\n', stage, target)).toThrow(
      'intent is torn',
    );
  });
  it('derives contiguous source progress despite independent authority revisions and old empty phase', () => {
    const state = checkpointState(2);
    const view = recoveryView([
      recoveryFrame(state, 'checkpoint_commit'),
      recoveryFrame(checkpointState(), 'checkpoint_commit'),
    ]);
    expect(recoveryCheckpointState(view)).toEqual(state);
    for (const phase of [null, 1, 2])
      expect(() => assertRecoveryFrontier(view, recoveryHead(state, phase), state)).not.toThrow();
    for (const phase of [0, 3])
      expect(() => assertRecoveryFrontier(view, recoveryHead(state, phase), state)).toThrow(
        'phase or generation',
      );
    expect(() => assertRecoveryFrontier(view, recoveryHead(state), checkpointState())).toThrow(
      'cache is behind',
    );
  });
  it('accepts initial phase-0 and refuses a missing or duplicated source transition', () => {
    const initial = checkpointState(0);
    for (const phase of [null, 0])
      expect(() =>
        assertRecoveryFrontier(recoveryView([]), recoveryHead(initial, phase), initial),
      ).not.toThrow();
    const frame = recoveryFrame(checkpointState(2), 'checkpoint_commit');
    expect(() => recoveryCheckpointState(recoveryView([frame]))).toThrow('missing, duplicate');
    const first = recoveryFrame(checkpointState(), 'checkpoint_commit');
    expect(() => recoveryCheckpointState(recoveryView([first, first]))).toThrow(
      'missing, duplicate',
    );
  });
  it('keeps A committed after later checkpoints, another generation, and a restart reconciliation latch', () => {
    const prior = checkpointState();
    const activeBinding = {
      ...prior.activeBinding,
      jobId: 'job.resume',
      attemptId: 'attempt.resume',
      leaseId: 'lease.resume',
    };
    const resumed = {
      ...prior,
      revision: 3,
      resumeGeneration: 1,
      activeBinding,
      seenBindingHashes: [...prior.seenBindingHashes, workflowCheckpointHash(activeBinding)],
    };
    const frame = recoveryFrame(resumed, 'resume_advance');
    const staged = JSON.parse(frame.stage);
    const proof = recoveryView([{ ...frame, state: 'reconciliation_required' }]);
    const exact = historicalResumeEvidence(proof, staged);
    expect(exact).toMatchObject({
      sourceAuthority: { acceptedResumeGeneration: 1, acceptedRevision: 3 },
      nextPhaseId: 'phase-1',
    });
    // The operation proof does not depend on any mutable cache or current head.
    expect(
      historicalResumeEvidence({ ...proof, activeAttempts: ['attempt.later'] }, staged),
    ).toEqual(exact);
    expect(() => assertRecoveryFrontier(proof, recoveryHead(resumed), resumed)).toThrow(
      'missing, duplicate',
    );
  });
  it.each(['workspaceId', 'runId', 'route', 'stageReceipt', 'resolutionReceipt', 'unknown'])(
    'rejects a cross-bound or malformed %s',
    (field) => {
      const entry = recoveryFrame(checkpointState(), 'checkpoint_commit');
      const view = recoveryView([entry]);
      const bad =
        field === 'stageReceipt' || field === 'resolutionReceipt'
          ? { ...view, bindings: [{ ...entry, [field]: '{}\n' }] }
          : { ...view, [field]: field === 'route' ? { ...view.route, routingEpoch: 2 } : 'wrong' };
      expect(() =>
        parseWorkflowRunRecoveryEvidence(JSON.stringify(bad), view.workspaceId, view.runId),
      ).toThrow('WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED');
    },
  );
});

describe('recovery HTTP queries', () => {
  const config = {
    origin: 'http://127.0.0.1:8081',
    workspaceId: 'workspace.test',
    bearerToken: 'r'.repeat(48),
  };
  const response = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  it.each(['binding', 'control', 'budget'] as const)(
    'classifies interrupted %s receipt bodies as transport failures',
    async (plane) => {
      const broken = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('transport interrupted'));
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      const route = recoveryView([]).route;
      const prepared = prepareWorkflowRunnerAuthorityBindingStage(
        JSON.parse(recoveryFrame(checkpointState(), 'checkpoint_commit').stage),
      );
      const task =
        plane === 'binding'
          ? createWorkflowRunnerAuthorityBindingClient({ ...config, fetch: broken }).readReceipt(
              prepared.idempotencyKey,
            )
          : plane === 'control'
            ? new WorkflowControlAuthorityHttpClient({
                ...config,
                callerId: 'workflow-runner-v2',
                expectedBuildHash: route.authorityBuildHash,
                fetch: broken,
              }).read('run.recovery', route)
            : createWorkflowRunnerBudgetAuthorityClient({
                ...config,
                callerId: 'workflow-runner-v2',
                fetch: broken,
              }).readAccount('run.recovery', route);
      await expect(task).rejects.toMatchObject({
        code: expect.stringMatching(/TRANSPORT_FAILED$/u),
      });
    },
  );

  it('assembles long history from one snapshot, preserving exact embedded bytes', async () => {
    const bindings = Array.from({ length: 40 }, (_, i) =>
      recoveryFrame(checkpointState(i + 1), 'checkpoint_commit'),
    ).sort((a, b) => a.bindingId.localeCompare(b.bindingId));
    expect(JSON.stringify(bindings).length).toBeGreaterThan(256 * 1024);
    const urls: string[] = [];
    const client = createWorkflowRunRecoveryEvidenceClient({
      ...config,
      fetch: async (input, init) => {
        urls.push(String(input));
        expect(new Headers(init?.headers).get('X-OpenSlack-Workspace-ID')).toBe(config.workspaceId);
        const later = urls.length > 1;
        const page = bindings.slice(later ? 20 : 0, later ? 40 : 20);
        return response({
          ...recoveryView(page),
          complete: later,
          nextCursor: later ? null : page.at(-1)!.bindingId,
        });
      },
    });
    const view = await client.readRecoveryEvidence('run.recovery');
    expect(view.bindings).toEqual(bindings);
    expect(recoveryCheckpointState(view)).toEqual(checkpointState(40));
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('snapshot=' + view.snapshot);
    expect(Object.keys(client)).toEqual(['readRecoveryEvidence']);
  });
  it.each([429, 503])('keeps HTTP %i retryable', async (status) => {
    const client = createWorkflowRunRecoveryEvidenceClient({
      ...config,
      fetch: async () => new Response(null, { status }),
    });
    await expect(client.readRecoveryEvidence('run.recovery')).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_RECOVERY_UNKNOWN',
    });
  });
  it('carries cancellation and rejects a changing page snapshot', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = createWorkflowRunRecoveryEvidenceClient({
      ...config,
      fetch: async (_input, init) => {
        init?.signal?.throwIfAborted();
        throw Error();
      },
    });
    await expect(
      cancelled.readRecoveryEvidence('run.recovery', undefined, controller.signal),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_RECOVERY_UNKNOWN' });
    const entry = recoveryFrame(checkpointState(), 'checkpoint_commit');
    let calls = 0;
    const client = createWorkflowRunRecoveryEvidenceClient({
      ...config,
      fetch: async () =>
        response({
          ...recoveryView([entry]),
          complete: false,
          nextCursor: entry.bindingId,
          snapshot: (++calls === 1 ? 'b' : 'c').repeat(64),
        }),
    });
    await expect(client.readRecoveryEvidence('run.recovery')).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_RECOVERY_UNKNOWN',
    });
    expect(calls).toBe(2);
  });
});
