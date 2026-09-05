import { describe, expect, it } from 'vitest';
import {
  prepareWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityMessage,
  WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
  WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
  type WorkflowControlAuthorityRoute,
  type WorkflowControlAuthorityMessage,
} from '../workflow-control-authority-contract.js';
import {
  WORKFLOW_RUNNER_CAPABILITIES,
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
} from '../workflow-runner-contract.js';
import { hashWorkflowRunnerV2Descriptor } from '../workflow-runner-v2-descriptor.js';
import {
  WorkflowRunnerV2Session,
  workflowRunnerV2BudgetDecisionMatchesRequest,
  type WorkflowRunnerV2ExecutionContext,
  type WorkflowRunnerV2RuntimeDeliveryPort,
} from '../workflow-runner-v2-session.js';
import type { RunResult } from '../types.js';
import { workflowRunnerV2DescriptorFixture } from './workflow-runner-v2-test-fixture.js';

const NOW = '2026-08-15T02:00:00.000Z';
const LATER = '2026-08-15T02:05:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const source = Buffer.from('export const workflow = true;');

function descriptor(
  resumeGeneration: number,
  authorityRoute: WorkflowControlAuthorityRoute = {
    backend: 'ts-local' as const,
    authority: 'typescript' as const,
    routingEpoch: 1,
    authorityBuildHash: HASH_A,
  },
) {
  return workflowRunnerV2DescriptorFixture({
    descriptorRef: `descriptor.v2.${resumeGeneration}`,
    workspaceId: 'workspace.v2',
    workflowRunId: `run.v2.${resumeGeneration}`,
    correlationId: `correlation.v2.${resumeGeneration}`,
    workflowId: 'workflow-v2',
    workflowVersion: '1.0.0',
    workflowSource: 'openslack-project',
    workflowSourceBytes: source,
    manifest: {
      name: 'workflow-v2',
      version: '1.0.0',
      description: 'v2 qualification',
      risk: 'low',
      phases: [{ title: 'Phase one', detail: 'Exercise the v2 qualification lane.' }],
      permissions: {},
    },
    input: { qualification: true },
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'qualification-host',
      runId: `run.v2.${resumeGeneration}`,
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    requiredCapabilities: WORKFLOW_RUNNER_CAPABILITIES,
    authorityRoute,
    runRevision: 1,
    resumeGeneration,
    budgetPolicy: {
      accountId: 'budget.v2',
      policyHash: HASH_B,
      rateNanoUsdPerToken: '10',
      tokenLimit: '1000',
      costLimitNanoUsd: '10000',
      callLimit: '2',
    },
    createdAt: NOW,
    expiresAt: LATER,
  });
}

function controlMessage(input: {
  kind: WorkflowControlAuthorityMessage['kind'];
  workspaceId?: string;
  jobId?: string | null;
  workflowRunId?: string | null;
  attemptId?: string | null;
  leaseId?: string | null;
  fencingToken?: number | null;
  sequence?: number | null;
  runRevision?: number | null;
  resumeGeneration?: number | null;
  authorityBackend?: 'ts-local' | 'go' | null;
  authority?: 'typescript' | 'workflow-control' | null;
  routingEpoch?: number | null;
  authorityBuildHash?: string | null;
  correlationId: string;
  sentAt?: string;
  payload: Readonly<Record<string, unknown>>;
}): WorkflowControlAuthorityMessage {
  const handshake = input.kind === 'hello' || input.kind === 'hello_ack';
  return validateWorkflowControlAuthorityMessage({
    schema: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
    protocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    kind: input.kind,
    workspaceId: input.workspaceId ?? 'workspace.v2',
    jobId: handshake ? null : (input.jobId ?? 'job.v2'),
    workflowRunId: handshake ? null : (input.workflowRunId ?? 'run.v2.0'),
    attemptId: handshake ? null : (input.attemptId ?? 'attempt.v2'),
    leaseId: handshake ? null : (input.leaseId ?? 'lease.v2'),
    fencingToken: handshake ? null : (input.fencingToken ?? 1),
    sequence: handshake ? null : (input.sequence ?? 1),
    authorityBackend: handshake ? null : (input.authorityBackend ?? 'ts-local'),
    authority: handshake ? null : (input.authority ?? 'typescript'),
    routingEpoch: handshake ? null : (input.routingEpoch ?? 1),
    authorityBuildHash: handshake ? null : (input.authorityBuildHash ?? HASH_A),
    runRevision: handshake ? null : (input.runRevision ?? 1),
    resumeGeneration: handshake ? null : (input.resumeGeneration ?? 0),
    eventId: `control-${input.kind}-${input.sequence ?? 0}`,
    correlationId: input.correlationId,
    sentAt: input.sentAt ?? NOW,
    payload: input.payload,
  });
}

function leaseOffer(value: ReturnType<typeof descriptor>, sequence = 1) {
  return controlMessage({
    kind: 'lease_offer',
    workflowRunId: value.workflowRunId,
    resumeGeneration: value.resumeGeneration,
    authorityBackend: value.authorityRoute.backend,
    authority: value.authorityRoute.authority,
    routingEpoch: value.authorityRoute.routingEpoch,
    authorityBuildHash: value.authorityRoute.authorityBuildHash,
    sequence,
    correlationId: value.correlationId,
    payload: {
      executionDescriptorRef: value.descriptorRef,
      executionDescriptorHash: hashWorkflowRunnerV2Descriptor(value),
      jobSpecHash: HASH_C,
      workflowId: value.workflowId,
      workflowVersion: value.workflowVersion,
      workflowSourceHash: value.workflowSourceHash,
      manifestHash: value.manifestHash,
      inputHash: value.inputHash,
      offeredAt: NOW,
      expiresAt: LATER,
    },
  });
}

function receipt(
  event: WorkflowControlAuthorityMessage,
  controlSequence: number,
  runRevision = 1,
  resumeGeneration = event.resumeGeneration,
  status: 'accepted' | 'reconciliation_required' = 'accepted',
) {
  const prepared = prepareWorkflowControlAuthorityMessage(event);
  return controlMessage({
    kind: 'event_receipt',
    workflowRunId: event.workflowRunId,
    jobId: event.jobId,
    attemptId: event.attemptId,
    leaseId: event.leaseId,
    fencingToken: event.fencingToken,
    sequence: controlSequence,
    runRevision,
    resumeGeneration,
    authorityBackend: event.authorityBackend,
    authority: event.authority,
    routingEpoch: event.routingEpoch,
    authorityBuildHash: event.authorityBuildHash,
    correlationId: event.correlationId,
    payload: {
      receivedEventId: event.eventId,
      receivedKind: event.kind,
      receivedSequence: event.sequence,
      receivedDigest: prepared.messageDigest,
      receivedIdempotencyKey: prepared.idempotencyKey,
      receivedFingerprint: prepared.requestFingerprint,
      status,
      controlBuildHash: HASH_D,
      committedAt: NOW,
      errorCode:
        status === 'accepted' ? null : 'WORKFLOW_CONTROL_AUTHORITY_RECONCILIATION_REQUIRED',
    },
  });
}

function cancelRequest(
  value: ReturnType<typeof descriptor>,
  sequence: number,
  runRevision: number,
  resumeGeneration = value.resumeGeneration,
) {
  return controlMessage({
    kind: 'cancel_request',
    workflowRunId: value.workflowRunId,
    sequence,
    runRevision,
    resumeGeneration,
    authorityBackend: value.authorityRoute.backend,
    authority: value.authorityRoute.authority,
    routingEpoch: value.authorityRoute.routingEpoch,
    authorityBuildHash: value.authorityRoute.authorityBuildHash,
    correlationId: value.correlationId,
    payload: {
      cancelId: `cancel.v2.${sequence}`,
      requestedAt: NOW,
      expiresAt: LATER,
      reason: 'operator',
    },
  });
}

function checkpointPayload(value: ReturnType<typeof descriptor>, checkpointId: string) {
  return {
    checkpointId,
    phaseId: 'phase-1',
    phaseIndex: 0,
    commitPoint: 'after_phase_work',
    artifactRef: `checkpoint-control/artifacts/${checkpointId}.json`,
    artifactHash: HASH_A,
    resultHash: null,
    cacheKeyHash: null,
    workflowSourceHash: value.workflowSourceHash,
    manifestHash: value.manifestHash,
    inputHash: value.inputHash,
  } as const;
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function harness(
  resumeGeneration: number,
  authorityRoute?: Parameters<typeof descriptor>[1],
  options: {
    readonly execute?: (context: WorkflowRunnerV2ExecutionContext) => Promise<RunResult>;
    readonly now?: () => string;
    readonly runtimeDelivery?: WorkflowRunnerV2RuntimeDeliveryPort;
    readonly activity?: string[];
    readonly reportFatal?: (error: Error) => void | Promise<void>;
    readonly send?: (message: WorkflowControlAuthorityMessage, exactBytes: string) => void;
  } = {},
) {
  const sealed = descriptor(resumeGeneration, authorityRoute);
  const sent: WorkflowControlAuthorityMessage[] = [];
  const sentBytes: string[] = [];
  const closed: number[] = [];
  let prepared = 0;
  let loaded = 0;
  let executed = 0;
  let executionContext: WorkflowRunnerV2ExecutionContext | undefined;
  const session = new WorkflowRunnerV2Session({
    workspaceId: sealed.workspaceId,
    runnerBuildHash: HASH_C,
    runtimeVersion: '22.14.0',
    descriptorStore: {
      async read() {
        return sealed;
      },
    },
    sourceLoader: {
      async prepare() {
        prepared += 1;
        return { sealed: true };
      },
      async load() {
        loaded += 1;
        return { meta: { name: sealed.workflowId }, format: 'typescript', hash: HASH_C };
      },
    },
    send(exactBytes) {
      sentBytes.push(exactBytes);
      const message = JSON.parse(exactBytes) as WorkflowControlAuthorityMessage;
      sent.push(message);
      options.activity?.push(`send:${message.kind}`);
      options.send?.(message, exactBytes);
    },
    close(exitCode) {
      closed.push(exitCode);
    },
    async execute(_workflow, _descriptor, context) {
      executed += 1;
      executionContext = context;
      if (options.execute) return options.execute(context);
      return await new Promise<never>(() => undefined);
    },
    runtimeDelivery: options.runtimeDelivery,
    reportFatal: options.reportFatal,
    now: options.now ?? (() => NOW),
  });
  return {
    session,
    sealed,
    sent,
    sentBytes,
    closed,
    counts: () => ({ prepared, loaded, executed }),
    context: () => executionContext,
  };
}

async function handshake(harnessValue: ReturnType<typeof harness>): Promise<void> {
  await harnessValue.session.start();
  const hello = harnessValue.sent[0]!;
  expect(hello.payload.supportedProtocolVersions).toEqual([
    WORKFLOW_RUNNER_PROTOCOL_VERSION,
    WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
  ]);
  await harnessValue.session.receive(
    controlMessage({
      kind: 'hello_ack',
      correlationId: hello.correlationId,
      payload: {
        controlBuildHash: HASH_D,
        selectedProtocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
        heartbeatIntervalMs: 1000,
        leaseOfferTimeoutMs: 5000,
      },
    }),
  );
}

describe('WorkflowRunnerV2Session', () => {
  it('sends exact F2b checkpoint bytes only after companion resolution and ACKs before progress', async () => {
    const activity: string[] = [];
    let binding = 0;
    let committedExactBytes = '';
    const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
      async isResume(_descriptor, lease) {
        expect(lease).toMatchObject({
          jobId: 'job.v2',
          workflowRunId: value.sealed.workflowRunId,
          attemptId: 'attempt.v2',
          leaseId: 'lease.v2',
          fencingToken: 1,
          jobSpecHash: HASH_C,
        });
        activity.push('isResume:false');
        return false;
      },
      async commit(operation, target) {
        activity.push(`commit:${operation}`);
        binding += 1;
        committedExactBytes = target.body;
        return {
          stage: { bindingId: `WFRUNNER-BINDING-${String(binding).padStart(64, '0')}` },
          exactEventBytes: target.body,
        } as never;
      },
      async acknowledgeControl(_bindingId, message) {
        activity.push(`ack:${message.kind}`);
      },
    };
    const route = {
      backend: 'go' as const,
      authority: 'workflow-control' as const,
      routingEpoch: 1,
      authorityBuildHash: HASH_A,
    };
    const value = harness(0, route, { runtimeDelivery, activity });
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    expect(accept.kind).toBe('lease_accept');
    expect(activity).not.toContain('commit:resume_advance');
    await value.session.receive(receipt(accept, 2, 1, 0));
    await offerTask;
    await turn();
    activity.length = 0;

    const checkpointTask = value.context()!.checkpointCommit({
      checkpointId: 'checkpoint.v2.f2b',
      phaseId: 'phase-1',
      phaseIndex: 0,
      commitPoint: 'after_phase_work',
      artifactRef: 'checkpoint-control/artifacts/f2b.json',
      artifactHash: HASH_A,
      resultHash: null,
      cacheKeyHash: null,
      workflowSourceHash: value.sealed.workflowSourceHash,
      manifestHash: value.sealed.manifestHash,
      inputHash: value.sealed.inputHash,
    });
    await turn();
    const checkpoint = value.sent.at(-1)!;
    expect(activity).toEqual(['commit:checkpoint_commit', 'send:checkpoint_commit']);
    expect(value.sentBytes.at(-1)).toBe(committedExactBytes);
    expect(value.sentBytes.at(-1)).toBe(prepareWorkflowControlAuthorityMessage(checkpoint).body);
    await value.session.receive(receipt(checkpoint, 3, 2, 0));
    await checkpointTask;
    expect(activity).toEqual([
      'commit:checkpoint_commit',
      'send:checkpoint_commit',
      'ack:event_receipt',
    ]);
  });

  it('uses durable disposition to distinguish initial gen0 from first resume 0 to 1', async () => {
    const activity: string[] = [];
    const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
      async isResume() {
        activity.push('isResume:true');
        return true;
      },
      async commit(operation, target) {
        activity.push(`commit:${operation}`);
        return {
          stage: { bindingId: `WFRUNNER-BINDING-${'9'.repeat(64)}` },
          exactEventBytes: target.body,
        } as never;
      },
      async acknowledgeControl(_bindingId, message) {
        activity.push(`ack:${message.kind}`);
      },
    };
    const value = harness(
      0,
      {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 1,
        authorityBuildHash: HASH_A,
      },
      { runtimeDelivery, activity },
    );
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    expect(accept).toMatchObject({ kind: 'lease_accept', runRevision: 1, resumeGeneration: 0 });
    expect(activity.slice(-2)).toEqual(['commit:resume_advance', 'send:lease_accept']);
    await value.session.receive(receipt(accept, 2, 2, 1));
    await turn();
    expect(value.session.state).toBe('waiting_control_decision');
    await value.session.receive(
      controlMessage({
        kind: 'resume_offer',
        workflowRunId: value.sealed.workflowRunId,
        sequence: 3,
        runRevision: 1,
        resumeGeneration: 0,
        authorityBackend: 'go',
        authority: 'workflow-control',
        correlationId: value.sealed.correlationId,
        payload: {
          checkpointId: 'checkpoint.v2.first-resume',
          checkpointHash: HASH_B,
          nextPhaseId: 'phase-1',
          nextPhaseIndex: 0,
          newResumeGeneration: 1,
          newAttemptId: 'attempt.v2.resume.1',
          authorityReceiptHash: HASH_C,
          expiresAt: LATER,
        },
      }),
    );
    await offerTask;
    await turn();
    expect(value.counts()).toEqual({ prepared: 1, loaded: 1, executed: 1 });
    expect(value.context()?.resumeOffer).toMatchObject({
      kind: 'resume_offer',
      payload: { newResumeGeneration: 1 },
    });
    expect(value.context()?.resumeGeneration).toBe(1);
    expect(activity).toContain('ack:event_receipt');
    expect(activity).toContain('ack:resume_offer');
  });

  it('hands the exact reserve source result to accepted and rejected budget decision ACKs', async () => {
    for (const status of ['reserved', 'rejected'] as const) {
      const acknowledgements: Array<{
        kind: WorkflowControlAuthorityMessage['kind'];
        context: Parameters<WorkflowRunnerV2RuntimeDeliveryPort['acknowledgeControl']>[2];
      }> = [];
      const budgetSourceResult = { status, exact: true } as never;
      const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
        async isResume() {
          return false;
        },
        async commit(operation, target) {
          expect(operation).toBe('budget_reserve');
          return {
            stage: {
              bindingId: `WFRUNNER-BINDING-${status === 'reserved' ? '8' : '7'.repeat(64)}`,
            },
            exactEventBytes: target.body,
            budgetSourceResult,
          } as never;
        },
        async acknowledgeControl(_bindingId, message, context) {
          acknowledgements.push({ kind: message.kind, context });
        },
      };
      const route = {
        backend: 'go' as const,
        authority: 'workflow-control' as const,
        routingEpoch: 1,
        authorityBuildHash: HASH_A,
      };
      const value = harness(0, route, { runtimeDelivery });
      await handshake(value);
      const offerTask = value.session.receive(leaseOffer(value.sealed));
      await turn();
      const accept = value.sent.at(-1)!;
      await value.session.receive(receipt(accept, 2));
      await offerTask;
      await turn();

      const reserveTask = value.context()!.reserveBudget({
        reservationId: `reservation.v2.${status}`,
        callId: `call.v2.${status}`,
        policyHash: HASH_B,
        requestedTokens: '100',
        requestedCostNanoUsd: '1000',
        requestedCalls: '1',
      });
      await turn();
      const reserve = value.sent.at(-1)!;
      await value.session.receive(receipt(reserve, 3, 2));
      await value.session.receive(
        controlMessage({
          kind: 'budget_authorization',
          workflowRunId: value.sealed.workflowRunId,
          sequence: 4,
          runRevision: 2,
          resumeGeneration: 0,
          authorityBackend: 'go',
          authority: 'workflow-control',
          correlationId: value.sealed.correlationId,
          payload: {
            reservationId: `reservation.v2.${status}`,
            status,
            authorizedTokens: status === 'reserved' ? '100' : '0',
            authorizedCostNanoUsd: status === 'reserved' ? '1000' : '0',
            authorizedCalls: status === 'reserved' ? '1' : '0',
            authorityReceiptHash: HASH_C,
            committedRunRevision: 2,
          },
        }),
      );
      await expect(reserveTask).resolves.toMatchObject({
        decision: {
          kind: 'budget_authorization',
          payload: { status },
        },
        budgetSourceResult,
      });
      expect(acknowledgements).toHaveLength(2);
      expect(acknowledgements[0]).toMatchObject({
        kind: 'event_receipt',
        context: { disposition: 'accepted' },
      });
      expect(acknowledgements[0]!.context).not.toHaveProperty('budgetSourceResult');
      expect(acknowledgements[1]).toMatchObject({
        kind: 'budget_authorization',
        context: { disposition: 'accepted' },
      });
      expect(acknowledgements[1]!.context.budgetSourceResult).toBe(budgetSourceResult);
    }
  });

  it('ACKs a reconciliation-required event receipt before closing the binding', async () => {
    const activity: string[] = [];
    const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
      async isResume() {
        return false;
      },
      async commit(_operation, target) {
        return {
          stage: { bindingId: `WFRUNNER-BINDING-${'6'.repeat(64)}` },
          exactEventBytes: target.body,
        } as never;
      },
      async acknowledgeControl(_bindingId, message, context) {
        activity.push(`ack:${message.kind}:${context.disposition}`);
      },
    };
    const value = harness(
      0,
      {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 1,
        authorityBuildHash: HASH_A,
      },
      { runtimeDelivery },
    );
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();
    const checkpointTask = value
      .context()!
      .checkpointCommit(checkpointPayload(value.sealed, 'checkpoint.reconcile'));
    await turn();
    const checkpoint = value.sent.at(-1)!;
    await value.session.receive(receipt(checkpoint, 3, 2, 0, 'reconciliation_required'));
    await expect(checkpointTask).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_V2_RECONCILIATION_REQUIRED',
    });
    expect(activity).toEqual(['ack:event_receipt:reconciliation_required']);
    expect(value.closed).toEqual([2]);
    expect(value.sent.map((message) => message.kind)).not.toContain('terminal');
  });

  it('reconciles a queued non-contiguous cancel through the event-receipt ACK', async () => {
    const acknowledged: Array<{
      bindingId: string;
      kind: WorkflowControlAuthorityMessage['kind'];
    }> = [];
    const bindingId = `WFRUNNER-BINDING-${'5'.repeat(64)}`;
    const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
      async isResume() {
        return false;
      },
      async commit(_operation, target) {
        return { stage: { bindingId }, exactEventBytes: target.body } as never;
      },
      async acknowledgeControl(receivedBindingId, message) {
        acknowledged.push({ bindingId: receivedBindingId, kind: message.kind });
      },
    };
    const value = harness(
      0,
      {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 1,
        authorityBuildHash: HASH_A,
      },
      { runtimeDelivery },
    );
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();
    const checkpointTask = value
      .context()!
      .checkpointCommit(checkpointPayload(value.sealed, 'checkpoint.cancel'));
    await turn();
    const checkpoint = value.sent.at(-1)!;
    await value.session.receive(cancelRequest(value.sealed, 3, 2));
    expect(value.context()!.signal.aborted).toBe(true);
    await value.session.receive(receipt(checkpoint, 4, 2));
    await expect(checkpointTask).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_V2_RECONCILIATION_REQUIRED',
    });
    expect(acknowledged).toEqual([{ bindingId, kind: 'event_receipt' }]);
    expect(value.closed).toEqual([2]);
    expect(value.sent.map((message) => message.kind)).not.toContain('terminal');
  });

  it('uses cancel instead of a pending decision as the same binding sequence four ACK', async () => {
    const acknowledged: Array<{
      bindingId: string;
      kind: WorkflowControlAuthorityMessage['kind'];
    }> = [];
    const bindingId = `WFRUNNER-BINDING-${'4'.repeat(64)}`;
    const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
      async isResume() {
        return false;
      },
      async commit(_operation, target) {
        return {
          stage: { bindingId },
          exactEventBytes: target.body,
          budgetSourceResult: {},
        } as never;
      },
      async acknowledgeControl(receivedBindingId, message) {
        acknowledged.push({ bindingId: receivedBindingId, kind: message.kind });
      },
    };
    const value = harness(
      0,
      {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 1,
        authorityBuildHash: HASH_A,
      },
      { runtimeDelivery },
    );
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();
    const reserveTask = value.context()!.reserveBudget({
      reservationId: 'reservation.v2.cancel',
      callId: 'call.v2.cancel',
      policyHash: HASH_B,
      requestedTokens: '100',
      requestedCostNanoUsd: '1000',
      requestedCalls: '1',
    });
    await turn();
    const reserve = value.sent.at(-1)!;
    await value.session.receive(receipt(reserve, 3, 2));
    await value.session.receive(cancelRequest(value.sealed, 4, 2));
    await expect(reserveTask).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_V2_RECONCILIATION_REQUIRED',
    });
    expect(acknowledged).toEqual([
      { bindingId, kind: 'event_receipt' },
      { bindingId, kind: 'cancel_request' },
    ]);
    expect(value.closed).toEqual([2]);
    expect(value.sent.map((message) => message.kind)).not.toContain('terminal');
  });

  it('keeps cancel after a confirmed decision on the ordinary runner ACK lane', async () => {
    const acknowledged: WorkflowControlAuthorityMessage['kind'][] = [];
    const bindingId = `WFRUNNER-BINDING-${'3'.repeat(64)}`;
    const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
      async isResume() {
        return false;
      },
      async commit(_operation, target) {
        return {
          stage: { bindingId },
          exactEventBytes: target.body,
          budgetSourceResult: {},
        } as never;
      },
      async acknowledgeControl(_receivedBindingId, message) {
        acknowledged.push(message.kind);
      },
    };
    const value = harness(
      0,
      {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 1,
        authorityBuildHash: HASH_A,
      },
      { runtimeDelivery },
    );
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();
    const reserveTask = value.context()!.reserveBudget({
      reservationId: 'reservation.v2.decision-then-cancel',
      callId: 'call.v2.decision-then-cancel',
      policyHash: HASH_B,
      requestedTokens: '100',
      requestedCostNanoUsd: '1000',
      requestedCalls: '1',
    });
    await turn();
    const reserve = value.sent.at(-1)!;
    await value.session.receive(receipt(reserve, 3, 2));
    await value.session.receive(
      controlMessage({
        kind: 'budget_authorization',
        workflowRunId: value.sealed.workflowRunId,
        sequence: 4,
        runRevision: 2,
        resumeGeneration: 0,
        authorityBackend: 'go',
        authority: 'workflow-control',
        correlationId: value.sealed.correlationId,
        payload: {
          reservationId: 'reservation.v2.decision-then-cancel',
          status: 'reserved',
          authorizedTokens: '100',
          authorizedCostNanoUsd: '1000',
          authorizedCalls: '1',
          authorityReceiptHash: HASH_C,
          committedRunRevision: 2,
        },
      }),
    );
    await expect(reserveTask).resolves.toMatchObject({
      decision: { kind: 'budget_authorization' },
    });
    expect(acknowledged).toEqual(['event_receipt', 'budget_authorization']);

    const cancelTask = value.session.receive(cancelRequest(value.sealed, 5, 2));
    await turn();
    const cancelAck = value.sent.at(-1)!;
    expect(cancelAck.kind).toBe('cancel_ack');
    expect(acknowledged).toEqual(['event_receipt', 'budget_authorization']);
    await value.session.receive(receipt(cancelAck, 6, 2));
    await cancelTask;
    expect(acknowledged).toEqual(['event_receipt', 'budget_authorization']);
  });

  it('retries unknown authority outcomes with the same event and remains cancellable', async () => {
    const fatalReports: Error[] = [];
    const attempts: string[] = [];
    const signals: AbortSignal[] = [];
    const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
      async isResume() {
        return false;
      },
      async commit(_operation, target, _source, signal) {
        attempts.push(target.body);
        signals.push(signal!);
        throw Object.assign(new Error('source response unknown'), {
          code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
        });
      },
      async acknowledgeControl() {
        throw new Error('no control ACK is possible');
      },
    };
    const value = harness(
      0,
      {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 1,
        authorityBuildHash: HASH_A,
      },
      {
        runtimeDelivery,
        async reportFatal(error) {
          fatalReports.push(error);
          throw new Error('diagnostic sink unavailable');
        },
        execute: async (context) => {
          await context.checkpointCommit(checkpointPayload(value.sealed, 'checkpoint.unknown'));
          return { status: 'completed' };
        },
      },
    );
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();
    await turn();
    expect(value.closed).toEqual([]);
    expect(attempts).toHaveLength(1);
    expect(await value.session.retryOutstanding()).toBe(true);
    await turn();
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    // A cancel interrupts a retry wait without emitting an uncommitted event.
    void value.session.receive(cancelRequest(value.sealed, 3, 1)).catch(() => undefined);
    await turn();
    await turn();
    expect(value.closed).toEqual([2]);
    expect(value.session.state).toBe('reconciliation_required');
    expect(fatalReports).toHaveLength(1);
    expect(fatalReports[0]).toMatchObject({
      code: 'WORKFLOW_RUNNER_V2_RECONCILIATION_REQUIRED',
    });
    expect(value.sent.map((message) => message.kind)).not.toContain('terminal');
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('owns a synchronous authority event send failure without an unhandled rejection', async () => {
    const fatalReports: Error[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
      async isResume() {
        return false;
      },
      async commit(_operation, target) {
        return {
          stage: { bindingId: `WFRUNNER-BINDING-${'1'.repeat(64)}` },
          exactEventBytes: target.body,
        } as never;
      },
      async acknowledgeControl() {},
    };
    const value = harness(
      0,
      {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 1,
        authorityBuildHash: HASH_A,
      },
      {
        runtimeDelivery,
        reportFatal(error) {
          fatalReports.push(error);
        },
        send(message) {
          if (message.kind === 'checkpoint_commit') throw new Error('synchronous EPIPE');
        },
        async execute(context) {
          await context.checkpointCommit(checkpointPayload(value.sealed, 'checkpoint.epipe'));
          return { status: 'completed' };
        },
      },
    );
    process.on('unhandledRejection', onUnhandled);
    try {
      await handshake(value);
      const offerTask = value.session.receive(leaseOffer(value.sealed));
      await turn();
      const accept = value.sent.at(-1)!;
      await value.session.receive(receipt(accept, 2));
      await offerTask;
      await turn();
      await turn();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(value.closed).toEqual([2]);
    expect(value.session.state).toBe('reconciliation_required');
    expect(fatalReports).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it('completes a retryable authority operation once without changing the event bytes', async () => {
    const attempts: string[] = [];
    const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
      async isResume() {
        return false;
      },
      async commit(_operation, target) {
        attempts.push(target.body);
        if (attempts.length === 1)
          throw Object.assign(new Error('503'), { code: 'WORKFLOW_RUN_RECOVERY_UNKNOWN' });
        return {
          stage: { bindingId: 'WFRUNNER-BINDING-' + '4'.repeat(64) },
          exactEventBytes: target.body,
        } as never;
      },
      async acknowledgeControl() {},
    };
    const value = harness(
      0,
      { backend: 'go', authority: 'workflow-control', routingEpoch: 1, authorityBuildHash: HASH_A },
      { runtimeDelivery },
    );
    await handshake(value);
    const offer = value.session.receive(leaseOffer(value.sealed));
    await turn();
    await value.session.receive(receipt(value.sent.at(-1)!, 2));
    await offer;
    await turn();
    const pending = value
      .context()!
      .checkpointCommit(checkpointPayload(value.sealed, 'checkpoint.retry'));
    await turn();
    expect(value.sent.filter((message) => message.kind === 'checkpoint_commit')).toHaveLength(0);
    expect(await value.session.retryOutstanding()).toBe(true);
    await turn();
    const checkpoint = value.sent.at(-1)!;
    expect(checkpoint.kind).toBe('checkpoint_commit');
    await value.session.receive(receipt(checkpoint, 3, 2));
    await pending;
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    expect(value.sent.filter((message) => message.kind === 'checkpoint_commit')).toHaveLength(1);
    expect(value.closed).toEqual([]);
  });

  it.each([0, 25])(
    'bounds an authority probe by the remaining lease (%i ms)',
    async (remaining) => {
      let now = NOW,
        calls = 0;
      const runtimeDelivery: WorkflowRunnerV2RuntimeDeliveryPort = {
        async isResume() {
          return false;
        },
        async commit(_operation, _target, _source, signal) {
          calls++;
          await new Promise((_, reject) => {
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
            signal!.throwIfAborted();
          });
          throw Error('expired operation resumed');
        },
        async acknowledgeControl() {},
      };
      const value = harness(
        0,
        {
          backend: 'go',
          authority: 'workflow-control',
          routingEpoch: 1,
          authorityBuildHash: HASH_A,
        },
        { runtimeDelivery, now: () => now },
      );
      await handshake(value);
      const offer = value.session.receive(leaseOffer(value.sealed));
      await turn();
      await value.session.receive(receipt(value.sent.at(-1)!, 2));
      await offer;
      await turn();
      now = new Date(Date.parse(LATER) - remaining).toISOString();
      await expect(
        value.context()!.checkpointCommit(checkpointPayload(value.sealed, 'checkpoint.expired')),
      ).rejects.toBeDefined();
      expect(value.closed).toEqual([2]);
      expect(calls).toBe(remaining === 0 ? 0 : 1);
      expect(value.sent.map((message) => message.kind)).not.toContain('checkpoint_commit');
      expect(value.sent.map((message) => message.kind)).not.toContain('terminal');
    },
  );

  it('rejects a Go-routed lease before source preparation or JavaScript loading', async () => {
    const value = harness(0, {
      backend: 'go',
      authority: 'workflow-control',
      routingEpoch: 1,
      authorityBuildHash: HASH_A,
    });
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    expect(value.counts()).toEqual({ prepared: 0, loaded: 0, executed: 0 });
    const rejection = value.sent.at(-1)!;
    expect(rejection).toMatchObject({
      kind: 'lease_reject',
      authorityBackend: 'go',
      authority: 'workflow-control',
      payload: { reason: 'unsupported' },
    });
    await value.session.receive(receipt(rejection, 2));
    await offerTask;
    expect(value.counts()).toEqual({ prepared: 0, loaded: 0, executed: 0 });
    expect(value.session.state).toBe('idle');
  });

  it('loads execution authority only after the exact lease_accept receipt for generation zero', async () => {
    const value = harness(0);
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    expect(value.counts()).toEqual({ prepared: 1, loaded: 0, executed: 0 });
    const accept = value.sent.at(-1)!;
    expect(accept.kind).toBe('lease_accept');
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();
    expect(value.counts()).toEqual({ prepared: 1, loaded: 1, executed: 1 });
    expect(value.closed).toEqual([]);
  });

  it('keeps generation resumes in the real lease_accept decision lane until exact resume_offer', async () => {
    const value = harness(1);
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2, 2));
    await turn();
    expect(value.counts()).toEqual({ prepared: 1, loaded: 0, executed: 0 });
    expect(value.session.state).toBe('waiting_control_decision');
    await value.session.receive(
      controlMessage({
        kind: 'resume_offer',
        workflowRunId: value.sealed.workflowRunId,
        sequence: 3,
        runRevision: 2,
        resumeGeneration: 1,
        correlationId: value.sealed.correlationId,
        payload: {
          checkpointId: 'checkpoint.v2',
          checkpointHash: HASH_B,
          nextPhaseId: 'phase-1',
          nextPhaseIndex: 0,
          newResumeGeneration: 2,
          newAttemptId: 'attempt.v2.resume.2',
          authorityReceiptHash: HASH_C,
          expiresAt: LATER,
        },
      }),
    );
    await offerTask;
    await turn();
    expect(value.counts()).toEqual({ prepared: 1, loaded: 1, executed: 1 });
    expect(value.context()?.resumeOffer?.kind).toBe('resume_offer');
    const checkpointTask = value.context()!.checkpointCommit({
      checkpointId: 'checkpoint.v2.next',
      phaseId: 'phase-1',
      phaseIndex: 0,
      commitPoint: 'after_phase_work',
      artifactRef: 'checkpoint-control/artifacts/foundation.json',
      artifactHash: HASH_A,
      resultHash: null,
      cacheKeyHash: null,
      workflowSourceHash: value.sealed.workflowSourceHash,
      manifestHash: value.sealed.manifestHash,
      inputHash: value.sealed.inputHash,
    });
    await turn();
    const checkpoint = value.sent.at(-1)!;
    expect(checkpoint).toMatchObject({
      kind: 'checkpoint_commit',
      runRevision: 2,
      resumeGeneration: 2,
    });
    await value.session.receive(receipt(checkpoint, 4, 2));
    await checkpointTask;
  });

  it('rejects a resume offer that reuses the runner lease attempt identity', () => {
    expect(() =>
      controlMessage({
        kind: 'resume_offer',
        workflowRunId: 'run.v2.1',
        sequence: 3,
        runRevision: 2,
        resumeGeneration: 1,
        correlationId: 'correlation.v2.1',
        payload: {
          checkpointId: 'checkpoint.v2',
          checkpointHash: HASH_B,
          nextPhaseId: 'phase-1',
          nextPhaseIndex: 0,
          newResumeGeneration: 2,
          newAttemptId: 'attempt.v2',
          authorityReceiptHash: HASH_C,
          expiresAt: LATER,
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
        path: '$/payload/newAttemptId',
      }),
    );
  });

  it('serializes heartbeat, cancel acknowledgement, and terminal without poisoning the lane', async () => {
    const value = harness(0, undefined, {
      execute: async (context) =>
        await new Promise<RunResult>((_resolve, reject) => {
          const abort = () => reject(context.signal.reason ?? new Error('cancelled'));
          if (context.signal.aborted) abort();
          else context.signal.addEventListener('abort', abort, { once: true });
        }),
    });
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();

    const heartbeatTask = value.session.heartbeat();
    await turn();
    const heartbeat = value.sent.at(-1)!;
    expect(heartbeat.kind).toBe('heartbeat');
    await value.session.receive(
      controlMessage({
        kind: 'cancel_request',
        sequence: 3,
        correlationId: value.sealed.correlationId,
        payload: {
          cancelId: 'cancel.v2.1',
          requestedAt: NOW,
          expiresAt: LATER,
          reason: 'operator',
        },
      }),
    );
    expect(value.context()?.signal.aborted).toBe(true);
    expect(value.sent.map((message) => message.kind)).not.toContain('terminal');

    await value.session.receive(receipt(heartbeat, 4));
    await turn();
    const cancelAck = value.sent.at(-1)!;
    expect(cancelAck).toMatchObject({
      kind: 'cancel_ack',
      payload: { cancelId: 'cancel.v2.1', status: 'already_terminal' },
    });
    expect(value.sent.map((message) => message.kind)).not.toContain('terminal');

    await value.session.receive(receipt(cancelAck, 5));
    await expect(heartbeatTask).resolves.toBe(true);
    await turn();
    const terminal = value.sent.at(-1)!;
    expect(value.sent.slice(-3).map((message) => message.kind)).toEqual([
      'heartbeat',
      'cancel_ack',
      'terminal',
    ]);
    expect(terminal).toMatchObject({ kind: 'terminal', payload: { status: 'cancelled' } });
    await value.session.receive(receipt(terminal, 6));
    await turn();
    expect(value.closed).toEqual([0]);
  });

  it('queues workflow events behind an in-flight heartbeat instead of failing the run', async () => {
    const value = harness(0);
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();

    const heartbeatTask = value.session.heartbeat();
    await turn();
    const heartbeat = value.sent.at(-1)!;
    const checkpointTask = value.context()!.checkpointCommit({
      checkpointId: 'checkpoint.v2.queued',
      phaseId: 'phase-1',
      phaseIndex: 0,
      commitPoint: 'after_phase_work',
      artifactRef: 'checkpoint-control/artifacts/queued.json',
      artifactHash: HASH_A,
      resultHash: null,
      cacheKeyHash: null,
      workflowSourceHash: value.sealed.workflowSourceHash,
      manifestHash: value.sealed.manifestHash,
      inputHash: value.sealed.inputHash,
    });
    await turn();
    expect(value.sent.at(-1)).toBe(heartbeat);

    await value.session.receive(receipt(heartbeat, 3));
    await expect(heartbeatTask).resolves.toBe(true);
    await turn();
    const checkpoint = value.sent.at(-1)!;
    expect(checkpoint.kind).toBe('checkpoint_commit');
    await value.session.receive(receipt(checkpoint, 4));
    await checkpointTask;
    expect(value.closed).toEqual([]);
  });

  it('fails closed when a budget decision arrives before its event receipt', async () => {
    const value = harness(0);
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();
    const reserveTask = value.context()!.reserveBudget({
      reservationId: 'reservation.v2',
      callId: 'call.v2',
      policyHash: HASH_B,
      requestedTokens: '100',
      requestedCostNanoUsd: '1000',
      requestedCalls: '1',
    });
    await turn();
    await value.session.receive(
      controlMessage({
        kind: 'budget_authorization',
        workflowRunId: value.sealed.workflowRunId,
        sequence: 3,
        runRevision: 1,
        resumeGeneration: 0,
        correlationId: value.sealed.correlationId,
        payload: {
          reservationId: 'reservation.v2',
          status: 'reserved',
          authorizedTokens: '100',
          authorizedCostNanoUsd: '1000',
          authorizedCalls: '1',
          authorityReceiptHash: HASH_C,
          committedRunRevision: 1,
        },
      }),
    );
    await expect(reserveTask).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_V2_RECEIPT_REQUIRED',
    });
    expect(value.closed).toEqual([2]);
  });

  it('binds a budget decision to the exact request without conflating revision planes', async () => {
    const value = harness(0);
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();
    const reserveTask = value.context()!.reserveBudget({
      reservationId: 'reservation.v2',
      callId: 'call.v2',
      policyHash: HASH_B,
      requestedTokens: '100',
      requestedCostNanoUsd: '1000',
      requestedCalls: '1',
    });
    await turn();
    const reserve = value.sent.at(-1)!;
    expect(reserve).toMatchObject({
      kind: 'budget_reserve_request',
      runRevision: 1,
      resumeGeneration: 0,
    });
    await value.session.receive(receipt(reserve, 3, 2));
    const requested = {
      reservationId: 'reservation.v2',
      requestedTokens: '100',
      requestedCostNanoUsd: '1000',
      requestedCalls: '1',
    };
    const decision = controlMessage({
      kind: 'budget_authorization',
      workflowRunId: value.sealed.workflowRunId,
      sequence: 4,
      runRevision: 2,
      resumeGeneration: 0,
      correlationId: value.sealed.correlationId,
      payload: {
        reservationId: 'reservation.v2',
        status: 'reserved',
        authorizedTokens: '100',
        authorizedCostNanoUsd: '1000',
        authorizedCalls: '1',
        authorityReceiptHash: HASH_C,
        committedRunRevision: 12,
      },
    });
    expect(workflowRunnerV2BudgetDecisionMatchesRequest(decision, requested)).toBe(true);
    for (const payload of [
      { ...decision.payload, authorizedTokens: '99' },
      { ...decision.payload, authorizedCostNanoUsd: '999' },
      { ...decision.payload, authorizedCalls: '0' },
      { ...decision.payload, reservationId: 'reservation.sibling' },
      {
        ...decision.payload,
        status: 'rejected',
        authorizedTokens: '100',
        authorizedCostNanoUsd: '0',
        authorizedCalls: '0',
      },
    ]) {
      expect(
        workflowRunnerV2BudgetDecisionMatchesRequest({ ...decision, payload }, requested),
      ).toBe(false);
    }
    expect(
      workflowRunnerV2BudgetDecisionMatchesRequest(
        {
          ...decision,
          payload: {
            ...decision.payload,
            status: 'rejected',
            authorizedTokens: '0',
            authorizedCostNanoUsd: '0',
            authorizedCalls: '0',
          },
        },
        requested,
      ),
    ).toBe(true);
    await value.session.receive(decision);
    await expect(reserveTask).resolves.toMatchObject({
      decision: {
        kind: 'budget_authorization',
        runRevision: 2,
        payload: { committedRunRevision: 12 },
      },
    });
  });

  it('rejects a revision advance on a non-advancing checkpoint receipt', async () => {
    const value = harness(0);
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();
    const checkpointTask = value.context()!.checkpointCommit({
      checkpointId: 'checkpoint.v2.non-advancing',
      phaseId: 'phase-1',
      phaseIndex: 0,
      commitPoint: 'after_phase_work',
      artifactRef: 'checkpoint-control/artifacts/non-advancing.json',
      artifactHash: HASH_A,
      resultHash: null,
      cacheKeyHash: null,
      workflowSourceHash: value.sealed.workflowSourceHash,
      manifestHash: value.sealed.manifestHash,
      inputHash: value.sealed.inputHash,
    });
    await turn();
    const checkpoint = value.sent.at(-1)!;
    await value.session.receive(receipt(checkpoint, 3, 2));
    await expect(checkpointTask).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_V2_ADMISSION_BINDING_MISMATCH',
    });
    expect(value.closed).toEqual([2]);
  });

  it('rejects a budget receipt that does not advance the run revision', async () => {
    const value = harness(0);
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 2));
    await offerTask;
    await turn();
    const reserveTask = value.context()!.reserveBudget({
      reservationId: 'reservation.v2.non-advancing',
      callId: 'call.v2.non-advancing',
      policyHash: HASH_B,
      requestedTokens: '100',
      requestedCostNanoUsd: '1000',
      requestedCalls: '1',
    });
    await turn();
    const reserve = value.sent.at(-1)!;
    await value.session.receive(receipt(reserve, 3, 1));
    await expect(reserveTask).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_V2_ADMISSION_BINDING_MISMATCH',
    });
    expect(value.closed).toEqual([2]);
  });

  it('rejects a gap in the control-side sequence', async () => {
    const value = harness(0);
    await handshake(value);
    const offerTask = value.session.receive(leaseOffer(value.sealed));
    await turn();
    const accept = value.sent.at(-1)!;
    await value.session.receive(receipt(accept, 3));
    await offerTask;
    expect(value.counts()).toEqual({ prepared: 1, loaded: 0, executed: 0 });
    expect(value.closed).toEqual([2]);
  });
});
