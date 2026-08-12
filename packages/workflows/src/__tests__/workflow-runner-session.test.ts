import { describe, expect, it, vi } from 'vitest';
import {
  createWorkflowRunnerEventReceipt,
  parseWorkflowRunnerMessageBytes,
  validateWorkflowRunnerMessage,
  type WorkflowRunnerMessage,
} from '../workflow-runner-contract.js';
import {
  createWorkflowRunnerExecutionDescriptor,
  hashWorkflowRunnerDescriptor,
} from '../workflow-runner-descriptor.js';
import { WorkflowRunnerSession } from '../workflow-runner-session.js';
import type { RunResult, WorkflowMeta, WorkflowModule } from '../types.js';

const CONTROL_BUILD = 'c'.repeat(64);
const RUNNER_BUILD = 'b'.repeat(64);
const SOURCE = Buffer.from('export const meta = {};', 'utf8');
const manifest: WorkflowMeta = {
  name: 'sealed-test',
  version: '1.0.0',
  description: 'Session test.',
  phases: [{ title: 'Run', detail: 'Run once.' }],
  risk: 'low',
};

function descriptor() {
  return createWorkflowRunnerExecutionDescriptor({
    descriptorRef: 'descriptor.session.1',
    workspaceId: 'workspace.test',
    workflowRunId: 'run.session.1',
    correlationId: 'correlation.session.1',
    workflowId: 'sealed-test',
    workflowVersion: '1.0.0',
    workflowSource: 'openslack-project',
    workflowSourceBytes: SOURCE,
    manifest,
    input: {},
    budget: { tokens: 1_000, costUsd: 1 },
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'test-actor',
      runId: 'run.session.1',
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    createdAt: '2026-08-04T01:00:00.000Z',
    expiresAt: '2026-08-04T02:00:00.000Z',
  });
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
    eventId: 'hello-ack.test',
    correlationId,
    sentAt: '2026-08-04T01:00:01.000Z',
    payload: {
      controlBuildHash: CONTROL_BUILD,
      selectedProtocolVersion: 'openslack.workflow_runner.v1',
      heartbeatIntervalMs: 1_000,
      leaseOfferTimeoutMs: 10_000,
    },
  });
}

function offer(value = descriptor()): WorkflowRunnerMessage {
  return validateWorkflowRunnerMessage({
    protocolVersion: 'openslack.workflow_runner.v1',
    kind: 'lease_offer',
    workspaceId: 'workspace.test',
    jobId: 'job.session.1',
    workflowRunId: value.workflowRunId,
    attemptId: 'attempt.session.1',
    leaseId: 'lease.session.1',
    fencingToken: 1,
    sequence: 1,
    eventId: 'lease-offer.test',
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

function receipt(received: WorkflowRunnerMessage, sequence: number): WorkflowRunnerMessage {
  return createWorkflowRunnerEventReceipt(received, {
    sequence,
    sentAt: `2026-08-04T01:00:${String(sequence + 2).padStart(2, '0')}.000Z`,
    status: 'accepted',
    controlBuildHash: CONTROL_BUILD,
    errorCode: null,
  });
}

function parsedAt(sent: string[], index: number): WorkflowRunnerMessage {
  return parseWorkflowRunnerMessageBytes(Buffer.from(sent[index]!, 'utf8'));
}

async function waitForSent(sent: string[], count: number): Promise<void> {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(count));
}

describe('GS8-B strict worker session', () => {
  it('does not load or execute JavaScript before the lease_accept receipt', async () => {
    const value = descriptor();
    const sent: string[] = [];
    const closed: number[] = [];
    let clockOffset = 0;
    const prepare = vi.fn(async () => ({ sourceHash: value.workflowSourceHash }));
    const load = vi.fn(
      async (): Promise<WorkflowModule> => ({
        meta: manifest,
        format: 'openslack-native',
        hash: 'legacy-hash',
        run: async () => ({ status: 'completed' }),
      }),
    );
    let finish!: (result: RunResult) => void;
    const execute = vi.fn(
      (_workflow: WorkflowModule, _descriptor: unknown, _context: unknown) =>
        new Promise<RunResult>((resolve) => {
          finish = resolve;
        }),
    );
    const session = new WorkflowRunnerSession({
      workspaceId: value.workspaceId,
      runnerBuildHash: RUNNER_BUILD,
      runtimeVersion: '22.0.0',
      descriptorStore: { read: vi.fn(async () => value) },
      sourceLoader: { prepare, load },
      execute,
      send: (body) => {
        sent.push(body);
      },
      close: (code) => {
        closed.push(code);
      },
      now: () => new Date(Date.parse('2026-08-04T01:00:03.000Z') + clockOffset++).toISOString(),
    });

    await session.start();
    const hello = parsedAt(sent, 0);
    await session.receive(helloAck(hello.correlationId));
    const offerPromise = session.receive(offer(value));
    await waitForSent(sent, 2);
    const accept = parsedAt(sent, 1);
    expect(accept.kind).toBe('lease_accept');
    if (accept.kind !== 'lease_accept') throw new Error('expected lease_accept');
    expect(accept.payload.acceptedAt).toBe(accept.sentAt);
    expect(prepare).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    await session.receive(receipt(accept, 2));
    await offerPromise;
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[2]).toMatchObject({
      checkpointAuthority: { kind: 'accepted_workflow_runner_lease' },
    });

    finish({ status: 'completed' });
    await waitForSent(sent, 3);
    const terminal = parsedAt(sent, 2);
    expect(terminal).toMatchObject({ kind: 'terminal', payload: { status: 'completed' } });
    if (terminal.kind !== 'terminal') throw new Error('expected terminal');
    expect(terminal.payload.finishedAt).toBe(terminal.sentAt);
    expect(closed).toEqual([]);
    await session.receive(receipt(terminal, 3));
    await vi.waitFor(() => expect(closed).toEqual([0]));
    expect(session.state).toBe('closed');
  });

  it('retries the exact outstanding bytes and queues cancel_ack behind its receipt', async () => {
    const value = descriptor();
    const sent: string[] = [];
    const closed: number[] = [];
    const session = new WorkflowRunnerSession({
      workspaceId: value.workspaceId,
      runnerBuildHash: RUNNER_BUILD,
      runtimeVersion: '22.0.0',
      descriptorStore: { read: vi.fn(async () => value) },
      sourceLoader: {
        prepare: vi.fn(async () => ({})),
        load: vi.fn(
          async (): Promise<WorkflowModule> => ({
            meta: manifest,
            format: 'openslack-native',
            hash: 'legacy-hash',
            run: async () => ({ status: 'completed' }),
          }),
        ),
      },
      execute: async (_workflow, _descriptor, context) =>
        new Promise<RunResult>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          });
        }),
      send: (body) => {
        sent.push(body);
      },
      close: (code) => {
        closed.push(code);
      },
      now: () => '2026-08-04T01:00:03.000Z',
    });
    await session.start();
    const hello = parsedAt(sent, 0);
    await session.receive(helloAck(hello.correlationId));
    const offerPromise = session.receive(offer(value));
    await waitForSent(sent, 2);
    const accept = parsedAt(sent, 1);
    expect(await session.retryOutstanding()).toBe(true);
    expect(sent[2]).toBe(sent[1]);

    const cancel = validateWorkflowRunnerMessage({
      protocolVersion: 'openslack.workflow_runner.v1',
      kind: 'cancel_request',
      workspaceId: 'workspace.test',
      jobId: 'job.session.1',
      workflowRunId: value.workflowRunId,
      attemptId: 'attempt.session.1',
      leaseId: 'lease.session.1',
      fencingToken: 1,
      sequence: 2,
      eventId: 'cancel.test',
      correlationId: value.correlationId,
      sentAt: '2026-08-04T01:00:03.000Z',
      payload: {
        cancelId: 'cancel.control.1',
        requestedAt: '2026-08-04T01:00:03.000Z',
        expiresAt: '2026-08-04T01:05:00.000Z',
        reason: 'operator',
      },
    });
    await session.receive(cancel);
    expect(sent).toHaveLength(3);

    await session.receive(receipt(accept, 3));
    await offerPromise;
    await waitForSent(sent, 4);
    const cancelAck = parsedAt(sent, 3);
    expect(cancelAck).toMatchObject({
      kind: 'cancel_ack',
      payload: { cancelId: 'cancel.control.1' },
    });
    await session.receive(receipt(cancelAck, 4));
    await waitForSent(sent, 5);
    const terminal = parsedAt(sent, 4);
    expect(terminal).toMatchObject({ kind: 'terminal', payload: { status: 'cancelled' } });
    await session.receive(receipt(terminal, 5));
    await vi.waitFor(() => expect(closed).toEqual([0]));
  });

  it('queues already_terminal cancel_ack behind the terminal receipt before closing', async () => {
    const value = descriptor();
    const sent: string[] = [];
    const closed: number[] = [];
    let executionSignal: AbortSignal | undefined;
    const session = new WorkflowRunnerSession({
      workspaceId: value.workspaceId,
      runnerBuildHash: RUNNER_BUILD,
      runtimeVersion: '22.0.0',
      descriptorStore: { read: vi.fn(async () => value) },
      sourceLoader: {
        prepare: vi.fn(async () => ({})),
        load: vi.fn(
          async (): Promise<WorkflowModule> => ({
            meta: manifest,
            format: 'openslack-native',
            hash: 'legacy-hash',
            run: async () => ({ status: 'completed' }),
          }),
        ),
      },
      execute: async (_workflow, _descriptor, context) => {
        executionSignal = context.signal;
        return { status: 'completed' };
      },
      send: (body) => {
        sent.push(body);
      },
      close: (code) => {
        closed.push(code);
      },
      now: () => '2026-08-04T01:00:03.000Z',
    });

    await session.start();
    const hello = parsedAt(sent, 0);
    await session.receive(helloAck(hello.correlationId));
    const offerPromise = session.receive(offer(value));
    await waitForSent(sent, 2);
    const accept = parsedAt(sent, 1);
    await session.receive(receipt(accept, 2));
    await offerPromise;
    await waitForSent(sent, 3);
    const terminal = parsedAt(sent, 2);
    expect(terminal).toMatchObject({
      kind: 'terminal',
      sequence: 2,
      payload: { status: 'completed' },
    });
    expect(session.state).toBe('waiting_terminal_receipt');
    expect(executionSignal?.aborted).toBe(false);
    expect(closed).toEqual([]);

    await session.receive(cancelRequest(value, 3));
    expect(sent).toHaveLength(3);
    expect(session.state).toBe('waiting_terminal_receipt');
    expect(executionSignal?.aborted).toBe(false);
    expect(closed).toEqual([]);

    await session.receive(receipt(terminal, 4));
    await waitForSent(sent, 4);
    const cancelAck = parsedAt(sent, 3);
    expect(cancelAck).toMatchObject({
      kind: 'cancel_ack',
      sequence: 3,
      payload: {
        cancelId: 'cancel.control.3',
        status: 'already_terminal',
      },
    });
    expect(closed).toEqual([]);
    expect(session.state).toBe('waiting_terminal_receipt');

    await session.receive(receipt(cancelAck, 5));
    await vi.waitFor(() => expect(closed).toEqual([0]));
    expect(session.state).toBe('closed');
    expect(sent.map(parsedBody).map((message) => message.kind)).toEqual([
      'hello',
      'lease_accept',
      'terminal',
      'cancel_ack',
    ]);
  });

  it('ignores an obsolete cancel after the terminal receipt while close is settling', async () => {
    const value = descriptor();
    const sent: string[] = [];
    const closed: number[] = [];
    const session = new WorkflowRunnerSession({
      workspaceId: value.workspaceId,
      runnerBuildHash: RUNNER_BUILD,
      runtimeVersion: '22.0.0',
      descriptorStore: { read: vi.fn(async () => value) },
      sourceLoader: {
        prepare: vi.fn(async () => ({})),
        load: vi.fn(
          async (): Promise<WorkflowModule> => ({
            meta: manifest,
            format: 'openslack-native',
            hash: 'legacy-hash',
            run: async () => ({ status: 'completed' }),
          }),
        ),
      },
      execute: async () => ({ status: 'completed' }),
      send: (body) => {
        sent.push(body);
      },
      close: (code) => {
        closed.push(code);
      },
      now: () => '2026-08-04T01:00:03.000Z',
    });

    await session.start();
    const hello = parsedAt(sent, 0);
    await session.receive(helloAck(hello.correlationId));
    const offerPromise = session.receive(offer(value));
    await waitForSent(sent, 2);
    const accept = parsedAt(sent, 1);
    await session.receive(receipt(accept, 2));
    await offerPromise;
    await waitForSent(sent, 3);
    const terminal = parsedAt(sent, 2);

    const terminalReceipt = session.receive(receipt(terminal, 3));
    expect(session.state).toBe('waiting_terminal_receipt');
    await expect(session.receive(cancelRequest(value, 4))).resolves.toBeUndefined();
    await terminalReceipt;
    await vi.waitFor(() => expect(closed).toEqual([0]));
    expect(session.state).toBe('closed');
    expect(sent.map(parsedBody).map((message) => message.kind)).toEqual([
      'hello',
      'lease_accept',
      'terminal',
    ]);
  });

  it('seals terminal emission before draining an outstanding heartbeat', async () => {
    const value = descriptor();
    const sent: string[] = [];
    const closed: number[] = [];
    let finish!: (result: RunResult) => void;
    const session = new WorkflowRunnerSession({
      workspaceId: value.workspaceId,
      runnerBuildHash: RUNNER_BUILD,
      runtimeVersion: '22.0.0',
      descriptorStore: { read: vi.fn(async () => value) },
      sourceLoader: {
        prepare: vi.fn(async () => ({})),
        load: vi.fn(
          async (): Promise<WorkflowModule> => ({
            meta: manifest,
            format: 'openslack-native',
            hash: 'legacy-hash',
            run: async () => ({ status: 'completed' }),
          }),
        ),
      },
      execute: async () =>
        new Promise<RunResult>((resolve) => {
          finish = resolve;
        }),
      send: (body) => {
        sent.push(body);
      },
      close: (code) => {
        closed.push(code);
      },
      now: () => '2026-08-04T01:00:03.000Z',
    });

    await session.start();
    const hello = parsedAt(sent, 0);
    await session.receive(helloAck(hello.correlationId));
    const offerPromise = session.receive(offer(value));
    await waitForSent(sent, 2);
    const accept = parsedAt(sent, 1);
    await session.receive(receipt(accept, 2));
    await offerPromise;

    expect(await session.heartbeat()).toBe(true);
    await waitForSent(sent, 3);
    const heartbeat = parsedAt(sent, 2);
    expect(heartbeat.kind).toBe('heartbeat');
    finish({ status: 'completed' });
    await vi.waitFor(() => expect(session.state).toBe('waiting_terminal_receipt'));
    expect(session.hasOutstandingEvent).toBe(true);
    expect(await session.heartbeat()).toBe(false);

    await session.receive(receipt(heartbeat, 3));
    await waitForSent(sent, 4);
    const terminal = parsedAt(sent, 3);
    expect(terminal).toMatchObject({ kind: 'terminal', payload: { status: 'completed' } });
    await session.receive(receipt(terminal, 4));
    await vi.waitFor(() => expect(closed).toEqual([0]));
    expect(session.state).toBe('closed');
  });

  it('binds hello_ack to the exact generated pre-lease negotiation identity', async () => {
    const sent: string[] = [];
    const session = new WorkflowRunnerSession({
      workspaceId: 'workspace.test',
      runnerBuildHash: RUNNER_BUILD,
      runtimeVersion: '22.0.0',
      descriptorStore: { read: vi.fn() },
      sourceLoader: { prepare: vi.fn(), load: vi.fn() },
      execute: vi.fn(),
      send: (body) => {
        sent.push(body);
      },
      close: vi.fn(),
      now: () => '2026-08-04T01:00:00.000Z',
    });

    await session.start();
    const hello = parsedAt(sent, 0);
    expect(hello).toMatchObject({
      kind: 'hello',
      payload: {
        runnerBuildHash: RUNNER_BUILD,
        capabilities: ['cancel_ack', 'effect_receipts', 'lease_heartbeat'],
        maxConcurrentJobs: 1,
      },
    });
    await expect(session.receive(helloAck('session.wrong'))).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_SESSION_IDENTITY',
    });
    expect(session.state).toBe('waiting_hello_ack');
    await expect(session.receive(helloAck(hello.correlationId))).resolves.toBeUndefined();
    expect(session.state).toBe('idle');
  });

  it('does not turn an invalid descriptor binding into a semantic lease rejection', async () => {
    const value = descriptor();
    const sent: string[] = [];
    const session = new WorkflowRunnerSession({
      workspaceId: value.workspaceId,
      runnerBuildHash: RUNNER_BUILD,
      runtimeVersion: '22.0.0',
      descriptorStore: { read: vi.fn(async () => ({ ...value, inputHash: 'f'.repeat(64) })) },
      sourceLoader: { prepare: vi.fn(), load: vi.fn() },
      execute: vi.fn(),
      send: (body) => {
        sent.push(body);
      },
      close: vi.fn(),
      now: () => '2026-08-04T01:00:03.000Z',
    });

    await session.start();
    const hello = parsedAt(sent, 0);
    await session.receive(helloAck(hello.correlationId));
    await expect(session.receive(offer(value))).rejects.toBeDefined();
    expect(sent).toHaveLength(1);
  });

  it('accepts exact cancellation while source validation is still pending', async () => {
    const value = descriptor();
    const sent: string[] = [];
    const closed: number[] = [];
    let releasePrepare!: () => void;
    const prepare = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          releasePrepare = () => resolve({});
        }),
    );
    const load = vi.fn();
    const session = new WorkflowRunnerSession({
      workspaceId: value.workspaceId,
      runnerBuildHash: RUNNER_BUILD,
      runtimeVersion: '22.0.0',
      descriptorStore: { read: vi.fn(async () => value) },
      sourceLoader: { prepare, load },
      execute: vi.fn(),
      send: (body) => {
        sent.push(body);
      },
      close: (code) => {
        closed.push(code);
      },
      now: () => '2026-08-04T01:00:03.000Z',
    });
    await session.start();
    const hello = parsedAt(sent, 0);
    await session.receive(helloAck(hello.correlationId));
    const offerPromise = session.receive(offer(value));
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    await session.receive(cancelRequest(value, 2));
    expect(session.state).toBe('cancelling');
    expect(sent).toHaveLength(1);

    releasePrepare();
    await waitForSent(sent, 2);
    const accept = parsedAt(sent, 1);
    await session.receive(receipt(accept, 3));
    await offerPromise;
    await waitForSent(sent, 3);
    const cancelAck = parsedAt(sent, 2);
    expect(cancelAck.kind).toBe('cancel_ack');
    await session.receive(receipt(cancelAck, 4));
    await waitForSent(sent, 4);
    const terminal = parsedAt(sent, 3);
    expect(terminal).toMatchObject({ kind: 'terminal', payload: { status: 'cancelled' } });
    expect(load).not.toHaveBeenCalled();
    await session.receive(receipt(terminal, 5));
    await vi.waitFor(() => expect(closed).toEqual([0]));
  });

  it('does not emit a failed terminal when executed-outcome delivery fails', async () => {
    const value = descriptor();
    const sent: string[] = [];
    const closed: number[] = [];
    const execute = effectExecution();
    const session = effectSession(value, sent, closed, execute, (body) => {
      const message = parseWorkflowRunnerMessageBytes(Buffer.from(body, 'utf8'));
      sent.push(body);
      if (message.kind === 'effect_outcome') throw new Error('control pipe unavailable');
    });

    const outcome = await driveToEffectOutcome(session, value, sent);
    expect(outcome.kind).toBe('effect_outcome');
    await vi.waitFor(() => expect(closed).toEqual([2]));
    expect(execute).toHaveBeenCalledOnce();
    expect(sent.map((body) => parsedBody(body).kind)).not.toContain('terminal');
  });

  it('stops without a failed terminal when an executed-outcome receipt requires reconciliation', async () => {
    const value = descriptor();
    const sent: string[] = [];
    const closed: number[] = [];
    const execute = effectExecution();
    const session = effectSession(value, sent, closed, execute);

    const outcome = await driveToEffectOutcome(session, value, sent);
    await session.receive(
      createWorkflowRunnerEventReceipt(outcome, {
        sequence: 4,
        sentAt: '2026-08-04T01:00:06.000Z',
        status: 'reconciliation_required',
        controlBuildHash: CONTROL_BUILD,
        errorCode: 'WORKFLOW_RUNNER_RECONCILIATION_REQUIRED',
      }),
    );
    await vi.waitFor(() => expect(closed).toEqual([2]));
    expect(execute).toHaveBeenCalledOnce();
    expect(sent.map((body) => parsedBody(body).kind)).not.toContain('terminal');
  });
});

function cancelRequest(value: ReturnType<typeof descriptor>, sequence: number) {
  return validateWorkflowRunnerMessage({
    protocolVersion: 'openslack.workflow_runner.v1',
    kind: 'cancel_request',
    workspaceId: value.workspaceId,
    jobId: 'job.session.1',
    workflowRunId: value.workflowRunId,
    attemptId: 'attempt.session.1',
    leaseId: 'lease.session.1',
    fencingToken: 1,
    sequence,
    eventId: `cancel.test.${sequence}`,
    correlationId: value.correlationId,
    sentAt: '2026-08-04T01:00:03.000Z',
    payload: {
      cancelId: `cancel.control.${sequence}`,
      requestedAt: '2026-08-04T01:00:03.000Z',
      expiresAt: '2026-08-04T01:05:00.000Z',
      reason: 'operator',
    },
  });
}

function parsedBody(body: string): WorkflowRunnerMessage {
  return parseWorkflowRunnerMessageBytes(Buffer.from(body, 'utf8'));
}

function effectExecution() {
  return vi.fn(
    async (
      _workflow: WorkflowModule,
      _descriptor: unknown,
      context: {
        effectBoundary: {
          intent(input: { runId: string; operation: string; detail: string }): Promise<unknown>;
          outcome(handle: unknown, input: { status: 'executed'; evidence: unknown }): Promise<void>;
        };
      },
    ) => {
      const handle = await context.effectBoundary.intent({
        runId: 'run.session.1',
        operation: 'openslack.task.sync',
        detail: 'sync',
      });
      await context.effectBoundary.outcome(handle, { status: 'executed', evidence: { ok: true } });
      return { status: 'completed' };
    },
  );
}

function effectSession(
  value: ReturnType<typeof descriptor>,
  sent: string[],
  closed: number[],
  execute: ReturnType<typeof effectExecution>,
  send: (body: string) => void = (body) => {
    sent.push(body);
  },
) {
  return new WorkflowRunnerSession({
    workspaceId: value.workspaceId,
    runnerBuildHash: RUNNER_BUILD,
    runtimeVersion: '22.0.0',
    descriptorStore: { read: vi.fn(async () => value) },
    sourceLoader: {
      prepare: vi.fn(async () => ({})),
      load: vi.fn(
        async (): Promise<WorkflowModule> => ({
          meta: manifest,
          format: 'openslack-native',
          hash: 'legacy-hash',
          run: async () => ({ status: 'completed' }),
        }),
      ),
    },
    execute: execute as never,
    send,
    close: (code) => {
      closed.push(code);
    },
    now: () => '2026-08-04T01:00:03.000Z',
  });
}

async function driveToEffectOutcome(
  session: WorkflowRunnerSession,
  value: ReturnType<typeof descriptor>,
  sent: string[],
): Promise<WorkflowRunnerMessage> {
  await session.start();
  const hello = parsedAt(sent, 0);
  await session.receive(helloAck(hello.correlationId));
  const offerPromise = session.receive(offer(value));
  await waitForSent(sent, 2);
  const accept = parsedAt(sent, 1);
  await session.receive(receipt(accept, 2));
  await offerPromise;
  await waitForSent(sent, 3);
  const intent = parsedAt(sent, 2);
  expect(intent.kind).toBe('effect_intent');
  await session.receive(receipt(intent, 3));
  await vi.waitFor(() => {
    const outcome = sent.map(parsedBody).find((message) => message.kind === 'effect_outcome');
    expect(outcome).toBeDefined();
  });
  return sent.map(parsedBody).find((message) => message.kind === 'effect_outcome')!;
}
