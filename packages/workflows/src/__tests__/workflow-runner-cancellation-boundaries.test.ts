import { describe, expect, it } from 'vitest';
import {
  createRuntime,
  WorkflowExecutionCancelledError,
  type WorkflowRunnerCancellationBoundary,
} from '../runtime.js';
import type { WorkflowEffectBoundary } from '../workflow-runner-effect-boundary.js';
import type { WorkflowMeta } from '../types.js';

const manifest: WorkflowMeta = {
  name: 'cancel-test',
  version: '1.0.0',
  description: 'Cancellation boundary test.',
  phases: [{ title: 'Run', detail: 'Run once.' }],
  risk: 'low',
};

function cancellationBoundary(error: unknown): WorkflowRunnerCancellationBoundary {
  expect(error).toBeInstanceOf(WorkflowExecutionCancelledError);
  return (error as WorkflowExecutionCancelledError).boundary;
}

describe('GS8-B closed cancellation boundary inventory', () => {
  it('covers every cancellation boundary reachable before exact D2 execution authority', async () => {
    const observed = new Set<WorkflowRunnerCancellationBoundary>();

    for (const [name, invoke] of [
      ['runtime_api', (runtime: ReturnType<typeof createRuntime>) => runtime.phase('Run')],
      [
        'agent_call',
        (runtime: ReturnType<typeof createRuntime>) =>
          runtime.agent('x', { label: 'x', phase: 'Run' }),
      ],
      ['parallel_dispatch', (runtime: ReturnType<typeof createRuntime>) => runtime.parallel([])],
      [
        'pipeline_dispatch',
        (runtime: ReturnType<typeof createRuntime>) => runtime.pipeline([], async () => 1),
      ],
    ] as const) {
      const controller = new AbortController();
      const runtime = createRuntime({
        runId: `run.${name}`,
        mode: 'execute',
        manifest,
        onConfirm: async () => true,
        signal: controller.signal,
      });
      controller.abort(new Error('control stop'));
      try {
        await invoke(runtime);
      } catch (error) {
        observed.add(cancellationBoundary(error));
      }
    }

    const intentController = new AbortController();
    const intentBoundary: WorkflowEffectBoundary = {
      async intent(input) {
        intentController.abort(new Error('stop after intent receipt'));
        return effectHandle(input.operation);
      },
      async outcome() {},
    };
    const intentRuntime = createRuntime({
      runId: 'run.effect-intent',
      mode: 'execute',
      manifest,
      onConfirm: async () => true,
      signal: intentController.signal,
      effectBoundary: intentBoundary,
    });
    try {
      await intentRuntime.openslack.task.sync(1);
    } catch (error) {
      observed.add(cancellationBoundary(error));
    }

    expect(observed).toEqual(
      new Set([
        'runtime_api',
        'agent_call',
        'parallel_dispatch',
        'pipeline_dispatch',
        'effect_intent',
      ]),
    );
  });
});

function effectHandle(operation: string) {
  return {
    effectId: `workflow-effect:sha256:${'a'.repeat(64)}`,
    effectKind: operation,
    effectHash: 'a'.repeat(64),
    capabilityHash: 'b'.repeat(64),
    requiresHumanDecision: false,
  } as const;
}
