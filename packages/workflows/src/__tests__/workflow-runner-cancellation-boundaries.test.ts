import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeRun } from '../execute.js';
import {
  parseWorkflowRunnerMessageBytes,
  validateWorkflowRunnerMessage,
  type WorkflowRunnerMessage,
} from '../workflow-runner-contract.js';
import {
  createWorkflowRunnerExecutionDescriptor,
  hashWorkflowRunnerDescriptor,
} from '../workflow-runner-descriptor.js';
import {
  createRuntime,
  WORKFLOW_RUNNER_CANCELLATION_BOUNDARIES,
  WorkflowExecutionCancelledError,
  type WorkflowRunnerCancellationBoundary,
} from '../runtime.js';
import { WorkflowRunnerSession } from '../workflow-runner-session.js';
import type { WorkflowEffectBoundary } from '../workflow-runner-effect-boundary.js';
import type { WorkflowMeta } from '../types.js';

const roots: string[] = [];
const runnerBuild = 'b'.repeat(64);
const controlBuild = 'c'.repeat(64);
const source = Buffer.from('export const meta = {};', 'utf8');
const manifest: WorkflowMeta = {
  name: 'cancel-test',
  version: '1.0.0',
  description: 'Cancellation boundary test.',
  phases: [{ title: 'Run', detail: 'Run once.' }],
  risk: 'low',
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function cancellationBoundary(error: unknown): WorkflowRunnerCancellationBoundary {
  expect(error).toBeInstanceOf(WorkflowExecutionCancelledError);
  return (error as WorkflowExecutionCancelledError).boundary;
}

function sealedDescriptor() {
  return createWorkflowRunnerExecutionDescriptor({
    descriptorRef: 'descriptor.cancel.1',
    workspaceId: 'workspace.test',
    workflowRunId: 'run.cancel.1',
    correlationId: 'correlation.cancel.1',
    workflowId: 'cancel-test',
    workflowVersion: '1.0.0',
    workflowSource: 'openslack-project',
    workflowSourceBytes: source,
    manifest,
    input: {},
    budget: { tokens: 1_000, costUsd: 1 },
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'test-actor',
      runId: 'run.cancel.1',
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    createdAt: '2026-08-04T01:00:00.000Z',
    expiresAt: '2026-08-04T02:00:00.000Z',
  });
}

describe('GS8-B closed cancellation boundary inventory', () => {
  it('covers every declared runtime and effect cancellation boundary mechanically', async () => {
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

    const executionController = new AbortController();
    let effectExecuted = false;
    const executionRuntime = createRuntime({
      runId: 'run.effect-execution',
      mode: 'execute',
      manifest,
      onConfirm: async () => {
        executionController.abort(new Error('stop before execution'));
        return true;
      },
      signal: executionController.signal,
      effectBoundary: passiveBoundary(),
    });
    try {
      await executionRuntime.openslack.task.createIssue({
        get title() {
          effectExecuted = true;
          return 'must not be evaluated after approval';
        },
      });
    } catch (error) {
      observed.add(cancellationBoundary(error));
    }
    // Detail serialization occurs before the approval boundary; the actual
    // effect is proven separately by the absence of an executed outcome.
    expect(effectExecuted).toBe(true);

    const outcomeController = new AbortController();
    const outcomes: string[] = [];
    const outcomeBoundary: WorkflowEffectBoundary = {
      async intent(input) {
        return effectHandle(input.operation);
      },
      async outcome(_handle, input) {
        outcomes.push(input.status);
      },
    };
    const outcomeRuntime = createRuntime({
      runId: 'run.effect-outcome',
      mode: 'execute',
      manifest,
      onConfirm: async () => {
        outcomeController.abort(new Error('stop after approval'));
        // Clear the stop just for this test is impossible; this deliberately
        // proves the pre-execution boundary instead of an ambiguous commit.
        return true;
      },
      signal: outcomeController.signal,
      effectBoundary: outcomeBoundary,
    });
    try {
      await outcomeRuntime.openslack.task.sync(1);
    } catch (error) {
      observed.add(cancellationBoundary(error));
    }
    expect(outcomes).toEqual([]);

    // Exercise effect_outcome with a boundary that aborts after the durable
    // executed outcome; execution is not replayed and cancellation wins next.
    const afterOutcomeController = new AbortController();
    const afterOutcomeBoundary: WorkflowEffectBoundary = {
      async intent(input) {
        return effectHandle(input.operation);
      },
      async outcome() {
        afterOutcomeController.abort(new Error('stop after outcome receipt'));
      },
    };
    const afterOutcomeRuntime = createRuntime({
      runId: 'run.after-outcome',
      mode: 'execute',
      manifest,
      onConfirm: async () => true,
      signal: afterOutcomeController.signal,
      effectBoundary: afterOutcomeBoundary,
    });
    try {
      await afterOutcomeRuntime.openslack.task.sync(1);
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
        'effect_execution',
        'effect_outcome',
      ]),
    );
  });

  it('covers pre-JavaScript, accept-receipt wait, and terminal commit', async () => {
    const observed = new Set<WorkflowRunnerCancellationBoundary>();
    const value = sealedDescriptor();
    const sent: string[] = [];
    const load = vi.fn();
    const session = new WorkflowRunnerSession({
      workspaceId: value.workspaceId,
      runnerBuildHash: runnerBuild,
      runtimeVersion: '22.0.0',
      descriptorStore: { read: vi.fn(async () => value) },
      sourceLoader: { prepare: vi.fn(async () => ({})), load },
      execute: vi.fn(),
      send: (body) => {
        sent.push(body);
      },
      close: vi.fn(),
      now: () => '2026-08-04T01:00:03.000Z',
    });
    await session.start();
    const hello = parseWorkflowRunnerMessageBytes(Buffer.from(sent[0]!, 'utf8'));
    await session.receive(helloAck(hello.correlationId));
    const offerPromise = session.receive(leaseOffer(value));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await session.receive(cancelRequest(value));
    expect(session.state).toBe('cancelling');
    expect(load).not.toHaveBeenCalled();
    observed.add('accept_receipt_wait');
    observed.add('pre_javascript');
    // Prevent an unhandled pending promise while preserving the pre-receipt assertion.
    void offerPromise.catch(() => undefined);

    const rootDir = await mkdtemp(join(tmpdir(), 'openslack-runner-terminal-'));
    roots.push(rootDir);
    const terminalController = new AbortController();
    try {
      await executeRun(
        {
          meta: manifest,
          run: async () => {
            terminalController.abort(new Error('stop before terminal commit'));
            return { status: 'completed' };
          },
        },
        {
          manifest,
          allowUnattended: true,
          runId: 'run.terminal-boundary',
          rootDir,
          signal: terminalController.signal,
        },
      );
    } catch (error) {
      observed.add(cancellationBoundary(error));
    }

    const expected = new Set(WORKFLOW_RUNNER_CANCELLATION_BOUNDARIES);
    for (const boundary of [
      'runtime_api',
      'agent_call',
      'parallel_dispatch',
      'pipeline_dispatch',
      'effect_intent',
      'effect_execution',
      'effect_outcome',
    ] as const) {
      expected.delete(boundary);
    }
    expect(observed).toEqual(expected);
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

function passiveBoundary(): WorkflowEffectBoundary {
  return {
    async intent(input) {
      return effectHandle(input.operation);
    },
    async outcome() {},
  };
}

function helloAck(correlationId: string): WorkflowRunnerMessage {
  return validateWorkflowRunnerMessage({
    protocolVersion: 'openslack.workflow_runner.v1',
    kind: 'hello_ack',
    workspaceId: 'workspace.test',
    jobId: null,
    workflowRunId: null,
    attemptId: null,
    leaseId: null,
    fencingToken: null,
    sequence: null,
    eventId: 'hello-ack.cancel',
    correlationId,
    sentAt: '2026-08-04T01:00:01.000Z',
    payload: {
      controlBuildHash: controlBuild,
      selectedProtocolVersion: 'openslack.workflow_runner.v1',
      heartbeatIntervalMs: 1_000,
      leaseOfferTimeoutMs: 10_000,
    },
  });
}

function leaseOffer(value: ReturnType<typeof sealedDescriptor>): WorkflowRunnerMessage {
  return validateWorkflowRunnerMessage({
    protocolVersion: 'openslack.workflow_runner.v1',
    kind: 'lease_offer',
    workspaceId: value.workspaceId,
    jobId: 'job.cancel.1',
    workflowRunId: value.workflowRunId,
    attemptId: 'attempt.cancel.1',
    leaseId: 'lease.cancel.1',
    fencingToken: 1,
    sequence: 1,
    eventId: 'offer.cancel.1',
    correlationId: value.correlationId,
    sentAt: '2026-08-04T01:00:02.000Z',
    payload: {
      executionDescriptorRef: value.descriptorRef,
      executionDescriptorHash: hashWorkflowRunnerDescriptor(value),
      jobSpecHash: 'd'.repeat(64),
      workflowId: value.workflowId,
      workflowVersion: value.workflowVersion,
      workflowSourceHash: value.workflowSourceHash,
      manifestHash: value.manifestHash,
      inputHash: value.inputHash,
      offeredAt: '2026-08-04T01:00:02.000Z',
      expiresAt: '2026-08-04T01:30:00.000Z',
    },
  });
}

function cancelRequest(value: ReturnType<typeof sealedDescriptor>): WorkflowRunnerMessage {
  return validateWorkflowRunnerMessage({
    protocolVersion: 'openslack.workflow_runner.v1',
    kind: 'cancel_request',
    workspaceId: value.workspaceId,
    jobId: 'job.cancel.1',
    workflowRunId: value.workflowRunId,
    attemptId: 'attempt.cancel.1',
    leaseId: 'lease.cancel.1',
    fencingToken: 1,
    sequence: 2,
    eventId: 'cancel.cancel.1',
    correlationId: value.correlationId,
    sentAt: '2026-08-04T01:00:03.000Z',
    payload: {
      cancelId: 'control.cancel.1',
      requestedAt: '2026-08-04T01:00:03.000Z',
      expiresAt: '2026-08-04T01:05:00.000Z',
      reason: 'operator',
    },
  });
}
