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
import {
  createWorkflowRunnerV2ExecutionDescriptor,
  hashWorkflowRunnerV2Descriptor,
} from '../workflow-runner-v2-descriptor.js';
import {
  WorkflowRunnerV2Session,
  type WorkflowRunnerV2ExecutionContext,
} from '../workflow-runner-v2-session.js';

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
  return createWorkflowRunnerV2ExecutionDescriptor({
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

function receipt(event: WorkflowControlAuthorityMessage, controlSequence: number, runRevision = 1) {
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
    resumeGeneration: event.resumeGeneration,
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
      status: 'accepted',
      controlBuildHash: HASH_D,
      committedAt: NOW,
      errorCode: null,
    },
  });
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function harness(resumeGeneration: number, authorityRoute?: Parameters<typeof descriptor>[1]) {
  const sealed = descriptor(resumeGeneration, authorityRoute);
  const sent: WorkflowControlAuthorityMessage[] = [];
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
      sent.push(JSON.parse(exactBytes) as WorkflowControlAuthorityMessage);
    },
    close(exitCode) {
      closed.push(exitCode);
    },
    async execute(_workflow, _descriptor, context) {
      executed += 1;
      executionContext = context;
      return await new Promise<never>(() => undefined);
    },
    now: () => NOW,
  });
  return {
    session,
    sealed,
    sent,
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
          newAttemptId: 'attempt.v2',
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

  it('binds a budget decision to the receipt-advanced run revision', async () => {
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
    await value.session.receive(
      controlMessage({
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
          committedRunRevision: 2,
        },
      }),
    );
    await expect(reserveTask).resolves.toMatchObject({
      kind: 'budget_authorization',
      runRevision: 2,
      payload: { committedRunRevision: 2 },
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
