import { describe, expect, it, vi } from 'vitest';
import { createRuntime, WorkflowExecutionCancelledError } from '../runtime.js';
import type { WorkflowEffectBoundary } from '../workflow-runner-effect-boundary.js';
import type { WorkflowMeta } from '../types.js';

const manifest: WorkflowMeta = {
  name: 'effect-boundary-test',
  version: '1.0.0',
  description: 'Effect ordering test.',
  phases: [{ title: 'Run', detail: 'Run once.' }],
  risk: 'low',
};

describe('GS8-B executeRun/runtime worker integration', () => {
  it('durably reports intent before TS approval and outcome after TS execution', async () => {
    const order: string[] = [];
    let releaseIntent!: () => void;
    const intentGate = new Promise<void>((resolve) => {
      releaseIntent = resolve;
    });
    const boundary: WorkflowEffectBoundary = {
      async intent(input) {
        order.push(`intent:${input.operation}`);
        await intentGate;
        order.push('intent-receipt');
        return {
          effectId: `workflow-effect:sha256:${'a'.repeat(64)}`,
          effectKind: input.operation,
          effectHash: 'a'.repeat(64),
          capabilityHash: 'b'.repeat(64),
          requiresHumanDecision: false,
        };
      },
      async outcome(_handle, input) {
        order.push(`outcome:${input.status}`);
      },
    };
    const onConfirm = vi.fn(async () => {
      order.push('approved-by-typescript');
      return true;
    });
    const runtime = createRuntime({
      runId: 'run.effect.1',
      mode: 'execute',
      manifest,
      onConfirm,
      effectBoundary: boundary,
    });
    const pending = runtime.openslack.task.createIssue({ title: 'Test' });
    await vi.waitFor(() => expect(order).toEqual(['intent:openslack.task.createIssue']));
    expect(onConfirm).not.toHaveBeenCalled();
    releaseIntent();
    await expect(pending).resolves.toMatchObject({ issueNumber: 1 });
    expect(order).toEqual([
      'intent:openslack.task.createIssue',
      'intent-receipt',
      'approved-by-typescript',
      'outcome:executed',
    ]);
  });

  it('reports a denied TS decision without executing the effect', async () => {
    const statuses: string[] = [];
    const boundary: WorkflowEffectBoundary = {
      async intent(input) {
        return {
          effectId: `workflow-effect:sha256:${'a'.repeat(64)}`,
          effectKind: input.operation,
          effectHash: 'a'.repeat(64),
          capabilityHash: 'b'.repeat(64),
          requiresHumanDecision: true,
        };
      },
      async outcome(_handle, input) {
        statuses.push(input.status);
      },
    };
    const runtime = createRuntime({
      runId: 'run.effect.2',
      mode: 'execute',
      manifest,
      onConfirm: async () => false,
      effectBoundary: boundary,
    });
    await expect(runtime.openslack.task.sync(1)).rejects.toThrow('User denied');
    expect(statuses).toEqual(['rejected']);
  });

  it('checks cooperative cancellation at runtime boundaries', () => {
    const controller = new AbortController();
    const runtime = createRuntime({
      runId: 'run.cancel.1',
      mode: 'execute',
      manifest,
      onConfirm: async () => true,
      signal: controller.signal,
    });
    controller.abort(new Error('operator stop'));
    expect(() => runtime.phase('Run')).toThrow(WorkflowExecutionCancelledError);
    expect(() => runtime.log('after cancellation')).toThrow('operator stop');
  });
});
