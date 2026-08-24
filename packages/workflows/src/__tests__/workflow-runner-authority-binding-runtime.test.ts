import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalWorkflowControlAuthorityJson,
  parseWorkflowControlAuthorityMessageBytes,
  prepareWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityPreparedMessage,
} from '../workflow-control-authority-contract.js';
import {
  canonicalWorkflowBudgetAuthorityJson,
  hashWorkflowBudgetAuthorityValue,
  parseWorkflowBudgetAuthorityBytes,
  prepareWorkflowBudgetAuthorityRequest,
  type WorkflowBudgetSettlementRequest,
} from '../workflow-budget-authority-contract.js';
import {
  WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS,
  deriveWorkflowRunnerAuthorityBindingId,
  hashWorkflowRunnerAuthorityBindingEvidence,
  hashWorkflowRunnerAuthorityBindingReceipt,
  hashWorkflowRunnerAuthorityBindingResolution,
  hashWorkflowRunnerAuthorityBindingStage,
  prepareWorkflowRunnerAuthorityBindingReceipt,
  prepareWorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerAuthorityBindingOperation,
  type WorkflowRunnerAuthorityBindingPrepared,
  type WorkflowRunnerAuthorityBindingReceipt,
  type WorkflowRunnerAuthorityBindingResolution,
  type WorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerAuthorityControlDeliveryReceipt,
  type WorkflowRunnerAuthorityEvidence,
  type WorkflowRunnerAuthorityResolutionReceipt,
  type WorkflowRunnerAuthorityStageReceipt,
  type WorkflowRunnerBudgetSourceResult,
} from '../workflow-runner-authority-binding-contract.js';
import {
  createWorkflowRunnerAuthorityBindingClient,
  type WorkflowRunnerAuthorityBindingPort,
} from '../workflow-runner-authority-binding-client.js';
import {
  WorkflowRunnerAuthorityBindingJournal,
  WorkflowRunnerAuthorityBindingJournalError,
} from '../workflow-runner-authority-binding-journal.js';
import {
  WorkflowRunnerAuthorityBindingRuntime,
  WorkflowRunnerAuthorityBindingRuntimeError,
  type WorkflowRunnerAuthorityBindingCommitInput,
  type WorkflowRunnerAuthoritySourceAdapter,
} from '../workflow-runner-authority-binding-runtime.js';
import {
  createWorkflowRunnerBudgetAuthorityClient,
  WorkflowRunnerBudgetAuthorityClientError,
} from '../workflow-runner-budget-authority-client.js';
import {
  createWorkflowRunnerV2RuntimeAdmissionClient,
  prepareWorkflowRunnerV2RuntimeAdmission,
} from '../workflow-runner-v2-runtime-admission.js';

// Real Windows ACL hardening is intentionally subprocess-backed. Hosted runners
// and developer machines can exceed the generic 5s unit-test budget while still
// remaining within each security subprocess's closed timeout.
vi.setConfig({ testTimeout: process.platform === 'win32' ? 120_000 : 30_000 });

type ExactVector<T> = { readonly value: T; readonly canonicalBytes: string };
type Exchange = {
  readonly stage: ExactVector<WorkflowRunnerAuthorityBindingStage>;
  readonly stageReceipt: ExactVector<WorkflowRunnerAuthorityStageReceipt>;
  readonly resolution: ExactVector<WorkflowRunnerAuthorityBindingResolution>;
  readonly resolutionReceipt: ExactVector<WorkflowRunnerAuthorityResolutionReceipt>;
};
type RuntimeGolden = {
  readonly positive: {
    readonly operations: Record<WorkflowRunnerAuthorityBindingOperation, Exchange>;
    readonly semanticVariants: Record<string, Exchange>;
    readonly controlDelivery: {
      readonly messages: {
        readonly accepted: Record<
          WorkflowRunnerAuthorityBindingOperation,
          WorkflowControlAuthorityMessage
        >;
      };
      readonly accepted: Record<
        WorkflowRunnerAuthorityBindingOperation,
        ExactVector<WorkflowRunnerAuthorityControlDeliveryReceipt>
      >;
      readonly artifacts: Record<
        string,
        {
          readonly operation: WorkflowRunnerAuthorityBindingOperation;
          readonly message: WorkflowControlAuthorityMessage;
          readonly receipt: ExactVector<WorkflowRunnerAuthorityControlDeliveryReceipt>;
          readonly budgetSourceResult: WorkflowRunnerBudgetSourceResult | null;
        }
      >;
      readonly priorEventDeliveries: Record<
        string,
        {
          readonly message: WorkflowControlAuthorityMessage;
          readonly receipt: ExactVector<WorkflowRunnerAuthorityControlDeliveryReceipt>;
        }
      >;
    };
  };
};

type BudgetReconciliationFold = {
  readonly request: WorkflowBudgetSettlementRequest;
  readonly settlement: unknown;
  readonly receipt: unknown;
  readonly reconciliation: unknown;
};

type BudgetGolden = {
  readonly vectors: {
    readonly folds: Record<string, BudgetReconciliationFold>;
  };
};

const vectors = JSON.parse(
  readFileSync(
    new URL(
      '../../contracts/workflow-runner-authority-binding/v1/golden-vectors.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as RuntimeGolden;
const budgetVectors = JSON.parse(
  readFileSync(
    new URL('../../contracts/workflow-budget-authority/v1/golden-vectors.json', import.meta.url),
    'utf8',
  ),
) as BudgetGolden;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function journalRoot(): Promise<string> {
  const parent = process.platform === 'win32' ? tmpdir() : '/tmp';
  const root = await mkdtemp(join(parent, 'openslack-f2b-runtime-'));
  await chmod(root, 0o700);
  roots.push(root);
  const journal = resolve(root, 'binding-journal');
  return journal;
}

function operationVector(operation: WorkflowRunnerAuthorityBindingOperation): Exchange {
  return vectors.positive.operations[operation];
}

interface GoFixture {
  readonly operation: WorkflowRunnerAuthorityBindingOperation;
  readonly stageTemplate: WorkflowRunnerAuthorityBindingStage;
  readonly target: WorkflowControlAuthorityPreparedMessage;
  readonly evidence: WorkflowRunnerAuthorityEvidence;
  readonly resolutionSentAt: string;
}

const goFixtures = new Map<WorkflowRunnerAuthorityBindingOperation, GoFixture>();

function goFixture(operation: WorkflowRunnerAuthorityBindingOperation): GoFixture {
  const cached = goFixtures.get(operation);
  if (cached) return cached;
  const existing =
    operation === 'checkpoint_commit'
      ? vectors.positive.semanticVariants.goRouteCheckpoint
      : operation === 'budget_reserve'
        ? vectors.positive.semanticVariants.budgetReserveGoAuthority
        : undefined;
  const base = existing ?? operationVector(operation);
  const oldMessage = parseWorkflowControlAuthorityMessageBytes(
    Buffer.from(base.stage.value.target.body, 'utf8'),
  );
  const route = {
    backend: 'go' as const,
    authority: 'workflow-control' as const,
    routingEpoch: base.stage.value.route.routingEpoch,
    authorityBuildHash: base.stage.value.route.authorityBuildHash,
  };
  const target = prepareWorkflowControlAuthorityMessage({
    ...oldMessage,
    authorityBackend: route.backend,
    authority: route.authority,
  });
  let evidence = base.resolution.value.evidence;
  if (!existing && evidence.schema === 'openslack.workflow_runner_budget_authority_evidence.v1') {
    const request = parseWorkflowBudgetAuthorityBytes(
      Buffer.from(evidence.preparedRequest.body, 'utf8'),
    );
    const preparedRequest = prepareWorkflowBudgetAuthorityRequest(
      'settle',
      { ...(request as WorkflowBudgetSettlementRequest), route },
      evidence.preparedRequest.callerId,
    );
    evidence = {
      ...evidence,
      sourceAuthority: {
        ...evidence.sourceAuthority,
        requestHash: preparedRequest.requestHash,
      },
      preparedRequest,
    };
  }
  const fixture = Object.freeze({
    operation,
    stageTemplate: { ...base.stage.value, route },
    target,
    evidence,
    resolutionSentAt: base.resolution.value.sentAt,
  });
  goFixtures.set(operation, fixture);
  return fixture;
}

function targetFromStage(
  stage: WorkflowRunnerAuthorityBindingStage,
): WorkflowControlAuthorityPreparedMessage {
  return prepareWorkflowControlAuthorityMessage(
    parseWorkflowControlAuthorityMessageBytes(Buffer.from(stage.target.body, 'utf8')),
  );
}

function sameRunStaleAttemptStage(
  stage: WorkflowRunnerAuthorityBindingStage,
): WorkflowRunnerAuthorityBindingStage {
  const prior = parseWorkflowControlAuthorityMessageBytes(Buffer.from(stage.target.body, 'utf8'));
  const message = validateWorkflowControlAuthorityMessage({
    ...prior,
    attemptId: 'attempt.runtime.stale.2',
    leaseId: 'lease.runtime.stale.2',
    fencingToken: prior.fencingToken! + 1,
    eventId: 'event.runtime.stale.2',
  });
  const prepared = prepareWorkflowControlAuthorityMessage(message);
  const candidate = {
    ...stage,
    bindingId: '',
    runnerAttemptId: message.attemptId!,
    leaseId: message.leaseId!,
    fencingToken: message.fencingToken!,
    target: {
      schema: prepared.schema,
      eventId: message.eventId,
      kind: message.kind,
      sequence: message.sequence!,
      body: prepared.body,
      messageDigest: prepared.messageDigest,
      idempotencyKey: prepared.idempotencyKey,
      requestFingerprint: prepared.requestFingerprint,
    },
  };
  return prepareWorkflowRunnerAuthorityBindingStage({
    ...candidate,
    bindingId: deriveWorkflowRunnerAuthorityBindingId(candidate),
  }).value;
}

function durableBudgetRecord(
  recordKind: 'settlement' | 'receipt' | 'reconciliation',
  operationalProjection: unknown,
  authorityBuildHash: string,
) {
  const domain = recordKind === 'settlement' ? 'settlement' : recordKind;
  return {
    schema: 'openslack.workflow_control_budget_durable_record.v1',
    authority: 'workflow-control',
    writer: 'workflow-control/budget-authority-server',
    authorityMode: 'local-qualification-v1',
    productionAuthority: false,
    contractManifestSha256: WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS.budgetManifest,
    authorityBuildHash,
    recordKind,
    operationalProjection,
    operationalProjectionHash: hashWorkflowBudgetAuthorityValue(domain, operationalProjection),
  };
}

function budgetReconciliationResponse(fold: BudgetReconciliationFold): string {
  const buildHash = fold.request.route.authorityBuildHash;
  return `${canonicalWorkflowBudgetAuthorityJson({
    schema: 'openslack.workflow_control_budget_mutation_response.v1',
    operation: 'settle',
    record: durableBudgetRecord('settlement', fold.settlement, buildHash),
    receipt: durableBudgetRecord('receipt', fold.receipt, buildHash),
    reconciliation: durableBudgetRecord('reconciliation', fold.reconciliation, buildHash),
  })}\n`;
}

function inputFor(
  operation: WorkflowRunnerAuthorityBindingOperation,
  source: WorkflowRunnerAuthoritySourceAdapter,
  target = goFixture(operation).target,
): WorkflowRunnerAuthorityBindingCommitInput {
  const stage = goFixture(operation).stageTemplate;
  return {
    operation,
    lease: {
      workspaceId: stage.workspaceId,
      jobId: stage.jobId,
      runId: stage.runId,
      runnerAttemptId: stage.runnerAttemptId,
      leaseId: stage.leaseId,
      fencingToken: stage.fencingToken,
      route: stage.route,
      runnerAuthority: {
        expectedGlobalRunRevision: stage.runnerAuthority.expectedGlobalRunRevision,
        expectedResumeGeneration: stage.runnerAuthority.expectedResumeGeneration,
      },
      correlationId: stage.correlationId,
    },
    target,
    source,
  };
}

function acceptedStageReceipt(
  prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
): WorkflowRunnerAuthorityStageReceipt {
  const stage = prepared.value as WorkflowRunnerAuthorityBindingStage;
  return {
    schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
    contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
    profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
    direction: 'control-to-runner',
    phase: 'stage_event',
    companionSequence: 1,
    bindingId: stage.bindingId,
    operation: stage.operation,
    status: 'accepted',
    controlBuildHash: stage.route.authorityBuildHash,
    committedAt: stage.sentAt,
    reconciliationToken: null,
    requestHash: hashWorkflowRunnerAuthorityBindingStage(stage),
    targetEventId: stage.target.eventId,
    targetBodyHash: stage.target.messageDigest,
    evidenceHash: null,
  };
}

function acceptedResolutionReceipt(
  prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
  stage: WorkflowRunnerAuthorityBindingStage,
  stageReceipt: WorkflowRunnerAuthorityStageReceipt,
): WorkflowRunnerAuthorityResolutionReceipt {
  const resolution = prepared.value as WorkflowRunnerAuthorityBindingResolution;
  return {
    schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
    contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
    profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
    direction: 'control-to-runner',
    phase: 'commit_authority',
    companionSequence: 2,
    bindingId: resolution.bindingId,
    operation: resolution.operation,
    status: 'accepted',
    controlBuildHash: stage.route.authorityBuildHash,
    committedAt: resolution.sentAt,
    reconciliationToken: null,
    requestHash: hashWorkflowRunnerAuthorityBindingResolution(resolution),
    targetEventId: stage.target.eventId,
    targetBodyHash: stage.target.messageDigest,
    stageHash: hashWorkflowRunnerAuthorityBindingStage(stage),
    stageReceiptHash: hashWorkflowRunnerAuthorityBindingReceipt(stageReceipt),
    evidenceHash: hashWorkflowRunnerAuthorityBindingEvidence(
      resolution.evidence,
      resolution.operation,
    ),
  };
}

class ExactPort implements WorkflowRunnerAuthorityBindingPort {
  readonly receipts = new Map<string, WorkflowRunnerAuthorityBindingReceipt>();
  stageValue?: WorkflowRunnerAuthorityBindingStage;
  stageReceipt?: WorkflowRunnerAuthorityStageReceipt;
  failNextAckAfterCommit = false;
  failNextRead = false;

  async readReceipt(idempotencyKey: string): Promise<WorkflowRunnerAuthorityBindingReceipt | null> {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('point-read response lost');
    }
    return this.receipts.get(idempotencyKey) ?? null;
  }

  async stage(
    prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
  ): Promise<WorkflowRunnerAuthorityBindingReceipt> {
    this.stageValue = prepared.value as WorkflowRunnerAuthorityBindingStage;
    const frozen = Object.values(vectors.positive.operations).find(
      (candidate) => candidate.stage.value.bindingId === this.stageValue!.bindingId,
    );
    const receipt = frozen?.stageReceipt.value ?? acceptedStageReceipt(prepared);
    this.stageReceipt = receipt;
    this.receipts.set(prepared.idempotencyKey, receipt);
    return receipt;
  }

  async resolve(
    _bindingId: string,
    prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
  ): Promise<WorkflowRunnerAuthorityBindingReceipt> {
    const value = prepared.value as WorkflowRunnerAuthorityBindingResolution;
    const frozen = Object.values(vectors.positive.operations).find(
      (candidate) =>
        candidate.resolution.value.bindingId === value.bindingId &&
        canonicalWorkflowControlAuthorityJson(candidate.resolution.value) ===
          canonicalWorkflowControlAuthorityJson(value),
    );
    const receipt =
      frozen?.resolutionReceipt.value ??
      acceptedResolutionReceipt(prepared, this.stageValue!, this.stageReceipt!);
    this.receipts.set(prepared.idempotencyKey, receipt);
    return receipt;
  }

  async acknowledgeControl(
    _bindingId: string,
    prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
  ): Promise<WorkflowRunnerAuthorityBindingReceipt> {
    const receipt = prepared.value as WorkflowRunnerAuthorityBindingReceipt;
    this.receipts.set(prepared.idempotencyKey, receipt);
    if (this.failNextAckAfterCommit) {
      this.failNextAckAfterCommit = false;
      this.failNextRead = true;
      throw new Error('ACK response lost');
    }
    return receipt;
  }
}

function committedSource(
  operation: WorkflowRunnerAuthorityBindingOperation,
): WorkflowRunnerAuthoritySourceAdapter {
  const evidence = goFixture(operation).evidence;
  const budgetSourceResult =
    operation === 'budget_reserve'
      ? vectors.positive.controlDelivery.artifacts['kind:budget_authorization']!.budgetSourceResult!
      : undefined;
  return Object.freeze({
    async probe() {
      return { state: 'committed' as const, evidence };
    },
    async commit() {
      throw new Error('committed source must not be replayed');
    },
    ...(operation === 'budget_reserve' || operation === 'budget_settle'
      ? {
          async probePostResolution() {
            return {
              state: 'committed' as const,
              ...(budgetSourceResult === undefined ? {} : { budgetSourceResult }),
            };
          },
          async commitPostResolution() {
            throw new Error('committed budget source must not be replayed');
          },
        }
      : {}),
  });
}

function unknownSource(): WorkflowRunnerAuthoritySourceAdapter {
  return Object.freeze({
    async probe() {
      return { state: 'unknown' as const, reason: 'source point-read unavailable' };
    },
    async commit() {
      throw new Error('unknown source must not be mutated');
    },
  });
}

function changedTarget(operation: WorkflowRunnerAuthorityBindingOperation) {
  const original = parseWorkflowControlAuthorityMessageBytes(
    Buffer.from(goFixture(operation).target.body, 'utf8'),
  );
  return prepareWorkflowControlAuthorityMessage({
    ...original,
    eventId: `${original.eventId}.later`,
  });
}

function acceptedEventReceipt(
  context: { readonly stage: WorkflowRunnerAuthorityBindingStage },
  sentAt = '2026-08-20T00:40:00.000Z',
): WorkflowControlAuthorityMessage {
  const target = parseWorkflowControlAuthorityMessageBytes(
    Buffer.from(context.stage.target.body, 'utf8'),
  );
  return validateWorkflowControlAuthorityMessage({
    ...target,
    kind: 'event_receipt',
    sequence: target.sequence! + 1,
    runRevision: context.stage.runnerAuthority.acceptedGlobalRunRevision,
    resumeGeneration: context.stage.runnerAuthority.acceptedResumeGeneration,
    eventId: `${target.eventId}.receipt`,
    sentAt,
    payload: {
      receivedEventId: target.eventId,
      receivedKind: target.kind,
      receivedSequence: target.sequence,
      receivedDigest: context.stage.target.messageDigest,
      receivedIdempotencyKey: context.stage.target.idempotencyKey,
      receivedFingerprint: context.stage.target.requestFingerprint,
      status: 'accepted',
      committedAt: sentAt,
      errorCode: null,
      controlBuildHash: context.stage.route.authorityBuildHash,
    },
  });
}

function plusSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1_000).toISOString();
}

function eventTime(operation: WorkflowRunnerAuthorityBindingOperation): string {
  return operation === 'checkpoint_commit'
    ? '2026-08-20T00:40:00.000Z'
    : '2026-08-20T00:07:00.000Z';
}

function optionalDecision(
  context: {
    readonly stage: WorkflowRunnerAuthorityBindingStage;
    readonly resolution: WorkflowRunnerAuthorityBindingResolution;
    readonly resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt;
  },
  eventReceipt: WorkflowControlAuthorityMessage,
): WorkflowControlAuthorityMessage | null {
  const common = {
    ...eventReceipt,
    sequence: eventReceipt.sequence! + 1,
    eventId: `${eventReceipt.eventId}.decision`,
    sentAt: plusSeconds(eventReceipt.sentAt, 2),
  };
  const evidence = context.resolution.evidence;
  if (evidence.schema === 'openslack.workflow_runner_effect_authority_evidence.v1') {
    return validateWorkflowControlAuthorityMessage({
      ...common,
      kind: 'effect_authorization',
      payload: {
        effectId: evidence.effectId,
        effectHash: evidence.effectHash,
        approvalId: evidence.approvalId,
        approvalStatus: evidence.approvalStatus,
        decisionRevision: evidence.decisionRevision,
        grantHash: evidence.grantHash,
        authorityReceiptHash: hashWorkflowRunnerAuthorityBindingReceipt(context.resolutionReceipt),
        expiresAt: evidence.expiresAt,
      },
    });
  }
  if (evidence.schema === 'openslack.workflow_runner_resume_authority_evidence.v1') {
    return validateWorkflowControlAuthorityMessage({
      ...common,
      kind: 'resume_offer',
      runRevision: context.stage.runnerAuthority.expectedGlobalRunRevision,
      resumeGeneration: context.stage.runnerAuthority.expectedResumeGeneration,
      payload: {
        checkpointId: evidence.priorCheckpointId,
        checkpointHash: evidence.priorCheckpointHash,
        nextPhaseId: evidence.nextPhaseId,
        nextPhaseIndex: evidence.nextPhaseIndex,
        newResumeGeneration: context.stage.runnerAuthority.acceptedResumeGeneration,
        newAttemptId: evidence.logicalResumeAttemptId,
        authorityReceiptHash: hashWorkflowRunnerAuthorityBindingReceipt(context.resolutionReceipt),
        expiresAt: evidence.expiresAt,
      },
    });
  }
  return null;
}

function cancelAfter(
  eventReceipt: WorkflowControlAuthorityMessage,
): WorkflowControlAuthorityMessage {
  return validateWorkflowControlAuthorityMessage({
    ...eventReceipt,
    kind: 'cancel_request',
    sequence: eventReceipt.sequence! + 1,
    eventId: `${eventReceipt.eventId}.cancel`,
    sentAt: '2026-08-20T00:07:02.000Z',
    payload: {
      cancelId: 'cancel.runtime.1',
      requestedAt: '2026-08-20T00:07:02.000Z',
      expiresAt: '2026-08-20T00:08:02.000Z',
      reason: 'operator',
    },
  });
}

describe('Workflow runner F2b runtime delivery', () => {
  it('enforces the complete six-operation revision and generation matrix on the Go route', async () => {
    const expected = {
      checkpoint_commit: { revision: 1, generation: 0 },
      effect_authorize: { revision: 1, generation: 0 },
      effect_complete: { revision: 0, generation: 0 },
      budget_reserve: { revision: 1, generation: 0 },
      budget_settle: { revision: 1, generation: 0 },
      resume_advance: { revision: 1, generation: 1 },
    } as const;
    for (const operation of Object.keys(expected) as WorkflowRunnerAuthorityBindingOperation[]) {
      const root = await journalRoot();
      const port = new ExactPort();
      let now = goFixture(operation).resolutionSentAt;
      let sourceCommits = 0;
      const evidence = goFixture(operation).evidence;
      const source: WorkflowRunnerAuthoritySourceAdapter = {
        async probe() {
          return { state: 'committed' as const, evidence };
        },
        async commit() {
          sourceCommits += 1;
          throw new Error('replayed source mutation');
        },
        ...(operation === 'budget_reserve' || operation === 'budget_settle'
          ? {
              async probePostResolution() {
                const result =
                  operation === 'budget_reserve'
                    ? vectors.positive.controlDelivery.artifacts['kind:budget_authorization']!
                        .budgetSourceResult!
                    : undefined;
                return {
                  state: 'committed' as const,
                  ...(result === undefined ? {} : { budgetSourceResult: result }),
                };
              },
              async commitPostResolution() {
                sourceCommits += 1;
                throw new Error('replayed post-resolution budget mutation');
              },
            }
          : {}),
      };
      const runtime = new WorkflowRunnerAuthorityBindingRuntime({
        journal: new WorkflowRunnerAuthorityBindingJournal(root),
        port,
        now: () => now,
      });
      await runtime.initialize();
      const context = await runtime.commit(inputFor(operation, source));
      expect(context.stage.route).toMatchObject({ backend: 'go', authority: 'workflow-control' });
      expect({
        revision:
          context.stage.runnerAuthority.acceptedGlobalRunRevision -
          context.stage.runnerAuthority.expectedGlobalRunRevision,
        generation:
          context.stage.runnerAuthority.acceptedResumeGeneration -
          context.stage.runnerAuthority.expectedResumeGeneration,
      }).toEqual(expected[operation]);
      expect(context.exactEventBytes).toBe(context.stage.target.body);
      expect(sourceCommits).toBe(0);

      const eventReceipt =
        operation === 'budget_reserve'
          ? vectors.positive.controlDelivery.priorEventDeliveries[
              'budget-authorization-event-receipt'
            ]!.message
          : acceptedEventReceipt(context, eventTime(operation));
      now = plusSeconds(eventReceipt.sentAt, 1);
      await runtime.acknowledgeControl({
        bindingId: context.stage.bindingId,
        message: eventReceipt,
      });
      if (operation === 'budget_reserve') {
        const decision = vectors.positive.controlDelivery.artifacts['kind:budget_authorization']!;
        now = decision.receipt.value.committedAt!;
        await runtime.acknowledgeControl({
          bindingId: context.stage.bindingId,
          message: decision.message,
        });
      } else {
        const decision = optionalDecision(context, eventReceipt);
        if (decision) {
          now = plusSeconds(decision.sentAt, 1);
          await runtime.acknowledgeControl({
            bindingId: context.stage.bindingId,
            message: decision,
          });
        }
      }
      expect(await runtime.outstandingForAttempt(context.stage.runnerAttemptId)).toHaveLength(0);

      if (operation === 'effect_complete') {
        expect(context.resolution.evidence).toMatchObject({
          schema: 'openslack.workflow_runner_effect_completion_evidence.v1',
          status: 'executed',
        });
      }
      if (operation === 'budget_settle') {
        const budget = context.resolution.evidence;
        if (budget.schema !== 'openslack.workflow_runner_budget_authority_evidence.v1') {
          throw new Error('budget settlement evidence unavailable');
        }
        const request = parseWorkflowBudgetAuthorityBytes(
          Buffer.from(budget.preparedRequest.body, 'utf8'),
        ) as Record<string, unknown>;
        expect(request).toMatchObject({
          route: { backend: 'go', authority: 'workflow-control' },
          expectedProviderHash: budget.providerHash,
          expectedModelHash: budget.modelHash,
          expectedProviderRunHash: budget.providerRunHash,
          providerAttempt: budget.providerAttempt,
        });
      }
      if (operation === 'resume_advance') {
        expect(context.stage.runnerAuthority).toMatchObject({
          expectedResumeGeneration: 0,
          acceptedResumeGeneration: 1,
        });
      }
    }
  });

  it('rejects the old TS-local route before staging F2b bytes', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    const runtime = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
    });
    await runtime.initialize();
    const oldStage = operationVector('checkpoint_commit').stage.value;
    await expect(
      runtime.commit({
        ...inputFor('checkpoint_commit', committedSource('checkpoint_commit')),
        lease: {
          ...inputFor('checkpoint_commit', committedSource('checkpoint_commit')).lease,
          route: oldStage.route,
        },
        target: targetFromStage(oldStage),
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_INPUT_INVALID' });
    expect(port.receipts.size).toBe(0);
  });

  it('blocks a new attempt for the same run when an old-attempt partial binding exists', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    const first = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('checkpoint_commit').resolutionSentAt,
    });
    await first.initialize();
    await expect(
      first.commit(inputFor('checkpoint_commit', unknownSource())),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
    });

    const restarted = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('checkpoint_commit').resolutionSentAt,
    });
    await restarted.initialize();
    const laterInput = inputFor(
      'checkpoint_commit',
      committedSource('checkpoint_commit'),
      changedTarget('checkpoint_commit'),
    );
    const laterMessage = parseWorkflowControlAuthorityMessageBytes(
      Buffer.from(laterInput.target.body, 'utf8'),
    );
    await expect(
      restarted.commit({
        ...laterInput,
        target: prepareWorkflowControlAuthorityMessage({
          ...laterMessage,
          attemptId: 'attempt.runtime.new',
        }),
        lease: { ...laterInput.lease, runnerAttemptId: 'attempt.runtime.new' },
      }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
    });
    expect(
      await restarted.outstandingForAttempt(
        goFixture('checkpoint_commit').stageTemplate.runnerAttemptId,
      ),
    ).toHaveLength(1);
  });

  it('allows distinct workflow runs to stage independently in a shared workspace journal', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    const runtime = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('checkpoint_commit').resolutionSentAt,
    });
    await runtime.initialize();
    await expect(
      runtime.commit(inputFor('checkpoint_commit', unknownSource())),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN' });

    const secondTargetMessage = parseWorkflowControlAuthorityMessageBytes(
      Buffer.from(goFixture('checkpoint_commit').target.body, 'utf8'),
    );
    const secondTarget = prepareWorkflowControlAuthorityMessage({
      ...secondTargetMessage,
      workflowRunId: 'run.runtime.concurrent.2',
      attemptId: 'attempt.runtime.concurrent.2',
      eventId: 'event.runtime.concurrent.2',
    });
    const secondInput = inputFor('checkpoint_commit', unknownSource(), secondTarget);
    await expect(
      runtime.commit({
        ...secondInput,
        lease: {
          ...secondInput.lease,
          runId: 'run.runtime.concurrent.2',
          runnerAttemptId: 'attempt.runtime.concurrent.2',
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN' });
    expect(
      await runtime.outstandingForRun(goFixture('checkpoint_commit').stageTemplate.runId),
    ).toHaveLength(1);
    expect(await runtime.outstandingForRun('run.runtime.concurrent.2')).toHaveLength(1);

    const recovery = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('checkpoint_commit').resolutionSentAt,
    });
    await recovery.initialize({ allowOutstandingForRecovery: true });
    const [firstRun] = await recovery.outstandingForRun(
      goFixture('checkpoint_commit').stageTemplate.runId,
    );
    port.stageValue = firstRun!.stage;
    port.stageReceipt = firstRun!.stageReceipt!;
    await expect(
      recovery.recover(firstRun!.stage.bindingId, committedSource('checkpoint_commit')),
    ).resolves.toMatchObject({ exactEventBytes: goFixture('checkpoint_commit').target.body });
    expect(await recovery.outstandingForRun('run.runtime.concurrent.2')).toHaveLength(1);
  });

  it('blocks recovery of either stale binding when one run has two attempts', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    const first = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('checkpoint_commit').resolutionSentAt,
    });
    await first.initialize();
    await expect(
      first.commit(inputFor('checkpoint_commit', unknownSource())),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
    });
    const journal = new WorkflowRunnerAuthorityBindingJournal(root);
    await journal.initialize();
    const [original] = await journal.list();
    const stale = sameRunStaleAttemptStage(original!.stage);
    await journal.putStage(stale);

    let probes = 0;
    let mutations = 0;
    const source: WorkflowRunnerAuthoritySourceAdapter = {
      async probe() {
        probes += 1;
        return { state: 'not_committed' as const };
      },
      async commit() {
        mutations += 1;
        return goFixture('checkpoint_commit').evidence;
      },
    };
    const recovery = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('checkpoint_commit').resolutionSentAt,
    });
    await recovery.initialize({ allowOutstandingForRecovery: true });
    for (const bindingId of [original!.stage.bindingId, stale.bindingId]) {
      await expect(recovery.recover(bindingId, source)).rejects.toMatchObject({
        code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
      });
    }
    expect({ probes, mutations }).toEqual({ probes: 0, mutations: 0 });
  });

  it('blocks control ACK when one run has a stale foreign-attempt binding', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    const runtime = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => '2026-08-20T00:40:01.000Z',
    });
    await runtime.initialize();
    const context = await runtime.commit(
      inputFor('checkpoint_commit', committedSource('checkpoint_commit')),
    );
    const journal = new WorkflowRunnerAuthorityBindingJournal(root);
    await journal.initialize();
    await journal.putStage(sameRunStaleAttemptStage(context.stage));
    const companionPosts = port.receipts.size;
    await expect(
      runtime.acknowledgeControl({
        bindingId: context.stage.bindingId,
        message: acceptedEventReceipt(context),
      }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING',
    });
    expect((await journal.read(context.stage.bindingId))!.controlDeliveries).toHaveLength(0);
    expect(port.receipts.size).toBe(companionPosts);
  });

  it('recovers a lost source response without replaying the source mutation', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    const evidence = goFixture('effect_authorize').evidence;
    let committed = false;
    let commitCalls = 0;
    let exposeCommit = false;
    const source: WorkflowRunnerAuthoritySourceAdapter = {
      async probe() {
        return committed && exposeCommit
          ? { state: 'committed' as const, evidence }
          : committed
            ? { state: 'unknown' as const, reason: 'claim response and point-read lost' }
            : { state: 'not_committed' as const };
      },
      async commit() {
        commitCalls += 1;
        committed = true;
        throw new Error('claim committed and response lost');
      },
    };
    const first = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('effect_authorize').resolutionSentAt,
    });
    await first.initialize();
    await expect(first.commit(inputFor('effect_authorize', source))).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
    });
    expect(commitCalls).toBe(1);

    exposeCommit = true;
    const restarted = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('effect_authorize').resolutionSentAt,
    });
    await restarted.initialize({ allowOutstandingForRecovery: true });
    const [outstanding] = await restarted.outstandingForAttempt(
      goFixture('effect_authorize').stageTemplate.runnerAttemptId,
    );
    const recovered = await restarted.recover(outstanding!.stage.bindingId, source);
    expect(recovered.exactEventBytes).toBe(goFixture('effect_authorize').target.body);
    expect(commitCalls).toBe(1);
  });

  it('does not let another ACK clear an unconfirmed control delivery', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    let now = goFixture('checkpoint_commit').resolutionSentAt;
    const runtime = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => now,
    });
    await runtime.initialize();
    const context = await runtime.commit(
      inputFor('checkpoint_commit', committedSource('checkpoint_commit')),
    );
    const eventReceipt = acceptedEventReceipt(context);
    now = '2026-08-20T00:40:01.000Z';
    port.failNextAckAfterCommit = true;
    await expect(
      runtime.acknowledgeControl({ bindingId: context.stage.bindingId, message: eventReceipt }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RESPONSE_UNKNOWN' });
    await expect(
      runtime.acknowledgeControl({
        bindingId: context.stage.bindingId,
        message: cancelAfter(eventReceipt),
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING' });

    const restarted = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => now,
    });
    await restarted.initialize({ allowOutstandingForRecovery: true });
    await expect(
      restarted.acknowledgeControl({ bindingId: context.stage.bindingId, message: eventReceipt }),
    ).resolves.toMatchObject({ controlKind: 'event_receipt', companionSequence: 3 });
  });

  it('persists exact budgetSourceResult before event delivery and reuses it for decision ACK', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    let now = goFixture('budget_reserve').resolutionSentAt;
    const runtime = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => now,
    });
    await runtime.initialize();
    const context = await runtime.commit(
      inputFor('budget_reserve', committedSource('budget_reserve')),
    );
    const eventReceipt =
      vectors.positive.controlDelivery.priorEventDeliveries['budget-authorization-event-receipt']!
        .message;
    now = vectors.positive.controlDelivery.accepted.budget_reserve.value.committedAt!;
    await runtime.acknowledgeControl({ bindingId: context.stage.bindingId, message: eventReceipt });
    const decision = vectors.positive.controlDelivery.artifacts['kind:budget_authorization']!;
    now = decision.receipt.value.committedAt!;
    expect(context.budgetSourceResult).toEqual(decision.budgetSourceResult);
    await expect(
      runtime.acknowledgeControl({ bindingId: context.stage.bindingId, message: decision.message }),
    ).resolves.toMatchObject({ controlKind: 'budget_authorization', companionSequence: 4 });

    const restarted = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => now,
    });
    await restarted.initialize();
    expect(await restarted.outstandingForAttempt(context.stage.runnerAttemptId)).toHaveLength(0);
  });

  it('recovers a lost budget settlement response without replaying E2', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    const evidence = goFixture('budget_settle').evidence;
    let settled = false;
    let pointReadable = false;
    let settlementCalls = 0;
    const source: WorkflowRunnerAuthoritySourceAdapter = {
      async probe() {
        return { state: 'committed' as const, evidence };
      },
      async commit() {
        throw new Error('prepared settlement evidence must not be replayed');
      },
      async probePostResolution() {
        if (!settled) return { state: 'not_committed' as const };
        return pointReadable
          ? { state: 'committed' as const }
          : { state: 'unknown' as const, reason: 'settlement response and point-read lost' };
      },
      async commitPostResolution() {
        settlementCalls += 1;
        settled = true;
        throw new Error('settlement committed and response lost');
      },
    };
    const first = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('budget_settle').resolutionSentAt,
    });
    await first.initialize();
    await expect(first.commit(inputFor('budget_settle', source))).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
    });
    expect(settlementCalls).toBe(1);

    pointReadable = true;
    const restarted = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('budget_settle').resolutionSentAt,
    });
    await restarted.initialize({ allowOutstandingForRecovery: true });
    const [outstanding] = await restarted.outstandingForAttempt(
      goFixture('budget_settle').stageTemplate.runnerAttemptId,
    );
    await expect(restarted.recover(outstanding!.stage.bindingId, source)).resolves.toMatchObject({
      exactEventBytes: goFixture('budget_settle').target.body,
    });
    expect(settlementCalls).toBe(1);
  });

  it('keeps a reconciled E2 settlement staged with zero event ACK and no source replay', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    let pointReads = 0;
    let mutations = 0;
    const reconciliation = () =>
      new WorkflowRunnerBudgetAuthorityClientError(
        'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
        'E2 settlement requires provider reconciliation.',
      );
    const source: WorkflowRunnerAuthoritySourceAdapter = {
      async probe() {
        return { state: 'committed' as const, evidence: goFixture('budget_settle').evidence };
      },
      async commit() {
        throw new Error('prepared E1 evidence is read-only');
      },
      async probePostResolution() {
        pointReads += 1;
        if (pointReads === 1) return { state: 'not_committed' as const };
        throw reconciliation();
      },
      async commitPostResolution() {
        mutations += 1;
        throw reconciliation();
      },
    };
    const runtime = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('budget_settle').resolutionSentAt,
    });
    await runtime.initialize();
    await expect(runtime.commit(inputFor('budget_settle', source))).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
    });
    expect({ pointReads, mutations, companionPosts: port.receipts.size }).toEqual({
      pointReads: 2,
      mutations: 1,
      companionPosts: 2,
    });
    const [outstanding] = await runtime.outstandingForAttempt(
      goFixture('budget_settle').stageTemplate.runnerAttemptId,
    );
    expect(outstanding?.controlDeliveries).toHaveLength(0);

    const restarted = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('budget_settle').resolutionSentAt,
    });
    await restarted.initialize({ allowOutstandingForRecovery: true });
    await expect(restarted.recover(outstanding!.stage.bindingId, source)).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
    });
    expect({ mutations, companionPosts: port.receipts.size }).toEqual({
      mutations: 1,
      companionPosts: 2,
    });
  });

  it('rejects a durable reconciliation stage receipt before any source mutation', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    const first = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('checkpoint_commit').resolutionSentAt,
    });
    await first.initialize();
    await expect(
      first.commit(inputFor('checkpoint_commit', unknownSource())),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
    });
    const journal = new WorkflowRunnerAuthorityBindingJournal(root);
    await journal.initialize();
    const [entry] = await journal.list();
    const rejected: WorkflowRunnerAuthorityStageReceipt = {
      ...entry!.stageReceipt!,
      status: 'reconciliation_required',
      committedAt: null,
      reconciliationToken: 'reconciliation.runtime.stage',
    };
    const bindingDirectory = (await readdir(join(root, 'bindings')))[0]!;
    const receiptPath = join(root, 'bindings', bindingDirectory, 'stage-receipt.json');
    await writeFile(receiptPath, `${canonicalWorkflowControlAuthorityJson(rejected)}\n`, 'utf8');
    await chmod(receiptPath, 0o600);

    let probes = 0;
    let mutations = 0;
    const source: WorkflowRunnerAuthoritySourceAdapter = {
      async probe() {
        probes += 1;
        return { state: 'not_committed' as const };
      },
      async commit() {
        mutations += 1;
        return goFixture('checkpoint_commit').evidence;
      },
    };
    const restarted = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('checkpoint_commit').resolutionSentAt,
    });
    await restarted.initialize({ allowOutstandingForRecovery: true });
    await expect(restarted.recover(entry!.stage.bindingId, source)).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RECONCILIATION_REQUIRED',
    });
    expect({ probes, mutations }).toEqual({ probes: 0, mutations: 0 });
  });

  it('rejects a durable reconciliation resolution receipt before budget E2 mutation', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    const initialSource: WorkflowRunnerAuthoritySourceAdapter = {
      async probe() {
        return {
          state: 'committed' as const,
          evidence: goFixture('budget_reserve').evidence,
        };
      },
      async commit() {
        throw new Error('Prepared E1 evidence is already committed.');
      },
      async probePostResolution() {
        return { state: 'unknown' as const, reason: 'E2 unavailable before injection' };
      },
      async commitPostResolution() {
        throw new Error('Unknown E2 must not be mutated.');
      },
    };
    const first = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('budget_reserve').resolutionSentAt,
    });
    await first.initialize();
    await expect(first.commit(inputFor('budget_reserve', initialSource))).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
    });
    const journal = new WorkflowRunnerAuthorityBindingJournal(root);
    await journal.initialize();
    const [entry] = await journal.list();
    const rejected: WorkflowRunnerAuthorityResolutionReceipt = {
      ...entry!.resolutionReceipt!,
      status: 'reconciliation_required',
      committedAt: null,
      reconciliationToken: 'reconciliation.runtime.resolution',
    };
    const bindingDirectory = (await readdir(join(root, 'bindings')))[0]!;
    const receiptPath = join(root, 'bindings', bindingDirectory, 'resolution-receipt.json');
    await writeFile(receiptPath, `${canonicalWorkflowControlAuthorityJson(rejected)}\n`, 'utf8');
    await chmod(receiptPath, 0o600);

    let postResolutionProbes = 0;
    let postResolutionMutations = 0;
    const recoverySource: WorkflowRunnerAuthoritySourceAdapter = {
      async probe() {
        throw new Error('Durable E1 evidence must not be reprobed.');
      },
      async commit() {
        throw new Error('Durable E1 evidence must not be replayed.');
      },
      async probePostResolution() {
        postResolutionProbes += 1;
        return { state: 'not_committed' as const };
      },
      async commitPostResolution() {
        postResolutionMutations += 1;
        return vectors.positive.controlDelivery.artifacts['kind:budget_authorization']!
          .budgetSourceResult!;
      },
    };
    const restarted = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => goFixture('budget_reserve').resolutionSentAt,
    });
    await restarted.initialize({ allowOutstandingForRecovery: true });
    await expect(restarted.recover(entry!.stage.bindingId, recoverySource)).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RECONCILIATION_REQUIRED',
    });
    expect({ postResolutionProbes, postResolutionMutations }).toEqual({
      postResolutionProbes: 0,
      postResolutionMutations: 0,
    });
  });

  it('rejects canonical cross-splices and unsafe journal entries on restart', async () => {
    const crossRoot = await journalRoot();
    const port = new ExactPort();
    const runtime = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(crossRoot),
      port,
      now: () => goFixture('checkpoint_commit').resolutionSentAt,
    });
    await runtime.initialize();
    await expect(
      runtime.commit(inputFor('checkpoint_commit', unknownSource())),
    ).rejects.toBeInstanceOf(WorkflowRunnerAuthorityBindingRuntimeError);
    const bindingDirectory = (await readdir(join(crossRoot, 'bindings')))[0]!;
    const spliced = operationVector('effect_complete').stageReceipt.canonicalBytes;
    await writeFile(
      join(crossRoot, 'bindings', bindingDirectory, 'stage-receipt.json'),
      spliced,
      'utf8',
    );
    await chmod(join(crossRoot, 'bindings', bindingDirectory, 'stage-receipt.json'), 0o600);
    await expect(
      new WorkflowRunnerAuthorityBindingJournal(crossRoot).list(),
    ).rejects.toBeInstanceOf(WorkflowRunnerAuthorityBindingJournalError);

    const unsafeRoot = await journalRoot();
    const unsafe = new WorkflowRunnerAuthorityBindingJournal(unsafeRoot);
    await unsafe.initialize();
    if (process.platform === 'win32') {
      await writeFile(join(unsafeRoot, 'bindings', 'a'.repeat(64)), 'unsafe', 'utf8');
    } else {
      await symlink(unsafeRoot, join(unsafeRoot, 'bindings', 'a'.repeat(64)));
    }
    await expect(unsafe.list()).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_PATH_UNSAFE',
    });
  });

  it('closed binding rejects later companion', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    let now = goFixture('checkpoint_commit').resolutionSentAt;
    const runtime = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => now,
    });
    await runtime.initialize();
    const context = await runtime.commit(
      inputFor('checkpoint_commit', committedSource('checkpoint_commit')),
    );
    const eventReceipt = acceptedEventReceipt(context);
    now = '2026-08-20T00:40:01.000Z';
    await runtime.acknowledgeControl({ bindingId: context.stage.bindingId, message: eventReceipt });
    now = '2026-08-20T00:07:03.000Z';
    await expect(
      runtime.acknowledgeControl({
        bindingId: context.stage.bindingId,
        message: cancelAfter(eventReceipt),
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_CONFLICT' });
  });

  it('foreign outstanding binding blocks old-binding cancel ACK', async () => {
    const root = await journalRoot();
    const port = new ExactPort();
    let now = goFixture('checkpoint_commit').resolutionSentAt;
    const runtime = new WorkflowRunnerAuthorityBindingRuntime({
      journal: new WorkflowRunnerAuthorityBindingJournal(root),
      port,
      now: () => now,
    });
    await runtime.initialize();
    const first = await runtime.commit(
      inputFor('checkpoint_commit', committedSource('checkpoint_commit')),
    );
    const eventReceipt = acceptedEventReceipt(first);
    now = '2026-08-20T00:40:01.000Z';
    await runtime.acknowledgeControl({ bindingId: first.stage.bindingId, message: eventReceipt });
    await expect(
      runtime.commit(
        inputFor('checkpoint_commit', unknownSource(), changedTarget('checkpoint_commit')),
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN' });
    now = '2026-08-20T00:07:03.000Z';
    await expect(
      runtime.acknowledgeControl({
        bindingId: first.stage.bindingId,
        message: cancelAfter(eventReceipt),
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_OUTSTANDING' });
  });
});

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function reply(response: ServerResponse, exactBytes: string, status = 200): void {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(exactBytes, 'utf8')),
  });
  response.end(exactBytes);
}

it('parses an exact 202 reconciliation receipt instead of discarding its body', async () => {
  const vector = operationVector('checkpoint_commit');
  const reconciliation = prepareWorkflowRunnerAuthorityBindingReceipt(
    vectors.positive.semanticVariants.effectCompleteReconciliation.resolutionReceipt.value,
  );
  const server = createServer((_request, response) => {
    reply(response, reconciliation.body, 202);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const client = createWorkflowRunnerAuthorityBindingClient({
      origin: `http://127.0.0.1:${address.port}`,
      workspaceId: vector.stage.value.workspaceId,
      bearerToken: 't'.repeat(32),
    });
    await expect(
      client.stage(prepareWorkflowRunnerAuthorityBindingStage(vector.stage.value)),
    ).resolves.toEqual(reconciliation.value);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
});

it('uses an HTTP companion seam to seal headers and point-read a lost POST response', async () => {
  const vector = operationVector('checkpoint_commit');
  const stored = new Map<string, string>();
  const observed: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];
  let losePostResponse = true;
  const server = createServer(async (request, response) => {
    const requestBody = request.method === 'POST' ? await body(request) : '';
    observed.push({ url: request.url ?? '', headers: request.headers, body: requestBody });
    if (request.method === 'POST') {
      stored.set(String(request.headers['idempotency-key']), vector.stageReceipt.canonicalBytes);
      if (losePostResponse) {
        losePostResponse = false;
        request.socket.destroy();
        return;
      }
    }
    const key = decodeURIComponent((request.url ?? '').split('/').at(-1) ?? '');
    const exact = stored.get(key);
    if (!exact) {
      response.writeHead(404, { 'Content-Length': '0' });
      response.end();
      return;
    }
    reply(response, exact);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const client = createWorkflowRunnerAuthorityBindingClient({
      origin: `http://127.0.0.1:${address.port}`,
      workspaceId: vector.stage.value.workspaceId,
      bearerToken: 't'.repeat(32),
    });
    const prepared = {
      ...vector.stage.value,
    };
    const exactPrepared = prepareWorkflowRunnerAuthorityBindingStage(prepared);
    await expect(client.stage(exactPrepared)).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_TRANSPORT_FAILED',
    });
    await expect(client.readReceipt(exactPrepared.idempotencyKey)).resolves.toEqual(
      vector.stageReceipt.value,
    );
    expect(observed[0]).toMatchObject({
      url: '/v2/runner/authority-bindings:stage',
      body: vector.stage.canonicalBytes,
    });
    expect(observed[0]!.headers).toMatchObject({
      authorization: `Bearer ${'t'.repeat(32)}`,
      'x-openslack-workspace-id': vector.stage.value.workspaceId,
      'idempotency-key': exactPrepared.idempotencyKey,
      'x-openslack-request-fingerprint': exactPrepared.requestFingerprint,
    });
    expect(observed[1]!.url).toBe(
      `/v2/runner/authority-bindings/receipts/${encodeURIComponent(exactPrepared.idempotencyKey)}`,
    );
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
});

it('validates the exact E2 reserve response and reconstructs its private ledger entry', async () => {
  const fixture = goFixture('budget_reserve');
  if (fixture.evidence.schema !== 'openslack.workflow_runner_budget_authority_evidence.v1') {
    throw new Error('budget evidence unavailable');
  }
  const sourceResult =
    vectors.positive.controlDelivery.artifacts['kind:budget_authorization']!.budgetSourceResult!;
  const buildHash = fixture.stageTemplate.route.authorityBuildHash;
  const responseBody = `${canonicalWorkflowBudgetAuthorityJson({
    schema: 'openslack.workflow_control_budget_mutation_response.v1',
    operation: 'reserve',
    record: {
      schema: 'openslack.workflow_control_budget_durable_record.v1',
      authority: 'workflow-control',
      writer: 'workflow-control/budget-authority-server',
      authorityMode: 'local-qualification-v1',
      productionAuthority: false,
      contractManifestSha256: WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS.budgetManifest,
      authorityBuildHash: buildHash,
      recordKind: 'reserve_decision',
      operationalProjection: sourceResult.decision,
      operationalProjectionHash: hashWorkflowBudgetAuthorityValue(
        'reserve-decision',
        sourceResult.decision,
      ),
    },
    receipt: JSON.parse(sourceResult.durableReceiptBytes),
    reconciliation: null,
  })}\n`;
  const divergentAccount = {
    ...sourceResult.decision.afterAccount,
    accountRevision: 2,
    runRevision: 5,
  };
  const accountBody = `${canonicalWorkflowBudgetAuthorityJson({
    schema: 'openslack.workflow_control_budget_durable_record.v1',
    authority: 'workflow-control',
    writer: 'workflow-control/budget-authority-server',
    authorityMode: 'local-qualification-v1',
    productionAuthority: false,
    contractManifestSha256: WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS.budgetManifest,
    authorityBuildHash: buildHash,
    recordKind: 'account',
    operationalProjection: divergentAccount,
    operationalProjectionHash: hashWorkflowBudgetAuthorityValue('account', divergentAccount),
  })}\n`;
  const observed: Array<{ headers: IncomingMessage['headers']; body: string }> = [];
  const server = createServer(async (request, response) => {
    observed.push({
      headers: request.headers,
      body: request.method === 'POST' ? await body(request) : '',
    });
    reply(
      response,
      request.url?.endsWith('/account') ? accountBody : responseBody,
      request.method === 'POST' ? 201 : 200,
    );
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const client = createWorkflowRunnerBudgetAuthorityClient({
      origin: `http://127.0.0.1:${address.port}`,
      workspaceId: fixture.stageTemplate.workspaceId,
      bearerToken: 'b'.repeat(32),
      callerId: fixture.evidence.preparedRequest.callerId,
    });
    await expect(client.mutate(fixture.evidence.preparedRequest)).resolves.toMatchObject({
      sourceResult,
    });
    await expect(client.pointRead(fixture.evidence.preparedRequest)).resolves.toMatchObject({
      sourceResult,
    });
    await expect(
      client.readAccount(fixture.stageTemplate.runId, fixture.stageTemplate.route),
    ).resolves.toMatchObject({ accountRevision: 2, runRevision: 5 });
    expect(observed[0]).toMatchObject({ body: fixture.evidence.preparedRequest.body });
    expect(observed[0]!.headers).toMatchObject({
      authorization: `Bearer ${'b'.repeat(32)}`,
      'x-openslack-workflow-budget-caller-id': fixture.evidence.preparedRequest.callerId,
      'x-openslack-workflow-budget-workspace-id': fixture.stageTemplate.workspaceId,
      'x-openslack-workflow-budget-routing-epoch': String(fixture.stageTemplate.route.routingEpoch),
      'x-openslack-workflow-budget-expected-build-sha': buildHash,
      'idempotency-key': fixture.evidence.preparedRequest.idempotencyKey,
      'x-openslack-request-fingerprint': fixture.evidence.preparedRequest.requestFingerprint,
    });
    expect(observed[2]!.headers).toMatchObject({
      'x-openslack-workflow-budget-caller-id': fixture.evidence.preparedRequest.callerId,
      'x-openslack-workflow-budget-workspace-id': fixture.stageTemplate.workspaceId,
    });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
});

it.each([
  ['provider outcome unknown', 'providerOutcomeUnknown'],
  ['usage missing', 'usageMissing'],
  ['usage over reservation', 'usageOverrun'],
] as const)(
  'rejects known E2 settlement reconciliation from mutation and point-read: %s',
  async (_caseName, foldName) => {
    const fold = budgetVectors.vectors.folds[foldName];
    if (!fold) throw new Error(`missing budget reconciliation fold ${foldName}`);
    const prepared = prepareWorkflowBudgetAuthorityRequest(
      'settle',
      fold.request,
      'qualification-caller',
    );
    const exactResponse = budgetReconciliationResponse(fold);
    const observed: Array<{ readonly method: string | undefined; readonly body: string }> = [];
    const server = createServer(async (request, response) => {
      observed.push({
        method: request.method,
        body: request.method === 'POST' ? await body(request) : '',
      });
      reply(response, exactResponse, request.method === 'POST' ? 202 : 200);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('test server address unavailable');
      }
      const client = createWorkflowRunnerBudgetAuthorityClient({
        origin: `http://127.0.0.1:${address.port}`,
        workspaceId: fold.request.workspaceId,
        bearerToken: 'b'.repeat(32),
        callerId: prepared.callerId,
      });
      await expect(client.mutate(prepared)).rejects.toMatchObject({
        code: 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
      });
      await expect(client.pointRead(prepared)).rejects.toMatchObject({
        code: 'WORKFLOW_RUNNER_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
      });
      expect(observed).toEqual([
        { method: 'POST', body: prepared.body },
        { method: 'GET', body: '' },
      ]);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  },
);

it('seals exact runtime admission identity and recovers a lost response by identical replay', async () => {
  const admission = {
    schema: 'openslack.workflow_runner_v2_runtime_admission.v1' as const,
    workspaceId: 'workspace.runtime.admission',
    jobId: 'job.runtime.admission',
    workflowRunId: 'run.runtime.admission',
    attemptId: 'attempt.runtime.admission',
    leaseId: 'lease.runtime.admission',
    fencingToken: 7,
    jobSpecHash: 'd'.repeat(64),
    disposition: 'resume' as const,
  };
  const prepared = prepareWorkflowRunnerV2RuntimeAdmission(admission);
  const exactReceipt = `${canonicalWorkflowControlAuthorityJson({
    ...admission,
    schema: 'openslack.workflow_runner_v2_runtime_admission_receipt.v1',
    status: 'accepted',
    idempotencyKey: prepared.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
    committedAt: '2026-08-22T00:00:00.000Z',
  })}\n`;
  const observed: Array<{ body: string; headers: IncomingMessage['headers'] }> = [];
  const server = createServer(async (request, response) => {
    observed.push({ body: await body(request), headers: request.headers });
    if (observed.length === 1) {
      request.socket.destroy();
      return;
    }
    reply(response, exactReceipt, 200);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const client = createWorkflowRunnerV2RuntimeAdmissionClient({
      origin: `http://127.0.0.1:${address.port}`,
      workspaceId: admission.workspaceId,
      bearerToken: 'r'.repeat(32),
    });
    await expect(client.seal(admission)).resolves.toMatchObject({
      status: 'accepted',
      disposition: 'resume',
    });
    expect(observed).toHaveLength(2);
    expect(observed[0]!.body).toBe(prepared.body);
    expect(observed[1]!.body).toBe(prepared.body);
    expect(observed[0]!.headers).toMatchObject({
      authorization: `Bearer ${'r'.repeat(32)}`,
      'x-openslack-workspace-id': admission.workspaceId,
      'idempotency-key': prepared.idempotencyKey,
      'x-openslack-request-fingerprint': prepared.requestFingerprint,
    });
    expect(observed[1]!.headers['idempotency-key']).toBe(prepared.idempotencyKey);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
});
