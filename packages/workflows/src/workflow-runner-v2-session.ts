import { randomUUID } from 'node:crypto';
import type { RunResult, WorkflowModule } from './types.js';
import { canonicalWorkflowEffectJson } from './workflow-effect-json.js';
import {
  prepareWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityMessage,
  workflowControlAuthorityDirectionForKind,
  WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
  WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
  type WorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityPreparedMessage,
} from './workflow-control-authority-contract.js';
import {
  WORKFLOW_RUNNER_CAPABILITIES,
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  WORKFLOW_RUNNER_RUNTIME_NAME,
} from './workflow-runner-contract.js';
import {
  assertWorkflowRunnerV2AdmissionBinding,
  hashWorkflowRunnerV2Domain,
  type WorkflowRunnerV2ExecutionDescriptor,
} from './workflow-runner-v2-descriptor.js';

export type WorkflowRunnerV2SessionState =
  | 'created'
  | 'waiting_hello_ack'
  | 'idle'
  | 'validating_offer'
  | 'waiting_accept_receipt'
  | 'waiting_resume_offer'
  | 'executing'
  | 'waiting_event_receipt'
  | 'waiting_control_decision'
  | 'cancelling'
  | 'waiting_terminal_receipt'
  | 'reconciliation_required'
  | 'closed';

type ReceiptableKind =
  | 'lease_accept'
  | 'lease_reject'
  | 'heartbeat'
  | 'effect_intent'
  | 'effect_outcome'
  | 'cancel_ack'
  | 'terminal'
  | 'checkpoint_commit'
  | 'budget_reserve_request'
  | 'budget_usage_report';

type DecisionKind = 'budget_authorization' | 'effect_authorization' | 'resume_offer';

export interface WorkflowRunnerV2DescriptorStore {
  read(descriptorRef: string, now?: string): Promise<WorkflowRunnerV2ExecutionDescriptor>;
}

export interface WorkflowRunnerV2PreparedSource<TWorkflow = WorkflowModule> {
  readonly sourceHash: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly opaque: unknown;
  readonly __workflow?: TWorkflow;
}

export interface WorkflowRunnerV2SourceLoader<TPrepared, TWorkflow = WorkflowModule> {
  prepare(descriptor: WorkflowRunnerV2ExecutionDescriptor): Promise<TPrepared>;
  load(prepared: TPrepared, descriptor: WorkflowRunnerV2ExecutionDescriptor): Promise<TWorkflow>;
}

export interface WorkflowRunnerV2ExecutionContext {
  readonly signal: AbortSignal;
  readonly resumeOffer: WorkflowControlAuthorityMessage | null;
  checkpointCommit(payload: Readonly<Record<string, unknown>>): Promise<void>;
  reserveBudget(
    payload: Readonly<Record<string, unknown>>,
  ): Promise<WorkflowControlAuthorityMessage>;
  reportBudgetUsage(payload: Readonly<Record<string, unknown>>): Promise<void>;
  authorizeEffect(
    payload: Readonly<Record<string, unknown>>,
  ): Promise<WorkflowControlAuthorityMessage>;
  reportEffectOutcome(payload: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface WorkflowRunnerV2SessionOptions<TPrepared, TWorkflow = WorkflowModule> {
  readonly workspaceId: string;
  readonly runnerBuildHash: string;
  readonly runtimeVersion: string;
  readonly descriptorStore: WorkflowRunnerV2DescriptorStore;
  readonly sourceLoader: WorkflowRunnerV2SourceLoader<TPrepared, TWorkflow>;
  readonly send: (exactBytes: string) => void | Promise<void>;
  readonly close: (exitCode: number) => void | Promise<void>;
  readonly execute: (
    workflow: TWorkflow,
    descriptor: WorkflowRunnerV2ExecutionDescriptor,
    context: WorkflowRunnerV2ExecutionContext,
  ) => Promise<RunResult>;
  readonly now?: () => string;
}

export class WorkflowRunnerV2SessionError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_V2_SESSION_STATE'
      | 'WORKFLOW_RUNNER_V2_SESSION_DIRECTION'
      | 'WORKFLOW_RUNNER_V2_REQUIRED_PROTOCOL_UNAVAILABLE'
      | 'WORKFLOW_RUNNER_V2_DOWNGRADE_FORBIDDEN'
      | 'WORKFLOW_RUNNER_V2_CAPABILITY_MISMATCH'
      | 'WORKFLOW_RUNNER_V2_ADMISSION_BINDING_MISMATCH'
      | 'WORKFLOW_RUNNER_V2_SESSION_IDENTITY'
      | 'WORKFLOW_RUNNER_V2_SESSION_SEQUENCE'
      | 'WORKFLOW_RUNNER_V2_RECEIPT_REQUIRED'
      | 'WORKFLOW_RUNNER_V2_CONTROL_DECISION_REQUIRED'
      | 'WORKFLOW_RUNNER_V2_CONTROL_DECISION_MISMATCH'
      | 'WORKFLOW_RUNNER_V2_CONTROL_DECISION_EXPIRED'
      | 'WORKFLOW_RUNNER_V2_RECONCILIATION_REQUIRED'
      | 'WORKFLOW_RUNNER_V2_TERMINAL_BEFORE_RECEIPT',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowRunnerV2SessionError';
  }
}

interface LeaseBinding {
  workspaceId: string;
  jobId: string;
  workflowRunId: string;
  attemptId: string;
  leaseId: string;
  fencingToken: number;
  correlationId: string;
  authorityBackend: 'ts-local' | 'go';
  authority: 'typescript' | 'workflow-control';
  routingEpoch: number;
  authorityBuildHash: string;
  runRevision: number;
  resumeGeneration: number;
  leaseExpiresAt: string;
}

interface OutstandingEvent {
  readonly message: WorkflowControlAuthorityMessage;
  readonly prepared: WorkflowControlAuthorityPreparedMessage;
  readonly expectedDecision?: {
    readonly kind: DecisionKind;
    readonly match: (message: WorkflowControlAuthorityMessage) => boolean;
  };
  readonly resolveReceipt: () => void;
  readonly rejectReceipt: (error: Error) => void;
  readonly resolveDecision?: (message: WorkflowControlAuthorityMessage) => void;
  readonly rejectDecision?: (error: Error) => void;
  receiptAccepted: boolean;
}

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

function messagePayload(
  message: WorkflowControlAuthorityMessage,
): Readonly<Record<string, unknown>> {
  return message.payload;
}

function requiredString(message: WorkflowControlAuthorityMessage, key: string): string {
  const value = messagePayload(message)[key];
  if (typeof value !== 'string') {
    throw new WorkflowRunnerV2SessionError(
      'WORKFLOW_RUNNER_V2_SESSION_IDENTITY',
      `Control message ${key} is missing.`,
    );
  }
  return value;
}

export class WorkflowRunnerV2Session<TPrepared, TWorkflow = WorkflowModule> {
  readonly #options: WorkflowRunnerV2SessionOptions<TPrepared, TWorkflow>;
  #state: WorkflowRunnerV2SessionState = 'created';
  #helloCorrelationId?: string;
  #controlBuildHash?: string;
  #heartbeatIntervalMs?: number;
  #lease?: LeaseBinding;
  #descriptor?: WorkflowRunnerV2ExecutionDescriptor;
  #preparedSource?: TPrepared;
  #abortController?: AbortController;
  #outstanding?: OutstandingEvent;
  #workerSequence = 0;
  #lastControlSequence = 0;
  #lastReceiptSequence = 0;
  #resumeOffer: WorkflowControlAuthorityMessage | null = null;
  #queuedCancel?: WorkflowControlAuthorityMessage;
  #terminal = false;
  #terminalReceiptAccepted = false;
  #eventLaneTail: Promise<void> = Promise.resolve();
  #eventLanePending = 0;

  constructor(options: WorkflowRunnerV2SessionOptions<TPrepared, TWorkflow>) {
    if (!HASH.test(options.runnerBuildHash)) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_IDENTITY',
        'Runner build hash is invalid.',
      );
    }
    this.#options = options;
  }

  get state(): WorkflowRunnerV2SessionState {
    return this.#state;
  }

  get heartbeatIntervalMs(): number | undefined {
    return this.#heartbeatIntervalMs;
  }

  get hasOutstandingEvent(): boolean {
    return this.#outstanding !== undefined;
  }

  #now(): string {
    const value = (this.#options.now ?? (() => new Date().toISOString()))();
    if (
      !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value
    ) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_STATE',
        'Session clock must return canonical UTC.',
      );
    }
    return value;
  }

  async start(): Promise<void> {
    if (this.#state !== 'created') {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_STATE',
        'V2 runner session can start only once.',
      );
    }
    this.#helloCorrelationId = `session-${randomUUID()}`;
    const message = validateWorkflowControlAuthorityMessage({
      schema: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
      protocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
      kind: 'hello',
      workspaceId: this.#options.workspaceId,
      jobId: null,
      workflowRunId: null,
      attemptId: null,
      leaseId: null,
      fencingToken: null,
      sequence: null,
      authorityBackend: null,
      authority: null,
      routingEpoch: null,
      authorityBuildHash: null,
      runRevision: null,
      resumeGeneration: null,
      eventId: `hello-${randomUUID()}`,
      correlationId: this.#helloCorrelationId,
      sentAt: this.#now(),
      payload: {
        runtimeName: WORKFLOW_RUNNER_RUNTIME_NAME,
        runtimeVersion: this.#options.runtimeVersion,
        runnerBuildHash: this.#options.runnerBuildHash,
        supportedProtocolVersions: [
          WORKFLOW_RUNNER_PROTOCOL_VERSION,
          WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
        ],
        capabilities: [...WORKFLOW_RUNNER_CAPABILITIES],
        maxConcurrentJobs: 1,
      },
    });
    this.#state = 'waiting_hello_ack';
    await this.#send(message);
  }

  async receive(value: WorkflowControlAuthorityMessage): Promise<void> {
    if (this.#state === 'closed') return;
    const message = validateWorkflowControlAuthorityMessage(value);
    if (workflowControlAuthorityDirectionForKind(message.kind) !== 'control-to-runner') {
      return this.#fatal(
        new WorkflowRunnerV2SessionError(
          'WORKFLOW_RUNNER_V2_SESSION_DIRECTION',
          `Runner cannot receive ${message.kind}.`,
        ),
      );
    }
    if (message.workspaceId !== this.#options.workspaceId) {
      return this.#fatal(
        new WorkflowRunnerV2SessionError(
          'WORKFLOW_RUNNER_V2_SESSION_IDENTITY',
          'Incoming workspace differs from the sealed worker.',
        ),
      );
    }
    try {
      if (message.kind === 'hello_ack') return this.#handleHelloAck(message);
      if (message.kind === 'lease_offer') return await this.#handleLeaseOffer(message);
      if (message.kind === 'event_receipt') return await this.#handleReceipt(message);
      if (
        message.kind === 'budget_authorization' ||
        message.kind === 'effect_authorization' ||
        message.kind === 'resume_offer'
      ) {
        return await this.#handleDecision(message);
      }
      if (message.kind === 'cancel_request') return await this.#handleCancel(message);
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_DIRECTION',
        `Unsupported v2 control message ${message.kind}.`,
      );
    } catch (error) {
      await this.#fatal(error);
    }
  }

  #handleHelloAck(message: WorkflowControlAuthorityMessage): void {
    if (this.#state !== 'waiting_hello_ack' || !this.#helloCorrelationId) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_STATE',
        'hello_ack is not valid in the current state.',
      );
    }
    if (message.correlationId !== this.#helloCorrelationId) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_IDENTITY',
        'hello_ack does not bind the emitted hello.',
      );
    }
    if (
      messagePayload(message).selectedProtocolVersion !==
      WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION
    ) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_DOWNGRADE_FORBIDDEN',
        'A v2 qualification worker cannot downgrade to v1.',
      );
    }
    const controlBuildHash = messagePayload(message).controlBuildHash;
    const heartbeatIntervalMs = messagePayload(message).heartbeatIntervalMs;
    if (typeof controlBuildHash !== 'string' || !HASH.test(controlBuildHash)) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_IDENTITY',
        'Control build hash is invalid.',
      );
    }
    this.#controlBuildHash = controlBuildHash;
    this.#heartbeatIntervalMs = heartbeatIntervalMs as number;
    this.#state = 'idle';
  }

  async #handleLeaseOffer(message: WorkflowControlAuthorityMessage): Promise<void> {
    if (this.#state !== 'idle') {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_STATE',
        'A lease offer is valid only while idle.',
      );
    }
    this.#assertIncreasingControlSequence(message);
    const payload = messagePayload(message);
    const expiresAt = requiredString(message, 'expiresAt');
    if (Date.parse(expiresAt) <= Date.parse(this.#now())) {
      return this.#sendLeaseReject(message, 'stale');
    }
    const lease = this.#leaseBindingFromMessage(message, 'Lease offer');
    this.#state = 'validating_offer';
    const descriptor = await this.#options.descriptorStore.read(
      requiredString(message, 'executionDescriptorRef'),
      this.#now(),
    );
    try {
      assertWorkflowRunnerV2AdmissionBinding(descriptor, {
        workspaceId: lease.workspaceId,
        workflowRunId: lease.workflowRunId,
        correlationId: message.correlationId,
        executionDescriptorRef: requiredString(message, 'executionDescriptorRef'),
        executionDescriptorHash: requiredString(message, 'executionDescriptorHash'),
        workflowId: requiredString(message, 'workflowId'),
        workflowVersion: requiredString(message, 'workflowVersion'),
        workflowSourceHash: requiredString(message, 'workflowSourceHash'),
        manifestHash: requiredString(message, 'manifestHash'),
        inputHash: requiredString(message, 'inputHash'),
        requiredProtocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
        requiredCapabilities: WORKFLOW_RUNNER_CAPABILITIES,
        authorityRoute: {
          backend: lease.authorityBackend,
          authority: lease.authority,
          routingEpoch: lease.routingEpoch,
          authorityBuildHash: lease.authorityBuildHash,
        },
        runRevision: lease.runRevision,
        resumeGeneration: lease.resumeGeneration,
      });
    } catch (error) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_ADMISSION_BINDING_MISMATCH',
        'Lease offer differs from the sealed v2 descriptor.',
        { cause: error },
      );
    }
    if (
      descriptor.requiredCapabilities.some(
        (capability) => !WORKFLOW_RUNNER_CAPABILITIES.includes(capability),
      )
    ) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_CAPABILITY_MISMATCH',
        'Worker lacks a required v2 capability.',
      );
    }
    // GS9-F1 executes through the existing TypeScript RunStore. Accepting a
    // Go-routed lease here would let a TS writer act behind a Go authority
    // envelope, so reject before source preparation or JavaScript loading.
    if (message.authorityBackend !== 'ts-local' || message.authority !== 'typescript') {
      return this.#sendLeaseReject(message, 'unsupported');
    }
    let prepared: TPrepared;
    try {
      prepared = await this.#options.sourceLoader.prepare(descriptor);
    } catch {
      return this.#sendLeaseReject(message, 'unsupported');
    }
    this.#lease = lease;
    this.#descriptor = descriptor;
    this.#preparedSource = prepared;
    this.#abortController = new AbortController();
    this.#state = 'waiting_accept_receipt';
    const acceptedAt = this.#now();
    const resumeOffer = await this.#emitReceiptable(
      'lease_accept',
      { acceptedAt, leaseExpiresAt: expiresAt },
      this.#lease.resumeGeneration > 0
        ? {
            kind: 'resume_offer',
            match: (decision) => {
              const nextAttemptId = messagePayload(decision).newAttemptId;
              return (
                typeof nextAttemptId === 'string' &&
                SAFE_ID.test(nextAttemptId) &&
                nextAttemptId !== this.#lease?.attemptId &&
                messagePayload(decision).newResumeGeneration ===
                  (this.#lease?.resumeGeneration ?? -1) + 1
              );
            },
          }
        : undefined,
    );
    if (this.#lease.resumeGeneration > 0) {
      if (!resumeOffer) {
        throw new WorkflowRunnerV2SessionError(
          'WORKFLOW_RUNNER_V2_CONTROL_DECISION_REQUIRED',
          'Resume generation requires an exact resume_offer after lease acceptance.',
        );
      }
      const nextGeneration = messagePayload(resumeOffer).newResumeGeneration;
      if (!Number.isSafeInteger(nextGeneration)) {
        throw new WorkflowRunnerV2SessionError(
          'WORKFLOW_RUNNER_V2_CONTROL_DECISION_MISMATCH',
          'Resume offer generation is invalid.',
        );
      }
      this.#lease.resumeGeneration = nextGeneration as number;
      this.#resumeOffer = resumeOffer;
    }
    await this.#afterDecisionLane();
    if (this.#abortController.signal.aborted) return;
    this.#state = 'executing';
    void this.#executeLease().catch((error) => this.#fatal(error));
  }

  async #sendLeaseReject(
    offer: WorkflowControlAuthorityMessage,
    reason: 'unsupported' | 'stale',
  ): Promise<void> {
    this.#lease = this.#leaseBindingFromMessage(offer, 'Rejected lease');
    this.#state = 'waiting_event_receipt';
    await this.#emitReceiptable('lease_reject', { rejectedAt: this.#now(), reason });
    this.#clearLease();
    this.#state = 'idle';
  }

  async #executeLease(): Promise<void> {
    const lease = this.#requireLease();
    if (!this.#descriptor || this.#preparedSource === undefined || !this.#abortController) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_STATE',
        'Accepted lease lacks prepared execution state.',
      );
    }
    const workflow = await this.#options.sourceLoader.load(this.#preparedSource, this.#descriptor);
    const context: WorkflowRunnerV2ExecutionContext = Object.freeze({
      signal: this.#abortController.signal,
      resumeOffer: this.#resumeOffer,
      checkpointCommit: async (payload: Readonly<Record<string, unknown>>) => {
        await this.#emitReceiptable('checkpoint_commit', payload);
      },
      reserveBudget: async (payload: Readonly<Record<string, unknown>>) => {
        return this.#emitWithDecision(
          'budget_reserve_request',
          payload,
          'budget_authorization',
          (message) => messagePayload(message).reservationId === payload.reservationId,
        );
      },
      reportBudgetUsage: async (payload: Readonly<Record<string, unknown>>) => {
        await this.#emitReceiptable('budget_usage_report', payload);
      },
      authorizeEffect: async (payload: Readonly<Record<string, unknown>>) => {
        return this.#emitWithDecision(
          'effect_intent',
          payload,
          'effect_authorization',
          (message) =>
            messagePayload(message).effectId === payload.effectId &&
            messagePayload(message).effectHash === payload.effectHash,
        );
      },
      reportEffectOutcome: async (payload: Readonly<Record<string, unknown>>) => {
        await this.#emitReceiptable('effect_outcome', payload);
      },
    });
    let result: RunResult;
    try {
      result = await this.#options.execute(workflow, this.#descriptor, context);
    } catch (error) {
      if (this.#state === 'reconciliation_required' || this.#state === 'closed') return;
      const cancelled = this.#abortController.signal.aborted;
      await this.#emitTerminal(cancelled ? 'cancelled' : 'failed', {
        name: error instanceof Error ? error.name : 'Error',
        code:
          error &&
          typeof error === 'object' &&
          typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : null,
      });
      return;
    }
    if (this.#abortController.signal.aborted) {
      await this.#emitTerminal('cancelled', { code: 'WORKFLOW_RUNNER_CANCELLED' });
      return;
    }
    await this.#emitTerminal('completed', {
      resultHash: hashWorkflowRunnerV2Domain(
        'workflow-result',
        canonicalWorkflowEffectJson(result),
      ),
    });
    void lease;
  }

  async #emitTerminal(
    status: 'completed' | 'failed' | 'cancelled',
    evidence: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.#terminal = true;
    this.#state = 'waiting_terminal_receipt';
    const resultHash =
      status === 'completed' && typeof evidence.resultHash === 'string'
        ? evidence.resultHash
        : null;
    const finishedAt = this.#now();
    await this.#emitReceiptable('terminal', {
      status,
      terminalReason:
        status === 'completed'
          ? null
          : status === 'cancelled'
            ? 'cancelled_by_control'
            : 'workflow_failed',
      resultHash,
      finishedAt,
    });
    this.#terminalReceiptAccepted = true;
    this.#state = 'closed';
    await this.#options.close(0);
  }

  async heartbeat(): Promise<boolean> {
    if (
      !this.#lease ||
      this.#terminal ||
      this.#outstanding ||
      this.#eventLanePending > 0 ||
      this.#state === 'closed'
    )
      return false;
    const observedAt = this.#now();
    await this.#emitReceiptable('heartbeat', {
      observedAt,
      leaseExpiresAt: this.#lease.leaseExpiresAt,
      state: this.#state === 'cancelling' ? 'cancelling' : 'running',
      lastReceiptSequence: this.#lastReceiptSequence,
    });
    return true;
  }

  async retryOutstanding(): Promise<boolean> {
    if (!this.#outstanding || this.#outstanding.receiptAccepted || this.#state === 'closed')
      return false;
    await this.#options.send(this.#outstanding.prepared.body);
    return true;
  }

  async #emitWithDecision(
    kind: 'budget_reserve_request' | 'effect_intent',
    payload: Readonly<Record<string, unknown>>,
    decisionKind: 'budget_authorization' | 'effect_authorization',
    match: (message: WorkflowControlAuthorityMessage) => boolean,
  ): Promise<WorkflowControlAuthorityMessage> {
    const decisionPromise = this.#emitReceiptable(kind, payload, { kind: decisionKind, match });
    const decision = await decisionPromise;
    if (!decision) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_CONTROL_DECISION_REQUIRED',
        `A ${decisionKind} decision is required.`,
      );
    }
    await this.#afterDecisionLane();
    return decision;
  }

  async #emitReceiptable(
    kind: ReceiptableKind,
    payload: Readonly<Record<string, unknown>>,
    expectedDecision?: {
      readonly kind: DecisionKind;
      readonly match: (message: WorkflowControlAuthorityMessage) => boolean;
    },
  ): Promise<WorkflowControlAuthorityMessage | undefined> {
    return this.#withEventLane(() => this.#emitReceiptableNow(kind, payload, expectedDecision));
  }

  async #emitReceiptableNow(
    kind: ReceiptableKind,
    payload: Readonly<Record<string, unknown>>,
    expectedDecision?: {
      readonly kind: DecisionKind;
      readonly match: (message: WorkflowControlAuthorityMessage) => boolean;
    },
  ): Promise<WorkflowControlAuthorityMessage | undefined> {
    const lease = this.#requireLease();
    if (this.#outstanding) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_SEQUENCE',
        'Only one v2 event or paired decision may be outstanding.',
      );
    }
    const sequence = this.#workerSequence + 1;
    const message = validateWorkflowControlAuthorityMessage({
      schema: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
      protocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
      kind,
      workspaceId: lease.workspaceId,
      jobId: lease.jobId,
      workflowRunId: lease.workflowRunId,
      attemptId: lease.attemptId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      sequence,
      authorityBackend: lease.authorityBackend,
      authority: lease.authority,
      routingEpoch: lease.routingEpoch,
      authorityBuildHash: lease.authorityBuildHash,
      runRevision: lease.runRevision,
      resumeGeneration: lease.resumeGeneration,
      eventId: `${kind}-${randomUUID()}`,
      correlationId: lease.correlationId,
      sentAt: this.#receiptableSentAt(kind, payload),
      payload,
    });
    const prepared = prepareWorkflowControlAuthorityMessage(message);
    this.#workerSequence = sequence;
    let resolveReceipt!: () => void;
    let rejectReceipt!: (error: Error) => void;
    const receipt = new Promise<void>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    let resolveDecision: ((message: WorkflowControlAuthorityMessage) => void) | undefined;
    let rejectDecision: ((error: Error) => void) | undefined;
    const decision = expectedDecision
      ? new Promise<WorkflowControlAuthorityMessage>((resolve, reject) => {
          resolveDecision = resolve;
          rejectDecision = reject;
        })
      : undefined;
    // The receipt promise is awaited first. Attach a rejection observer now so
    // a fatal pre-receipt decision cannot surface as an unhandled rejection.
    if (decision) void decision.catch(() => undefined);
    this.#outstanding = {
      message,
      prepared,
      expectedDecision,
      resolveReceipt,
      rejectReceipt,
      resolveDecision,
      rejectDecision,
      receiptAccepted: false,
    };
    this.#state = kind === 'terminal' ? 'waiting_terminal_receipt' : 'waiting_event_receipt';
    await this.#options.send(prepared.body);
    await receipt;
    if (!decision) {
      this.#outstanding = undefined;
      await this.#applyQueuedCancelInLane();
      return undefined;
    }
    this.#state = 'waiting_control_decision';
    const resolved = await decision;
    await this.#applyQueuedCancelInLane();
    return resolved;
  }

  async #handleReceipt(message: WorkflowControlAuthorityMessage): Promise<void> {
    const outstanding = this.#outstanding;
    if (!outstanding || outstanding.receiptAccepted || !this.#controlBuildHash) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_RECEIPT_REQUIRED',
        'Receipt does not match an outstanding v2 event.',
      );
    }
    this.#assertLeaseIdentity(message, false);
    this.#assertIncreasingControlSequence(message);
    const currentRevision = this.#requireLease().runRevision;
    const advancesRunRevision =
      outstanding.message.kind === 'budget_reserve_request' ||
      outstanding.message.kind === 'budget_usage_report' ||
      (outstanding.message.kind === 'lease_accept' &&
        outstanding.message.resumeGeneration !== null &&
        outstanding.message.resumeGeneration > 0);
    const expectedRunRevision = currentRevision + (advancesRunRevision ? 1 : 0);
    if (message.runRevision !== expectedRunRevision) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_ADMISSION_BINDING_MISMATCH',
        `Event receipt run revision did not preserve the exact ${advancesRunRevision ? 'advancing' : 'non-advancing'} CAS step.`,
      );
    }
    const payload = messagePayload(message);
    if (
      payload.receivedEventId !== outstanding.message.eventId ||
      payload.receivedKind !== outstanding.message.kind ||
      payload.receivedSequence !== outstanding.message.sequence ||
      payload.receivedDigest !== outstanding.prepared.messageDigest ||
      payload.receivedIdempotencyKey !== outstanding.prepared.idempotencyKey ||
      payload.receivedFingerprint !== outstanding.prepared.requestFingerprint ||
      payload.controlBuildHash !== this.#controlBuildHash
    ) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_IDENTITY',
        'Event receipt does not bind the exact outstanding bytes.',
      );
    }
    if (payload.status === 'reconciliation_required') {
      const error = new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_RECONCILIATION_REQUIRED',
        'Control requires reconciliation for the outstanding v2 event.',
      );
      outstanding.rejectReceipt(error);
      outstanding.rejectDecision?.(error);
      this.#outstanding = undefined;
      this.#state = 'reconciliation_required';
      await this.#options.close(2);
      return;
    }
    outstanding.receiptAccepted = true;
    this.#lastReceiptSequence = outstanding.message.sequence ?? 0;
    if (message.runRevision !== null) this.#requireLease().runRevision = message.runRevision;
    outstanding.resolveReceipt();
    if (!outstanding.expectedDecision) {
      this.#outstanding = undefined;
    }
  }

  async #handleDecision(message: WorkflowControlAuthorityMessage): Promise<void> {
    const outstanding = this.#outstanding;
    if (!outstanding?.receiptAccepted || !outstanding.expectedDecision) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_RECEIPT_REQUIRED',
        `${message.kind} arrived before its advancing event receipt.`,
      );
    }
    this.#assertLeaseIdentity(message, true);
    this.#assertIncreasingControlSequence(message);
    // The frozen parser proves authorityReceiptHash is a syntactically valid
    // hash and binds budget committedRunRevision to the envelope. Only the Go
    // control authority can recompute that receipt from its durable record;
    // this TS session never treats the hash itself as a locally minted grant.
    if (
      message.kind !== outstanding.expectedDecision.kind ||
      !outstanding.expectedDecision.match(message)
    ) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_CONTROL_DECISION_MISMATCH',
        'Control decision does not match the receipted event.',
      );
    }
    if (
      (message.kind === 'effect_authorization' || message.kind === 'resume_offer') &&
      Date.parse(requiredString(message, 'expiresAt')) <= Date.parse(this.#now())
    ) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_CONTROL_DECISION_EXPIRED',
        `${message.kind} expired before use.`,
      );
    }
    if (message.runRevision !== null) this.#requireLease().runRevision = message.runRevision;
    this.#outstanding = undefined;
    outstanding.resolveDecision?.(message);
  }

  async #handleCancel(message: WorkflowControlAuthorityMessage): Promise<void> {
    if (!this.#lease || this.#terminalReceiptAccepted) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_STATE',
        'Cancel request does not target an active v2 attempt.',
      );
    }
    this.#assertLeaseIdentity(message, true);
    this.#assertIncreasingControlSequence(message);
    if (Date.parse(requiredString(message, 'expiresAt')) <= Date.parse(this.#now())) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_CONTROL_DECISION_EXPIRED',
        'Cancel request expired before receipt.',
      );
    }
    this.#queuedCancel = message;
    if (!this.#terminal) {
      this.#abortController?.abort(
        new Error(`workflow runner v2 cancel: ${String(messagePayload(message).reason)}`),
      );
    }
    if (this.#outstanding) return;
    await this.#applyQueuedCancel();
  }

  async #applyQueuedCancel(): Promise<void> {
    if (!this.#queuedCancel) return;
    await this.#withEventLane(() => this.#applyQueuedCancelInLane());
  }

  async #applyQueuedCancelInLane(): Promise<void> {
    const cancel = this.#queuedCancel;
    if (!cancel || this.#outstanding) return;
    this.#queuedCancel = undefined;
    if (!this.#terminal) {
      this.#state = 'cancelling';
    }
    await this.#emitReceiptableNow('cancel_ack', {
      cancelId: requiredString(cancel, 'cancelId'),
      acknowledgedAt: this.#now(),
      status: this.#terminal ? 'already_terminal' : 'cancelling',
    });
  }

  async #afterDecisionLane(): Promise<void> {
    while (true) {
      const tail = this.#eventLaneTail;
      await tail;
      if (tail === this.#eventLaneTail) return;
    }
  }

  async #withEventLane<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#eventLaneTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#eventLanePending += 1;
    this.#eventLaneTail = predecessor.catch(() => undefined).then(() => current);
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      this.#eventLanePending -= 1;
      release();
    }
  }

  #leaseBindingFromMessage(message: WorkflowControlAuthorityMessage, label: string): LeaseBinding {
    if (
      message.jobId === null ||
      message.workflowRunId === null ||
      message.attemptId === null ||
      message.leaseId === null ||
      message.fencingToken === null ||
      message.authorityBackend === null ||
      message.authority === null ||
      message.routingEpoch === null ||
      message.authorityBuildHash === null ||
      message.runRevision === null ||
      message.resumeGeneration === null
    ) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_ADMISSION_BINDING_MISMATCH',
        `${label} lacks its v2 authority binding.`,
      );
    }
    return {
      workspaceId: message.workspaceId,
      jobId: message.jobId!,
      workflowRunId: message.workflowRunId!,
      attemptId: message.attemptId!,
      leaseId: message.leaseId!,
      fencingToken: message.fencingToken!,
      correlationId: message.correlationId,
      authorityBackend: message.authorityBackend!,
      authority: message.authority!,
      routingEpoch: message.routingEpoch!,
      authorityBuildHash: message.authorityBuildHash!,
      runRevision: message.runRevision!,
      resumeGeneration: message.resumeGeneration!,
      leaseExpiresAt: requiredString(message, 'expiresAt'),
    };
  }

  #assertLeaseIdentity(message: WorkflowControlAuthorityMessage, decision: boolean): void {
    const lease = this.#requireLease();
    if (
      message.workspaceId !== lease.workspaceId ||
      message.jobId !== lease.jobId ||
      message.workflowRunId !== lease.workflowRunId ||
      message.attemptId !== lease.attemptId ||
      message.leaseId !== lease.leaseId ||
      message.fencingToken !== lease.fencingToken ||
      message.correlationId !== lease.correlationId ||
      message.authorityBackend !== lease.authorityBackend ||
      message.authority !== lease.authority ||
      message.routingEpoch !== lease.routingEpoch ||
      message.authorityBuildHash !== lease.authorityBuildHash ||
      message.resumeGeneration !== lease.resumeGeneration ||
      (decision ? message.runRevision !== lease.runRevision : false)
    ) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_ADMISSION_BINDING_MISMATCH',
        'Control message drifted from the accepted v2 authority binding.',
      );
    }
  }

  #assertIncreasingControlSequence(message: WorkflowControlAuthorityMessage): void {
    if (message.sequence === null || message.sequence !== this.#lastControlSequence + 1) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_SEQUENCE',
        'Control sequence is not the exact next control-side sequence.',
      );
    }
    this.#lastControlSequence = message.sequence;
  }

  #receiptableSentAt(kind: ReceiptableKind, payload: Readonly<Record<string, unknown>>): string {
    const key =
      kind === 'lease_accept'
        ? 'acceptedAt'
        : kind === 'lease_reject'
          ? 'rejectedAt'
          : kind === 'heartbeat'
            ? 'observedAt'
            : kind === 'cancel_ack'
              ? 'acknowledgedAt'
              : kind === 'terminal'
                ? 'finishedAt'
                : undefined;
    const value = key === undefined ? undefined : payload[key];
    return typeof value === 'string' ? value : this.#now();
  }

  #requireLease(): LeaseBinding {
    if (!this.#lease) {
      throw new WorkflowRunnerV2SessionError(
        'WORKFLOW_RUNNER_V2_SESSION_STATE',
        'V2 session has no active lease.',
      );
    }
    return this.#lease;
  }

  async #send(message: WorkflowControlAuthorityMessage): Promise<void> {
    await this.#options.send(prepareWorkflowControlAuthorityMessage(message).body);
  }

  #clearLease(): void {
    this.#lease = undefined;
    this.#descriptor = undefined;
    this.#preparedSource = undefined;
    this.#abortController = undefined;
    this.#resumeOffer = null;
    this.#workerSequence = 0;
    this.#lastReceiptSequence = 0;
    this.#queuedCancel = undefined;
    this.#terminal = false;
    this.#terminalReceiptAccepted = false;
  }

  async #fatal(error: unknown): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'reconciliation_required') return;
    const failure =
      error instanceof Error
        ? error
        : new WorkflowRunnerV2SessionError(
            'WORKFLOW_RUNNER_V2_RECONCILIATION_REQUIRED',
            'Unknown v2 session failure.',
          );
    this.#outstanding?.rejectReceipt(failure);
    this.#outstanding?.rejectDecision?.(failure);
    this.#outstanding = undefined;
    this.#state = 'reconciliation_required';
    await this.#options.close(2);
  }
}
