import {
  canonicalWorkflowControlAuthorityJson,
  parseWorkflowControlAuthorityMessageBytes,
  prepareWorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityPreparedMessage,
} from './workflow-control-authority-contract.js';
import {
  WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_RESOLUTION_SCHEMA,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_SCHEMA,
  deriveWorkflowRunnerAuthorityBindingId,
  hashWorkflowRunnerAuthorityBindingEvidence,
  hashWorkflowRunnerAuthorityBindingReceipt,
  hashWorkflowRunnerAuthorityBindingStage,
  prepareWorkflowRunnerAuthorityBindingReceipt,
  prepareWorkflowRunnerAuthorityBindingResolution,
  prepareWorkflowRunnerAuthorityBindingStage,
  validateWorkflowRunnerAuthorityBindingResolutionForStage,
  validateWorkflowRunnerAuthorityBindingResolutionReceipt,
  validateWorkflowRunnerAuthorityBindingStageReceipt,
  validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage,
  validateWorkflowRunnerBudgetSourceResult,
  workflowRunnerAuthorityBindingExpectedKind,
  workflowRunnerAuthorityBindingRunnerDelta,
  type WorkflowRunnerAuthorityBindingOperation,
  type WorkflowRunnerAuthorityBindingPrepared,
  type WorkflowRunnerAuthorityBindingReceipt,
  type WorkflowRunnerAuthorityBindingResolution,
  type WorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerAuthorityControlDeliveryReceipt,
  type WorkflowRunnerAuthorityEvidence,
  type WorkflowRunnerAuthorityResolutionReceipt,
  type WorkflowRunnerAuthorityRouteBinding,
  type WorkflowRunnerAuthorityRunnerHead,
  type WorkflowRunnerAuthorityStageReceipt,
  type WorkflowRunnerBudgetSourceResult,
} from './workflow-runner-authority-binding-contract.js';
import type { WorkflowRunnerAuthorityBindingPort } from './workflow-runner-authority-binding-client.js';
import { workflowRunnerAuthorityBindingJournalEntryClosed } from './workflow-runner-authority-binding-journal.js';
import type {
  WorkflowRunnerAuthorityBindingJournal,
  WorkflowRunnerAuthorityBindingJournalEntry,
} from './workflow-runner-authority-binding-journal.js';

export type WorkflowRunnerAuthoritySourceProbe =
  | { readonly state: 'not_committed' }
  | { readonly state: 'unknown'; readonly reason: string }
  | {
      readonly state: 'committed';
      readonly evidence: WorkflowRunnerAuthorityEvidence;
      /** Exact pre-existing companion resolution, including its original timestamp. */
      readonly durableResolution?: {
        readonly resolution: WorkflowRunnerAuthorityBindingResolution;
        readonly receipt: WorkflowRunnerAuthorityResolutionReceipt;
      };
    };

/**
 * A source adapter must point-read its own C/D/E authority before mutation.
 * `commit` is called at most once and only after a definitive not_committed
 * probe. A thrown/unknown commit is followed by one point-read and never by a
 * second mutation.
 */
export interface WorkflowRunnerAuthoritySourceAdapter {
  probe(
    stage: WorkflowRunnerAuthorityBindingStage,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthoritySourceProbe>;
  commit(
    stage: WorkflowRunnerAuthorityBindingStage,
    stageReceipt: WorkflowRunnerAuthorityStageReceipt,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityEvidence>;
  /**
   * Budget E1 is deliberately later than the accepted companion resolution.
   * These point-readable hooks are forbidden for C/D/resume and prevent a
   * response-loss restart from replaying reserve/settle.
   */
  probePostResolution?(
    stage: WorkflowRunnerAuthorityBindingStage,
    resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt,
    signal?: AbortSignal,
  ): Promise<
    | { readonly state: 'not_committed' }
    | { readonly state: 'unknown'; readonly reason: string }
    | {
        readonly state: 'committed';
        readonly budgetSourceResult?: WorkflowRunnerBudgetSourceResult;
      }
  >;
  commitPostResolution?(
    stage: WorkflowRunnerAuthorityBindingStage,
    resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerBudgetSourceResult | undefined>;
}

export interface WorkflowRunnerAuthorityBindingLeaseInput {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly runnerAttemptId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly route: WorkflowRunnerAuthorityRouteBinding;
  readonly runnerAuthority: Pick<
    WorkflowRunnerAuthorityRunnerHead,
    'expectedGlobalRunRevision' | 'expectedResumeGeneration'
  >;
  readonly correlationId: string;
}

export interface WorkflowRunnerAuthorityBindingCommitInput {
  readonly operation: WorkflowRunnerAuthorityBindingOperation;
  readonly lease: WorkflowRunnerAuthorityBindingLeaseInput;
  readonly target: WorkflowControlAuthorityPreparedMessage;
  readonly source: WorkflowRunnerAuthoritySourceAdapter;
  readonly signal?: AbortSignal;
}

export interface WorkflowRunnerAuthorityBindingCommittedContext {
  readonly stage: WorkflowRunnerAuthorityBindingStage;
  readonly stageReceipt: WorkflowRunnerAuthorityStageReceipt;
  readonly resolution: WorkflowRunnerAuthorityBindingResolution;
  readonly resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt;
  /** These are the exact immutable future-event bytes staged before source commit. */
  readonly exactEventBytes: string;
  readonly budgetSourceResult?: WorkflowRunnerBudgetSourceResult;
}

export interface WorkflowRunnerAuthorityControlAckInput {
  readonly bindingId: string;
  readonly message: WorkflowControlAuthorityMessage;
  readonly disposition?: 'accepted' | 'reconciliation_required';
  readonly budgetSourceResult?: WorkflowRunnerBudgetSourceResult;
  readonly signal?: AbortSignal;
}

export class WorkflowRunnerAuthorityBindingRuntimeError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_INPUT_INVALID'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RESPONSE_UNKNOWN'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RECONCILIATION_REQUIRED'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowRunnerAuthorityBindingRuntimeError';
  }
}

function fail(
  code: WorkflowRunnerAuthorityBindingRuntimeError['code'],
  message: string,
  cause?: unknown,
): never {
  throw new WorkflowRunnerAuthorityBindingRuntimeError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exactEqual(left: unknown, right: unknown): boolean {
  return (
    canonicalWorkflowControlAuthorityJson(left) === canonicalWorkflowControlAuthorityJson(right)
  );
}

function canonicalTimestamp(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_INPUT_INVALID',
      'Authority-binding runtime clock must return canonical UTC.',
    );
  }
  return value;
}

function targetMessage(
  target: WorkflowControlAuthorityPreparedMessage,
): WorkflowControlAuthorityMessage {
  let message: WorkflowControlAuthorityMessage;
  try {
    message = parseWorkflowControlAuthorityMessageBytes(Buffer.from(target.body, 'utf8'));
  } catch (error) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_INPUT_INVALID',
      'Authority-binding target is not an exact prepared authority message.',
      error,
    );
  }
  const repeated = prepareWorkflowControlAuthorityMessage(message);
  if (!exactEqual(repeated, target)) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_INPUT_INVALID',
      'Authority-binding target metadata differs from its exact bytes.',
    );
  }
  return message;
}

export class WorkflowRunnerAuthorityBindingRuntime {
  readonly #journal: WorkflowRunnerAuthorityBindingJournal;
  readonly #port: WorkflowRunnerAuthorityBindingPort;
  readonly #now: () => string;
  #recoveryMode = false;

  constructor(options: {
    readonly journal: WorkflowRunnerAuthorityBindingJournal;
    readonly port: WorkflowRunnerAuthorityBindingPort;
    readonly now?: () => string;
  }) {
    this.#journal = options.journal;
    this.#port = options.port;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(
    options: { readonly allowOutstandingForRecovery?: boolean } = {},
  ): Promise<void> {
    await this.#journal.initialize();
    // A full read still revalidates every canonical byte and fails on unsafe
    // entries. Outstanding ownership is scoped by workflow run so distinct
    // qualification workers can share the workspace journal concurrently.
    await this.#journal.list();
    this.#recoveryMode = options.allowOutstandingForRecovery === true;
  }

  async outstandingForAttempt(
    runnerAttemptId: string,
  ): Promise<readonly WorkflowRunnerAuthorityBindingJournalEntry[]> {
    return Object.freeze(
      (await this.#journal.list()).filter(
        (entry) =>
          entry.stage.runnerAttemptId === runnerAttemptId &&
          !workflowRunnerAuthorityBindingJournalEntryClosed(entry),
      ),
    );
  }

  async outstandingForRun(
    runId: string,
  ): Promise<readonly WorkflowRunnerAuthorityBindingJournalEntry[]> {
    return this.#journal.activeForRun(runId);
  }

  async assertRunReady(runId: string): Promise<void> {
    const outstanding = await this.outstandingForRun(runId);
    if (outstanding.length > 0) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
        `Workflow run ${runId} has ${outstanding.length} unclosed authority binding(s); explicit reconciliation is required.`,
      );
    }
  }

  async commit(
    input: WorkflowRunnerAuthorityBindingCommitInput,
  ): Promise<WorkflowRunnerAuthorityBindingCommittedContext> {
    if (this.#recoveryMode) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
        'Recovery mode cannot stage a new authority binding.',
      );
    }
    const stage = this.#prepareStage(input);
    return this.#journal.runWorkflowExclusive(input.lease.runId, async () => {
      const outstanding = await this.outstandingForRun(stage.value.runId);
      const foreign = outstanding.find((entry) => entry.stage.bindingId !== stage.value.bindingId);
      if (foreign) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
          `Unclosed binding ${foreign.stage.bindingId} blocks a later authority mutation.`,
        );
      }
      const existing = await this.#journal.read(stage.value.bindingId);
      if (existing && !exactEqual(existing.stage, stage.value)) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'Authority-binding identity was reused for different staged bytes.',
        );
      }
      if (existing && workflowRunnerAuthorityBindingJournalEntryClosed(existing)) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'A closed authority binding cannot emit its target event again.',
        );
      }
      if (!existing) await this.#journal.putStage(stage.value);
      return this.#advance(stage.value.bindingId, input.source, input.signal);
    });
  }

  async recover(
    bindingId: string,
    source: WorkflowRunnerAuthoritySourceAdapter,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityBindingCommittedContext> {
    if (!this.#recoveryMode) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_INPUT_INVALID',
        'Authority-binding recovery requires explicit recovery-mode initialization.',
      );
    }
    const entry = await this.#journal.read(bindingId);
    if (!entry) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_INPUT_INVALID',
        'Cannot recover an unknown authority binding.',
      );
    }
    return this.#journal.runWorkflowExclusive(entry.stage.runId, async () => {
      const outstanding = await this.outstandingForRun(entry.stage.runId);
      if (outstanding.length !== 1 || outstanding[0]?.stage.bindingId !== entry.stage.bindingId) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
          'Authority-binding recovery found conflicting same-run outstanding mutations.',
        );
      }
      return this.#advance(bindingId, source, signal);
    });
  }

  async acknowledgeControl(
    input: WorkflowRunnerAuthorityControlAckInput,
  ): Promise<WorkflowRunnerAuthorityControlDeliveryReceipt> {
    const entry = await this.#journal.read(input.bindingId);
    if (!entry?.stageReceipt || !entry.resolution || !entry.resolutionReceipt) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
        'Control delivery cannot be acknowledged before an accepted resolution.',
      );
    }
    return this.#journal.runWorkflowExclusive(entry.stage.runId, async () => {
      const current = await this.#journal.read(input.bindingId);
      if (!current?.stageReceipt || !current.resolution || !current.resolutionReceipt) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
          'Authority-binding context disappeared before control acknowledgement.',
        );
      }
      const messagePrepared = prepareWorkflowControlAuthorityMessage(input.message);
      const budgetSourceResult =
        input.message.kind === 'budget_authorization'
          ? (input.budgetSourceResult ?? current.budgetSourceResult)
          : undefined;
      const companionSequence = input.message.kind === 'event_receipt' ? 3 : 4;
      const sameSequence = current.controlDeliveries.find(
        (delivery) => delivery.companionSequence === companionSequence,
      );
      if (workflowRunnerAuthorityBindingJournalEntryClosed(current)) {
        if (
          sameSequence &&
          exactEqual(sameSequence.message, input.message) &&
          sameSequence.receipt &&
          sameSequence.confirmedReceipt
        ) {
          return sameSequence.confirmedReceipt;
        }
        const foreignOutstanding = (await this.outstandingForRun(current.stage.runId)).find(
          (candidate) => candidate.stage.bindingId !== current.stage.bindingId,
        );
        if (foreignOutstanding) {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
            'A later control delivery cannot target a closed sibling while another same-run binding is outstanding.',
          );
        }
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'A closed authority binding cannot accept a later control delivery.',
        );
      }
      const outstanding = await this.outstandingForRun(current.stage.runId);
      if (outstanding.length !== 1 || outstanding[0]?.stage.bindingId !== current.stage.bindingId) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
          'A control delivery cannot advance while another same-run binding is outstanding.',
        );
      }
      if (sameSequence) {
        if (!exactEqual(sameSequence.message, input.message) || !sameSequence.receipt) {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
            'A different control message cannot clear an earlier durable ACK.',
          );
        }
        if (sameSequence.confirmedReceipt) return sameSequence.confirmedReceipt;
        return this.#confirmAck(input.bindingId, sameSequence.receipt, input.signal);
      }
      const prior = current.controlDeliveries.find((delivery) => delivery.companionSequence === 3);
      if (companionSequence === 4 && !prior?.confirmedReceipt) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
          'Decision delivery cannot bypass an unconfirmed event-receipt ACK.',
        );
      }
      const committedAt = canonicalTimestamp(this.#now());
      const candidate: WorkflowRunnerAuthorityControlDeliveryReceipt = {
        schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
        contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
        profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
        direction: 'runner-to-control',
        phase: 'control_delivery',
        companionSequence,
        bindingId: current.stage.bindingId,
        operation: current.stage.operation,
        status: 'accepted',
        controlBuildHash: current.stage.route.authorityBuildHash,
        committedAt,
        reconciliationToken: null,
        controlEventId: input.message.eventId,
        controlKind: input.message
          .kind as WorkflowRunnerAuthorityControlDeliveryReceipt['controlKind'],
        controlSequence: input.message.sequence!,
        messageDigest: messagePrepared.messageDigest,
        runnerAttemptId: current.stage.runnerAttemptId,
        leaseId: current.stage.leaseId,
        fencingToken: current.stage.fencingToken,
        processedAt: committedAt,
        disposition: input.disposition ?? 'accepted',
      };
      let validated: WorkflowRunnerAuthorityControlDeliveryReceipt;
      try {
        validated = validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
          candidate,
          input.message,
          {
            stage: current.stage,
            stageReceipt: current.stageReceipt,
            resolution: current.resolution,
            resolutionReceipt: current.resolutionReceipt,
            priorEventDelivery:
              companionSequence === 3
                ? null
                : { message: prior!.message, receipt: prior!.confirmedReceipt },
            ...(budgetSourceResult === undefined ? {} : { budgetSourceResult }),
          },
        );
      } catch (error) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'Control delivery does not bind the exact F2a context.',
          error,
        );
      }
      await this.#journal.putControlMessage(
        input.bindingId,
        companionSequence,
        input.message,
        budgetSourceResult,
      );
      await this.#journal.putControlReceipt(input.bindingId, validated);
      return this.#confirmAck(input.bindingId, validated, input.signal);
    });
  }

  #prepareStage(
    input: WorkflowRunnerAuthorityBindingCommitInput,
  ): WorkflowRunnerAuthorityBindingPrepared<WorkflowRunnerAuthorityBindingStage> {
    const message = targetMessage(input.target);
    if (
      input.lease.route.backend !== 'go' ||
      input.lease.route.authority !== 'workflow-control' ||
      message.authorityBackend !== 'go' ||
      message.authority !== 'workflow-control' ||
      workflowRunnerAuthorityBindingExpectedKind(input.operation) !== message.kind ||
      message.sequence === null ||
      message.runRevision === null ||
      message.resumeGeneration === null
    ) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_INPUT_INVALID',
        'F2b requires a Go workflow-control route and an exact matching future event.',
      );
    }
    const delta = workflowRunnerAuthorityBindingRunnerDelta(input.operation);
    const runnerAuthority: WorkflowRunnerAuthorityRunnerHead = {
      expectedGlobalRunRevision: input.lease.runnerAuthority.expectedGlobalRunRevision,
      acceptedGlobalRunRevision:
        input.lease.runnerAuthority.expectedGlobalRunRevision + delta.revision,
      expectedResumeGeneration: input.lease.runnerAuthority.expectedResumeGeneration,
      acceptedResumeGeneration:
        input.lease.runnerAuthority.expectedResumeGeneration + delta.generation,
    };
    const target = {
      schema: input.target.schema,
      eventId: message.eventId,
      kind: message.kind,
      sequence: message.sequence,
      body: input.target.body,
      messageDigest: input.target.messageDigest,
      idempotencyKey: input.target.idempotencyKey,
      requestFingerprint: input.target.requestFingerprint,
    } as const;
    const identity = {
      operation: input.operation,
      workspaceId: input.lease.workspaceId,
      jobId: input.lease.jobId,
      runId: input.lease.runId,
      runnerAttemptId: input.lease.runnerAttemptId,
      leaseId: input.lease.leaseId,
      fencingToken: input.lease.fencingToken,
      route: input.lease.route,
      runnerAuthority,
      target,
    };
    return prepareWorkflowRunnerAuthorityBindingStage({
      schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_SCHEMA,
      contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
      profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
      phase: 'stage_event',
      direction: 'runner-to-control',
      companionSequence: 1,
      bindingId: deriveWorkflowRunnerAuthorityBindingId(identity),
      ...identity,
      correlationId: input.lease.correlationId,
      sentAt: message.sentAt,
    });
  }

  async #advance(
    bindingId: string,
    source: WorkflowRunnerAuthoritySourceAdapter,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityBindingCommittedContext> {
    let entry = await this.#journal.read(bindingId);
    if (!entry) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
        'Durable authority-binding stage disappeared.',
      );
    }
    let stageReceipt = entry.stageReceipt;
    if (!stageReceipt) {
      const prepared = prepareWorkflowRunnerAuthorityBindingStage(entry.stage);
      const raw = await this.#postWithPointRead(
        prepared,
        () => this.#port.stage(prepared, signal),
        signal,
      );
      try {
        stageReceipt = validateWorkflowRunnerAuthorityBindingStageReceipt(raw, entry.stage);
      } catch (error) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'Stage receipt does not bind the durable staged event.',
          error,
        );
      }
      await this.#accepted(stageReceipt, 'stage');
      await this.#journal.putStageReceipt(bindingId, stageReceipt);
      entry = (await this.#journal.read(bindingId))!;
    }
    await this.#accepted(stageReceipt, 'stage');
    let evidence = entry.sourceEvidence;
    let durableResolution: Extract<
      WorkflowRunnerAuthoritySourceProbe,
      { state: 'committed' }
    >['durableResolution'];
    if (!evidence) {
      const first = await this.#probeSource(source, entry.stage, signal);
      if (first.state === 'unknown') {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
          `Source authority point-read is unknown: ${first.reason}`,
        );
      }
      if (first.state === 'committed') {
        evidence = first.evidence;
        durableResolution = first.durableResolution;
      } else {
        try {
          evidence = await source.commit(entry.stage, stageReceipt, signal);
        } catch (error) {
          const recovered = await this.#probeSource(source, entry.stage, signal);
          if (recovered.state !== 'committed') {
            return fail(
              isWorkflowAuthorityConflict(error)
                ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RECONCILIATION_REQUIRED'
                : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
              'Source commit outcome is not durably point-readable; mutation will not be replayed.',
              error,
            );
          }
          evidence = recovered.evidence;
          durableResolution = recovered.durableResolution;
        }
      }
      try {
        hashWorkflowRunnerAuthorityBindingEvidence(evidence, entry.stage.operation);
      } catch (error) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'Source authority returned invalid exact evidence.',
          error,
        );
      }
      await this.#journal.putSourceEvidence(bindingId, entry.stage.operation, evidence);
      entry = (await this.#journal.read(bindingId))!;
    } else if (!entry.resolution) {
      const probe = await this.#probeSource(source, entry.stage, signal);
      if (probe.state !== 'committed')
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
          'Persisted source evidence requires its current exact operation proof.',
        );
      if (!exactEqual(probe.evidence, evidence))
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'Durable source evidence differs from the local journal.',
        );
      durableResolution = probe.durableResolution;
    }
    if (durableResolution && !entry.resolution) {
      const historical = validateWorkflowRunnerAuthorityBindingResolutionForStage(
        durableResolution.resolution,
        entry.stage,
        stageReceipt,
      );
      const receipt = validateWorkflowRunnerAuthorityBindingResolutionReceipt(
        durableResolution.receipt,
        historical,
        entry.stage,
        stageReceipt,
      );
      if (!exactEqual(historical.evidence, evidence))
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'Historical resolution differs from its immutable source evidence.',
        );
      await this.#accepted(receipt, 'resolution');
      await this.#journal.putResolution(bindingId, historical);
      await this.#journal.putResolutionReceipt(bindingId, receipt);
      entry = (await this.#journal.read(bindingId))!;
    }
    let resolution = entry.resolution;
    if (!resolution) {
      const sentAt = canonicalTimestamp(this.#now());
      const candidate = prepareWorkflowRunnerAuthorityBindingResolution({
        schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_RESOLUTION_SCHEMA,
        contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
        profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
        phase: 'commit_authority',
        direction: 'runner-to-control',
        companionSequence: 2,
        bindingId,
        operation: entry.stage.operation,
        stageHash: hashWorkflowRunnerAuthorityBindingStage(entry.stage),
        stageReceiptHash: hashWorkflowRunnerAuthorityBindingReceipt(stageReceipt),
        targetBodyHash: entry.stage.target.messageDigest,
        evidence,
        evidenceHash: hashWorkflowRunnerAuthorityBindingEvidence(evidence, entry.stage.operation),
        sentAt,
      });
      try {
        resolution = validateWorkflowRunnerAuthorityBindingResolutionForStage(
          candidate.value,
          entry.stage,
          stageReceipt,
        );
      } catch (error) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'Source evidence cannot resolve the exact durable stage.',
          error,
        );
      }
      await this.#journal.putResolution(bindingId, resolution);
      entry = (await this.#journal.read(bindingId))!;
    }
    let resolutionReceipt = entry.resolutionReceipt;
    if (!resolutionReceipt) {
      const prepared = prepareWorkflowRunnerAuthorityBindingResolution(resolution);
      const raw = await this.#postWithPointRead(
        prepared,
        () => this.#port.resolve(bindingId, prepared, signal),
        signal,
      );
      try {
        resolutionReceipt = validateWorkflowRunnerAuthorityBindingResolutionReceipt(
          raw,
          resolution,
          entry.stage,
          stageReceipt,
        );
      } catch (error) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'Resolution receipt does not bind the exact source evidence.',
          error,
        );
      }
      await this.#accepted(resolutionReceipt, 'resolution');
      await this.#journal.putResolutionReceipt(bindingId, resolutionReceipt);
      entry = (await this.#journal.read(bindingId))!;
    }
    await this.#accepted(resolutionReceipt, 'resolution');
    const budgetSourceResult = await this.#completePostResolutionSource(
      entry,
      source,
      resolutionReceipt,
      signal,
    );
    return Object.freeze({
      stage: entry.stage,
      stageReceipt,
      resolution,
      resolutionReceipt,
      exactEventBytes: entry.stage.target.body,
      ...(budgetSourceResult === undefined ? {} : { budgetSourceResult }),
    });
  }

  async #completePostResolutionSource(
    entry: WorkflowRunnerAuthorityBindingJournalEntry,
    source: WorkflowRunnerAuthoritySourceAdapter,
    resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerBudgetSourceResult | undefined> {
    const isBudget =
      entry.stage.operation === 'budget_reserve' || entry.stage.operation === 'budget_settle';
    if (!isBudget) {
      if (source.probePostResolution || source.commitPostResolution) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_INPUT_INVALID',
          'Post-resolution source mutation is valid only for the exact E1 budget lane.',
        );
      }
      return undefined;
    }
    if (!source.probePostResolution || !source.commitPostResolution) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_INPUT_INVALID',
        'Budget source adapter must expose exact post-resolution point-read and commit hooks.',
      );
    }
    if (entry.stage.operation === 'budget_reserve' && entry.budgetSourceResult) {
      return entry.budgetSourceResult;
    }
    let outcome = await source.probePostResolution(entry.stage, resolutionReceipt, signal);
    if (outcome.state === 'unknown') {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
        `Budget source point-read is unknown: ${outcome.reason}`,
      );
    }
    if (outcome.state === 'not_committed') {
      try {
        const result = await source.commitPostResolution(entry.stage, resolutionReceipt, signal);
        outcome = {
          state: 'committed',
          ...(result === undefined ? {} : { budgetSourceResult: result }),
        };
      } catch (error) {
        const recovered = await source.probePostResolution(entry.stage, resolutionReceipt, signal);
        if (recovered.state !== 'committed') {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
            'Budget source outcome is not durably point-readable; reserve/settle will not be replayed.',
            error,
          );
        }
        outcome = recovered;
      }
    }
    const result = outcome.budgetSourceResult;
    if (entry.stage.operation === 'budget_reserve') {
      if (
        !result ||
        entry.resolution?.evidence.schema !==
          'openslack.workflow_runner_budget_authority_evidence.v1'
      ) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'Budget reserve completed without its exact durable source result.',
        );
      }
      let validated: WorkflowRunnerBudgetSourceResult;
      try {
        validated = validateWorkflowRunnerBudgetSourceResult(
          result,
          entry.resolution.evidence.preparedRequest,
        );
      } catch (error) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
          'Budget reserve source result differs from the exact prepared E1 request.',
          error,
        );
      }
      await this.#journal.putBudgetSourceResult(entry.stage.bindingId, validated);
      return validated;
    }
    if (result !== undefined) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
        'Budget settle cannot return a reserve-only budget source result.',
      );
    }
    return undefined;
  }

  async #confirmAck(
    bindingId: string,
    receipt: WorkflowRunnerAuthorityControlDeliveryReceipt,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityControlDeliveryReceipt> {
    const prepared = prepareWorkflowRunnerAuthorityBindingReceipt(receipt);
    const raw = await this.#postWithPointRead(
      prepared,
      () => this.#port.acknowledgeControl(bindingId, prepared, signal),
      signal,
    );
    if (raw.phase !== 'control_delivery' || !exactEqual(raw, receipt)) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT',
        'Remote control ACK does not equal the exact durable local receipt.',
      );
    }
    await this.#journal.confirmControlReceipt(bindingId, receipt);
    return receipt;
  }

  async #postWithPointRead(
    prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
    post: () => Promise<WorkflowRunnerAuthorityBindingReceipt>,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityBindingReceipt> {
    let before: WorkflowRunnerAuthorityBindingReceipt | null;
    try {
      before = await this.#port.readReceipt(prepared.idempotencyKey, signal);
    } catch (error) {
      return fail(
        isWorkflowAuthorityConflict(error)
          ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RECONCILIATION_REQUIRED'
          : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RESPONSE_UNKNOWN',
        'Companion receipt point-read failed; POST will not be attempted.',
        error,
      );
    }
    if (before) return before;
    try {
      return await post();
    } catch (error) {
      try {
        const recovered = await this.#port.readReceipt(prepared.idempotencyKey, signal);
        if (recovered) return recovered;
      } catch (readError) {
        return fail(
          isWorkflowAuthorityConflict(readError)
            ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RECONCILIATION_REQUIRED'
            : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RESPONSE_UNKNOWN',
          'Companion POST outcome and point-read are both unknown; bytes will not be changed.',
          readError,
        );
      }
      return fail(
        isWorkflowAuthorityConflict(error)
          ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RECONCILIATION_REQUIRED'
          : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RESPONSE_UNKNOWN',
        'Companion POST response was lost and no durable receipt is point-readable.',
        error,
      );
    }
  }

  async #accepted(
    receipt: WorkflowRunnerAuthorityBindingReceipt,
    phase: 'stage' | 'resolution',
  ): Promise<void> {
    if (receipt.status !== 'accepted') {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RECONCILIATION_REQUIRED',
        `Authority-binding ${phase} requires reconciliation.`,
      );
    }
  }

  async #probeSource(
    source: WorkflowRunnerAuthoritySourceAdapter,
    stage: WorkflowRunnerAuthorityBindingStage,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthoritySourceProbe> {
    try {
      return await source.probe(stage, signal);
    } catch (error) {
      if (signal?.aborted || isWorkflowAuthorityRetryable(error))
        return {
          state: 'unknown',
          reason: 'Source evidence transport is temporarily unavailable.',
        };
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RECONCILIATION_REQUIRED',
        'Source evidence failed its identity or integrity checks.',
        error,
      );
    }
  }
}
import {
  isWorkflowAuthorityRetryable,
  isWorkflowAuthorityConflict,
} from './internal/workflow-authority-failure.js';
