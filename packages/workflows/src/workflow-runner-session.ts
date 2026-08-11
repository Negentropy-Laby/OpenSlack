import { randomUUID } from 'node:crypto';
import type { RunResult, WorkflowModule } from './types.js';
import {
  WORKFLOW_RUNNER_CAPABILITIES,
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  WORKFLOW_RUNNER_RUNTIME_NAME,
  encodeWorkflowRunnerMessage,
  prepareWorkflowRunnerMessage,
  validateWorkflowRunnerEventReceipt,
  validateWorkflowRunnerMessage,
  workflowRunnerDirectionForKind,
  type WorkflowRunnerCancelRequestMessage,
  type WorkflowRunnerEventReceiptMessage,
  type WorkflowRunnerLeaseOfferMessage,
  type WorkflowRunnerMessage,
  type WorkflowRunnerPreparedMessage,
  type WorkflowRunnerReceiptableKind,
  type WorkflowRunnerTerminalPayload,
} from './workflow-runner-contract.js';
import {
  assertWorkflowRunnerDescriptorOfferBinding,
  hashWorkflowRunnerResult,
  type WorkflowRunnerExecutionDescriptor,
} from './workflow-runner-descriptor.js';
import type { WorkflowRunnerDescriptorStore } from './workflow-runner-descriptor-store.js';
import {
  createWorkflowRunnerProtocolEffectBoundary,
  type WorkflowEffectBoundary,
  type WorkflowEffectBoundaryHandle,
  type WorkflowRunnerEffectEventPort,
} from './workflow-runner-effect-boundary.js';
import {
  createWorkflowCheckpointLeaseAuthority,
  type WorkflowCheckpointLeaseAuthority,
} from './internal/workflow-checkpoint-lease-authority.js';

export type WorkflowRunnerSessionState =
  | 'created'
  | 'waiting_hello_ack'
  | 'idle'
  | 'validating_offer'
  | 'waiting_accept_receipt'
  | 'executing'
  | 'cancelling'
  | 'waiting_terminal_receipt'
  | 'reconciliation_required'
  | 'closed';

export class WorkflowRunnerSessionError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_SESSION_STATE'
      | 'WORKFLOW_RUNNER_SESSION_DIRECTION'
      | 'WORKFLOW_RUNNER_SESSION_IDENTITY'
      | 'WORKFLOW_RUNNER_SESSION_SEQUENCE'
      | 'WORKFLOW_RUNNER_SESSION_CONTROL_EXPIRED'
      | 'WORKFLOW_RUNNER_SESSION_RECONCILIATION',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowRunnerSessionError';
  }
}

export interface WorkflowRunnerPreparedSource<TPrepared = unknown> {
  readonly descriptor: WorkflowRunnerExecutionDescriptor;
  readonly prepared: TPrepared;
}

export interface WorkflowRunnerSourceLoader<TPrepared = unknown> {
  /** Reads and hashes only; this method must not dynamically import workflow code. */
  prepare(descriptor: WorkflowRunnerExecutionDescriptor): Promise<TPrepared>;
  /** Called only after the lease_accept event has a durable advancing receipt. */
  load(descriptor: WorkflowRunnerExecutionDescriptor, prepared: TPrepared): Promise<WorkflowModule>;
}

export interface WorkflowRunnerExecutionContext {
  readonly signal: AbortSignal;
  readonly effectBoundary: WorkflowEffectBoundary;
  /** Constructed only after lease_accept has an advancing receipt. */
  readonly checkpointAuthority: WorkflowCheckpointLeaseAuthority;
}

export interface WorkflowRunnerSessionOptions<TPrepared = unknown> {
  readonly workspaceId: string;
  readonly runnerBuildHash: string;
  readonly runtimeVersion: string;
  readonly descriptorStore: Pick<WorkflowRunnerDescriptorStore, 'read'>;
  readonly sourceLoader: WorkflowRunnerSourceLoader<TPrepared>;
  readonly execute: (
    workflow: WorkflowModule,
    descriptor: WorkflowRunnerExecutionDescriptor,
    context: WorkflowRunnerExecutionContext,
  ) => Promise<RunResult>;
  readonly send: (exactBytes: string) => void | Promise<void>;
  readonly close: (exitCode: number) => void | Promise<void>;
  readonly now?: () => string;
}

interface LeaseIdentity {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly workflowRunId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly correlationId: string;
  readonly leaseExpiresAt: string;
}

interface OutstandingEvent {
  readonly message: WorkflowRunnerMessage & { readonly kind: WorkflowRunnerReceiptableKind };
  readonly prepared: WorkflowRunnerPreparedMessage;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface HelloIdentity {
  readonly eventId: string;
  readonly correlationId: string;
  readonly runnerBuildHash: string;
}

function safeId(prefix: string): string {
  return `${prefix}.${randomUUID()}`;
}

function assertHash(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new WorkflowRunnerSessionError(
      'WORKFLOW_RUNNER_SESSION_IDENTITY',
      `${label} is invalid.`,
    );
  }
}

export class WorkflowRunnerSession<TPrepared = unknown> implements WorkflowRunnerEffectEventPort {
  readonly #options: WorkflowRunnerSessionOptions<TPrepared>;
  #state: WorkflowRunnerSessionState = 'created';
  #helloIdentity: HelloIdentity | undefined;
  #controlBuildHash: string | undefined;
  #heartbeatIntervalMs = 0;
  #lease: LeaseIdentity | undefined;
  #descriptor: WorkflowRunnerExecutionDescriptor | undefined;
  #preparedSource: TPrepared | undefined;
  #outstanding: OutstandingEvent | undefined;
  #workerSequence = 0;
  #lastReceiptSequence = 0;
  #lastControlSequence = 0;
  #abortController: AbortController | undefined;
  #queuedCancel: WorkflowRunnerCancelRequestMessage | undefined;
  #cancelReason: WorkflowRunnerCancelRequestMessage['payload']['reason'] | undefined;
  #effectAmbiguous = false;
  #terminal = false;

  constructor(options: WorkflowRunnerSessionOptions<TPrepared>) {
    assertHash(options.runnerBuildHash, 'runnerBuildHash');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(options.workspaceId)) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_IDENTITY',
        'workspaceId is invalid.',
      );
    }
    this.#options = options;
  }

  get state(): WorkflowRunnerSessionState {
    return this.#state;
  }

  get heartbeatIntervalMs(): number {
    return this.#heartbeatIntervalMs;
  }

  get hasOutstandingEvent(): boolean {
    return this.#outstanding !== undefined;
  }

  #now(): string {
    const value = (this.#options.now ?? (() => new Date().toISOString()))();
    if (new Date(Date.parse(value)).toISOString() !== value) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_STATE',
        'Session clock must return a canonical timestamp.',
      );
    }
    return value;
  }

  async start(): Promise<void> {
    if (this.#state !== 'created') {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_STATE',
        'Runner session can start only once.',
      );
    }
    const now = this.#now();
    const helloIdentity = Object.freeze({
      eventId: safeId('hello'),
      correlationId: safeId('session'),
      runnerBuildHash: this.#options.runnerBuildHash,
    });
    const hello = validateWorkflowRunnerMessage({
      protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
      kind: 'hello',
      workspaceId: this.#options.workspaceId,
      jobId: null,
      workflowRunId: null,
      attemptId: null,
      leaseId: null,
      fencingToken: null,
      sequence: null,
      eventId: helloIdentity.eventId,
      correlationId: helloIdentity.correlationId,
      sentAt: now,
      payload: {
        runtimeName: WORKFLOW_RUNNER_RUNTIME_NAME,
        runtimeVersion: this.#options.runtimeVersion,
        runnerBuildHash: helloIdentity.runnerBuildHash,
        supportedProtocolVersions: [WORKFLOW_RUNNER_PROTOCOL_VERSION],
        capabilities: [...WORKFLOW_RUNNER_CAPABILITIES],
        maxConcurrentJobs: 1,
      },
    });
    this.#helloIdentity = helloIdentity;
    this.#state = 'waiting_hello_ack';
    await this.#options.send(encodeWorkflowRunnerMessage(hello));
  }

  async receive(messageValue: WorkflowRunnerMessage): Promise<void> {
    if (this.#state === 'closed') return;
    const message = validateWorkflowRunnerMessage(messageValue);
    if (workflowRunnerDirectionForKind(message.kind) !== 'control-to-runner') {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_DIRECTION',
        `Runner cannot receive ${message.kind}.`,
      );
    }
    if (message.workspaceId !== this.#options.workspaceId) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_IDENTITY',
        'Incoming workspace does not match the sealed worker.',
      );
    }
    if (message.kind === 'hello_ack') return this.#handleHelloAck(message);
    if (message.kind === 'lease_offer') return this.#handleLeaseOffer(message);
    if (message.kind === 'event_receipt') return this.#handleReceipt(message);
    if (message.kind === 'cancel_request') return this.#handleCancel(message);
    throw new WorkflowRunnerSessionError(
      'WORKFLOW_RUNNER_SESSION_DIRECTION',
      `Unsupported control message ${message.kind}.`,
    );
  }

  #handleHelloAck(message: Extract<WorkflowRunnerMessage, { kind: 'hello_ack' }>): void {
    if (this.#state !== 'waiting_hello_ack' || !this.#helloIdentity) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_STATE',
        'hello_ack is not valid in the current state.',
      );
    }
    if (message.correlationId !== this.#helloIdentity.correlationId) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_IDENTITY',
        'hello_ack correlation does not bind the emitted hello.',
      );
    }
    if (message.payload.selectedProtocolVersion !== WORKFLOW_RUNNER_PROTOCOL_VERSION) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_IDENTITY',
        'Control selected an unsupported protocol.',
      );
    }
    this.#controlBuildHash = message.payload.controlBuildHash;
    this.#heartbeatIntervalMs = message.payload.heartbeatIntervalMs;
    this.#state = 'idle';
  }

  async #handleLeaseOffer(message: WorkflowRunnerLeaseOfferMessage): Promise<void> {
    if (this.#state !== 'idle') {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_STATE',
        'A lease offer is valid only while the worker is idle.',
      );
    }
    this.#assertIncreasingControlSequence(message.sequence);
    if (Date.parse(message.payload.expiresAt) <= Date.parse(this.#now())) {
      return this.#sendLeaseReject(message, 'stale');
    }
    this.#lease = Object.freeze({
      workspaceId: message.workspaceId,
      jobId: message.jobId,
      workflowRunId: message.workflowRunId,
      attemptId: message.attemptId,
      leaseId: message.leaseId,
      fencingToken: message.fencingToken,
      correlationId: message.correlationId,
      leaseExpiresAt: message.payload.expiresAt,
    });
    this.#abortController = new AbortController();
    this.#state = 'validating_offer';
    let descriptor: WorkflowRunnerExecutionDescriptor;
    try {
      descriptor = await this.#options.descriptorStore.read(
        message.payload.executionDescriptorRef,
        this.#now(),
      );
      assertWorkflowRunnerDescriptorOfferBinding(descriptor, {
        workspaceId: message.workspaceId,
        workflowRunId: message.workflowRunId,
        correlationId: message.correlationId,
        executionDescriptorRef: message.payload.executionDescriptorRef,
        executionDescriptorHash: message.payload.executionDescriptorHash,
        workflowId: message.payload.workflowId,
        workflowVersion: message.payload.workflowVersion,
        workflowSourceHash: message.payload.workflowSourceHash,
        manifestHash: message.payload.manifestHash,
        inputHash: message.payload.inputHash,
      });
    } catch (error) {
      // A missing, invalid, expired, or mismatched descriptor makes the offer
      // invalid. The v1 contract requires no semantic lease_reject in this case.
      throw error;
    }
    let prepared: TPrepared;
    try {
      // This is deliberately a read/hash-only hook. Dynamic import belongs to load().
      prepared = await this.#options.sourceLoader.prepare(descriptor);
    } catch {
      // The offer is well-formed and bound, but this sealed worker catalog does
      // not support the requested source on this host.
      return this.#sendLeaseReject(message, 'unsupported');
    }
    this.#descriptor = descriptor;
    this.#preparedSource = prepared;
    this.#state = 'waiting_accept_receipt';
    const acceptedAt = this.#now();
    await this.#emitReceiptable('lease_accept', {
      acceptedAt,
      leaseExpiresAt: message.payload.expiresAt,
    });
    if (this.#queuedCancel) await this.#sendQueuedCancelAck();
    this.#state = this.#abortController.signal.aborted ? 'cancelling' : 'executing';
    // Start asynchronously so the input loop remains available for cancel_request.
    void this.#executeLease().catch((error) => this.#fatal(error));
  }

  async #sendLeaseReject(
    message: WorkflowRunnerLeaseOfferMessage,
    reason: 'unsupported' | 'stale',
  ): Promise<void> {
    this.#lease = Object.freeze({
      workspaceId: message.workspaceId,
      jobId: message.jobId,
      workflowRunId: message.workflowRunId,
      attemptId: message.attemptId,
      leaseId: message.leaseId,
      fencingToken: message.fencingToken,
      correlationId: message.correlationId,
      leaseExpiresAt: message.payload.expiresAt,
    });
    await this.#emitReceiptable('lease_reject', { rejectedAt: this.#now(), reason });
    if (this.#outstanding) await this.#waitForOutstanding();
    this.#clearLease();
    this.#state = 'idle';
  }

  async #executeLease(): Promise<void> {
    const descriptor = this.#descriptor!;
    const lease = this.#lease!;
    if (this.#abortController?.signal.aborted) {
      return this.#sendTerminalForError(this.#abortController.signal.reason);
    }
    const workflow = await this.#options.sourceLoader.load(descriptor, this.#preparedSource!);
    if (this.#abortController?.signal.aborted) {
      return this.#sendTerminalForError(this.#abortController.signal.reason);
    }
    try {
      const boundary = createWorkflowRunnerProtocolEffectBoundary({
        port: this,
        requiresHumanDecision: (operation) => {
          const approved = descriptor.confirmationPolicy.approvalManifest?.approvedEffects.some(
            (effect) => effect.kind === operation,
          );
          return descriptor.confirmationPolicy.mode !== 'unattended-explicit' && !approved;
        },
      });
      const result = await this.#options.execute(workflow, descriptor, {
        signal: this.#abortController!.signal,
        effectBoundary: boundary,
        checkpointAuthority: createWorkflowCheckpointLeaseAuthority({
          workspaceId: lease.workspaceId,
          jobId: lease.jobId,
          workflowRunId: lease.workflowRunId,
          attemptId: lease.attemptId,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          correlationId: lease.correlationId,
          runnerBuildHash: this.#options.runnerBuildHash,
          workflowSourceHash: descriptor.workflowSourceHash,
          manifestHash: descriptor.manifestHash,
          inputHash: descriptor.inputHash,
        }),
      });
      if (this.#effectAmbiguous) return this.#sendReconciliationTerminal();
      await this.#sendTerminal({
        status: 'completed',
        finishedAt: this.#now(),
        resultHash: hashWorkflowRunnerResult(result),
        terminalReason: null,
      });
    } catch (error) {
      await this.#sendTerminalForError(error);
    }
  }

  async #sendTerminalForError(error: unknown): Promise<void> {
    if (this.#state === 'reconciliation_required') return;
    if (this.#effectAmbiguous && this.#outstanding) {
      this.#state = 'reconciliation_required';
      await this.#options.close(2);
      return;
    }
    if (this.#effectAmbiguous) return this.#sendReconciliationTerminal();
    if (this.#abortController?.signal.aborted || this.#cancelReason) {
      const timedOut = this.#cancelReason === 'timeout';
      return this.#sendTerminal({
        status: timedOut ? 'timed_out' : 'cancelled',
        finishedAt: this.#now(),
        resultHash: null,
        terminalReason: timedOut ? 'timeout' : 'cancelled_by_control',
      });
    }
    void error;
    return this.#sendTerminal({
      status: 'failed',
      finishedAt: this.#now(),
      resultHash: null,
      terminalReason: 'workflow_failed',
    });
  }

  async #sendReconciliationTerminal(): Promise<void> {
    await this.#sendTerminal({
      status: 'reconciliation_required',
      finishedAt: this.#now(),
      resultHash: null,
      terminalReason: 'commit_outcome_unknown',
    });
  }

  async #sendTerminal(payload: WorkflowRunnerTerminalPayload): Promise<void> {
    if (this.#terminal || this.#state === 'closed' || this.#state === 'reconciliation_required') {
      return;
    }
    if (this.#outstanding) await this.#waitForOutstanding();
    this.#terminal = true;
    this.#state = 'waiting_terminal_receipt';
    await this.#emitReceiptable('terminal', payload);
    if (this.#queuedCancel) await this.#sendQueuedCancelAck();
    this.#state = 'closed';
    await this.#options.close(0);
  }

  async emitIntent(handle: WorkflowEffectBoundaryHandle): Promise<void> {
    await this.#emitReceiptable('effect_intent', {
      effectId: handle.effectId,
      effectKind: handle.effectKind,
      effectHash: handle.effectHash,
      capabilityHash: handle.capabilityHash,
      requiresHumanDecision: handle.requiresHumanDecision,
    });
  }

  async emitOutcome(input: {
    readonly effectId: string;
    readonly status: 'rejected' | 'executed' | 'failed' | 'reconciliation_required';
    readonly outcomeHash: string;
  }): Promise<void> {
    const commitMayHaveHappened =
      input.status === 'executed' || input.status === 'reconciliation_required';
    if (commitMayHaveHappened) this.#effectAmbiguous = true;
    await this.#emitReceiptable('effect_outcome', input);
    if (input.status === 'executed') this.#effectAmbiguous = false;
  }

  async heartbeat(): Promise<boolean> {
    if (!['executing', 'cancelling'].includes(this.#state) || this.#outstanding || !this.#lease) {
      return false;
    }
    const state = this.#state === 'cancelling' ? 'cancelling' : 'running';
    void this.#emitReceiptable('heartbeat', {
      observedAt: this.#now(),
      leaseExpiresAt: this.#lease.leaseExpiresAt,
      state,
      lastReceiptSequence: this.#lastReceiptSequence,
    }).catch((error) => this.#fatal(error));
    return true;
  }

  async retryOutstanding(): Promise<boolean> {
    if (!this.#outstanding || this.#state === 'closed') return false;
    await this.#options.send(this.#outstanding.prepared.body);
    return true;
  }

  async #emitReceiptable(kind: WorkflowRunnerReceiptableKind, payload: unknown): Promise<void> {
    if (!this.#lease) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_STATE',
        'Cannot emit a leased event without an active lease.',
      );
    }
    if (this.#outstanding) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_SEQUENCE',
        'Only one worker event may be outstanding.',
      );
    }
    this.#workerSequence += 1;
    const message = validateWorkflowRunnerMessage({
      protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
      kind,
      workspaceId: this.#lease.workspaceId,
      jobId: this.#lease.jobId,
      workflowRunId: this.#lease.workflowRunId,
      attemptId: this.#lease.attemptId,
      leaseId: this.#lease.leaseId,
      fencingToken: this.#lease.fencingToken,
      sequence: this.#workerSequence,
      eventId: safeId(kind),
      correlationId: this.#lease.correlationId,
      sentAt: this.#now(),
      payload,
    }) as WorkflowRunnerMessage & { readonly kind: WorkflowRunnerReceiptableKind };
    const prepared = prepareWorkflowRunnerMessage(message);
    const receipt = new Promise<void>((resolve, reject) => {
      this.#outstanding = { message, prepared, resolve, reject };
    });
    await this.#options.send(prepared.body);
    await receipt;
  }

  #handleReceipt(message: WorkflowRunnerEventReceiptMessage): void {
    if (!this.#outstanding || !this.#controlBuildHash) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_STATE',
        'Receipt does not match an outstanding worker event.',
      );
    }
    this.#assertLeaseIdentity(message);
    this.#assertIncreasingControlSequence(message.sequence);
    const receipt = validateWorkflowRunnerEventReceipt(
      message,
      this.#outstanding.message,
      this.#controlBuildHash,
    );
    const outstanding = this.#outstanding;
    this.#outstanding = undefined;
    if (receipt.payload.status === 'reconciliation_required') {
      this.#state = 'reconciliation_required';
      outstanding.reject(
        new WorkflowRunnerSessionError(
          'WORKFLOW_RUNNER_SESSION_RECONCILIATION',
          'Control requires reconciliation for the outstanding event.',
        ),
      );
      void this.#options.close(2);
      return;
    }
    this.#lastReceiptSequence = outstanding.message.sequence;
    outstanding.resolve();
    if (this.#queuedCancel && outstanding.message.kind !== 'terminal') {
      void this.#sendQueuedCancelAck().catch((error) => this.#fatal(error));
    }
  }

  async #handleCancel(message: WorkflowRunnerCancelRequestMessage): Promise<void> {
    const terminalReceiptOutstanding =
      this.#terminal &&
      this.#state === 'waiting_terminal_receipt' &&
      this.#outstanding?.message.kind === 'terminal';
    if (!this.#lease || (this.#terminal && !terminalReceiptOutstanding)) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_STATE',
        'Cancel request does not target an active attempt.',
      );
    }
    this.#assertLeaseIdentity(message);
    this.#assertIncreasingControlSequence(message.sequence);
    if (Date.parse(message.payload.expiresAt) <= Date.parse(this.#now())) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_CONTROL_EXPIRED',
        'Cancel request expired before receipt.',
      );
    }
    if (this.#queuedCancel && this.#queuedCancel.payload.cancelId !== message.payload.cancelId) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_STATE',
        'A different cancel request is already active.',
      );
    }
    this.#queuedCancel = message;
    if (terminalReceiptOutstanding) return;
    this.#cancelReason = message.payload.reason;
    const validatingOffer = this.#state === 'validating_offer';
    this.#state = 'cancelling';
    this.#abortController?.abort(new Error(`workflow runner cancel: ${message.payload.reason}`));
    if (!this.#outstanding && !validatingOffer) {
      await this.#sendQueuedCancelAck();
    }
  }

  async #sendQueuedCancelAck(): Promise<void> {
    const cancel = this.#queuedCancel;
    if (!cancel || this.#outstanding) return;
    this.#queuedCancel = undefined;
    await this.#emitReceiptable('cancel_ack', {
      cancelId: cancel.payload.cancelId,
      acknowledgedAt: this.#now(),
      status: this.#terminal
        ? 'already_terminal'
        : this.#abortController
          ? 'cancelling'
          : 'cancelled',
    });
  }

  #assertLeaseIdentity(
    message: Exclude<WorkflowRunnerMessage, { kind: 'hello' | 'hello_ack' }>,
  ): void {
    const lease = this.#lease;
    if (
      !lease ||
      message.workspaceId !== lease.workspaceId ||
      message.jobId !== lease.jobId ||
      message.workflowRunId !== lease.workflowRunId ||
      message.attemptId !== lease.attemptId ||
      message.leaseId !== lease.leaseId ||
      message.fencingToken !== lease.fencingToken ||
      message.correlationId !== lease.correlationId
    ) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_IDENTITY',
        'Control message does not bind the active lease.',
      );
    }
  }

  #assertIncreasingControlSequence(sequence: number): void {
    if (sequence <= this.#lastControlSequence) {
      throw new WorkflowRunnerSessionError(
        'WORKFLOW_RUNNER_SESSION_SEQUENCE',
        'Control sequence is stale or duplicated.',
      );
    }
    this.#lastControlSequence = sequence;
  }

  #waitForOutstanding(): Promise<void> {
    if (!this.#outstanding) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const current = this.#outstanding!;
      this.#outstanding = {
        ...current,
        resolve: () => {
          current.resolve();
          resolve();
        },
        reject: (error) => {
          current.reject(error);
          reject(error);
        },
      };
    });
  }

  #clearLease(): void {
    this.#lease = undefined;
    this.#descriptor = undefined;
    this.#preparedSource = undefined;
    this.#abortController = undefined;
    this.#queuedCancel = undefined;
    this.#cancelReason = undefined;
    this.#workerSequence = 0;
    this.#lastReceiptSequence = 0;
    this.#lastControlSequence = 0;
  }

  async #fatal(_error: unknown): Promise<void> {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    await this.#options.close(1);
  }
}
