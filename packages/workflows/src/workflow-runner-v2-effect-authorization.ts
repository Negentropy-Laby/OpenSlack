import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  deriveWorkflowEffectApprovalId,
  deriveWorkflowEffectOccurrenceId,
  hashWorkflowEffectApprovalDecision,
  hashWorkflowEffectApprovalRecord,
  hashWorkflowEffectControlDomain,
  projectWorkflowEffectHumanDecision,
} from './workflow-effect-control-contract.js';
import {
  persistWorkflowEffectApprovalPending,
  readWorkflowEffectApprovalRecordExact,
  WorkflowEffectApprovalStoreError,
} from './workflow-effect-approval-store.js';
import {
  acquireOwnerJournalLock,
  assertOwnerDirectory,
  atomicWrite,
  ensureOwnerDirectory,
  productionJournalSecurity,
  readOwnerFile,
  syncDirectory,
  writeExclusive,
} from './workflow-control-shadow.js';
import { canonicalWorkflowControlAuthorityJson } from './workflow-control-authority-contract.js';
import {
  hashWorkflowRunnerAuthorityBindingEvidence,
  type WorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerEffectAuthorityEvidence,
  type WorkflowRunnerEffectCompletionEvidence,
} from './workflow-runner-authority-binding-contract.js';
import type { WorkflowRunnerAuthoritySourceAdapter } from './workflow-runner-authority-binding-runtime.js';
import {
  hashWorkflowRunnerDomain,
  hashWorkflowRunnerEffect,
} from './workflow-runner-descriptor.js';
import type { WorkflowRunnerV2ExecutionDescriptor } from './workflow-runner-v2-descriptor.js';
import type { WorkflowRunnerV2ExecutionContext } from './workflow-runner-v2-session.js';
import {
  registerWorkflowEffectAuthorizationPort,
  WorkflowEffectApprovalPendingError,
  WorkflowEffectAuthorizationBusyError,
  WorkflowEffectAuthorizationRejectedError,
  WorkflowEffectReconciliationRequiredError,
  type WorkflowEffectAuthorizationPort,
  type WorkflowEffectClaimAuthorization,
  type WorkflowEffectPreparedAuthorization,
} from './internal/workflow-effect-authorization-contract.js';

const JOURNAL_SCHEMA = 'openslack.workflow_runner_v2_effect_sibling.v1' as const;
const MAX_RECORD_BYTES = 512 * 1024;
const APPROVAL_TTL_MS = 15 * 60_000;

interface PreparedState {
  readonly port: WorkflowEffectAuthorizationPort;
  readonly evaluationIndex: number;
  readonly effectId: string;
  readonly effectKind: string;
  readonly effectHash: string;
  readonly capabilityHash: string;
  readonly occurrenceId: string;
  readonly intentBindingHash: string;
  readonly approvalId: string;
}

interface ReplayValue {
  readonly kind: 'undefined' | 'json';
  readonly value?: unknown;
  readonly outcomeHash: string;
}

interface EffectSiblingRecord {
  readonly schema: typeof JOURNAL_SCHEMA;
  readonly identityHash: string;
  readonly runId: string;
  readonly evaluationIndex: number;
  readonly authorization: WorkflowRunnerEffectAuthorityEvidence;
  readonly completion?: WorkflowRunnerEffectCompletionEvidence;
  readonly replay?: ReplayValue;
}

interface ClaimState {
  readonly port: WorkflowEffectAuthorizationPort;
  readonly prepared: PreparedState;
  readonly executionId: string;
  readonly claimHash: string;
}

const PREPARED = new WeakMap<object, PreparedState>();
const CLAIMS = new WeakMap<object, ClaimState>();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical(value: unknown): string {
  return `${canonicalWorkflowControlAuthorityJson(value)}\n`;
}

function replayValue(value: unknown): ReplayValue {
  if (value === undefined) {
    return Object.freeze({
      kind: 'undefined' as const,
      outcomeHash: hashWorkflowEffectControlDomain('execution-result', 'undefined'),
    });
  }
  canonicalWorkflowControlAuthorityJson(value);
  return Object.freeze({
    kind: 'json' as const,
    value,
    outcomeHash: hashWorkflowEffectControlDomain('execution-result', value),
  });
}

function replayed(value: ReplayValue): unknown {
  return value.kind === 'undefined' ? undefined : value.value;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

class WorkflowRunnerV2EffectSiblingJournal {
  readonly #root: string;
  readonly #security = productionJournalSecurity();
  #records?: string;
  #locks?: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async initialize(): Promise<void> {
    const root = await ensureOwnerDirectory(this.#root, this.#security);
    const entries = await readdir(root, { withFileTypes: true });
    if (
      entries.some(
        (entry) =>
          !['locks', 'records'].includes(entry.name) ||
          !entry.isDirectory() ||
          entry.isSymbolicLink(),
      )
    ) {
      throw new WorkflowEffectReconciliationRequiredError(
        'Workflow effect sibling journal contains an unsafe entry.',
      );
    }
    this.#records = await ensureOwnerDirectory(join(root, 'records'), this.#security, root);
    this.#locks = await ensureOwnerDirectory(join(root, 'locks'), this.#security, root);
  }

  async runExclusive<T>(identityHash: string, operation: () => Promise<T>): Promise<T> {
    const release = await acquireOwnerJournalLock(
      this.#paths().locks,
      identityHash,
      this.#security,
    );
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async read(identityHash: string): Promise<EffectSiblingRecord | null> {
    const { records } = this.#paths();
    await assertOwnerDirectory(records, this.#security, this.#root);
    const path = join(records, `${identityHash}.json`);
    let exact: string;
    try {
      exact = await readOwnerFile(path, this.#security, MAX_RECORD_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(exact);
    } catch (error) {
      throw new WorkflowEffectReconciliationRequiredError(
        'Workflow effect sibling journal is not JSON.',
        { cause: error },
      );
    }
    if (canonical(parsed) !== exact) {
      throw new WorkflowEffectReconciliationRequiredError(
        'Workflow effect sibling journal is not exact canonical JSON.',
      );
    }
    const parsedRecord =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    if (
      !hasExactKeys(parsedRecord, [
        'schema',
        'identityHash',
        'runId',
        'evaluationIndex',
        'authorization',
        ...(parsedRecord && Object.prototype.hasOwnProperty.call(parsedRecord, 'completion')
          ? ['completion']
          : []),
        ...(parsedRecord && Object.prototype.hasOwnProperty.call(parsedRecord, 'replay')
          ? ['replay']
          : []),
      ])
    ) {
      throw new WorkflowEffectReconciliationRequiredError(
        'Workflow effect sibling journal has unknown or missing fields.',
      );
    }
    const record = parsed as unknown as EffectSiblingRecord;
    if (
      record.schema !== JOURNAL_SCHEMA ||
      record.identityHash !== identityHash ||
      !Number.isSafeInteger(record.evaluationIndex) ||
      record.evaluationIndex < 1
    ) {
      throw new WorkflowEffectReconciliationRequiredError(
        'Workflow effect sibling journal identity is invalid.',
      );
    }
    hashWorkflowRunnerAuthorityBindingEvidence(record.authorization, 'effect_authorize');
    if (record.completion) {
      hashWorkflowRunnerAuthorityBindingEvidence(record.completion, 'effect_complete');
      if (
        record.completion.executionId !== record.authorization.executionId ||
        record.completion.claimHash !== record.authorization.claimHash
      ) {
        throw new WorkflowEffectReconciliationRequiredError(
          'Workflow effect sibling completion lineage is invalid.',
        );
      }
      if (
        (record.completion.status === 'reconciliation_required' && record.replay) ||
        (record.completion.status !== 'reconciliation_required' &&
          (!record.replay || record.completion.outcomeHash !== record.replay.outcomeHash))
      ) {
        throw new WorkflowEffectReconciliationRequiredError(
          'Workflow effect sibling replay state is invalid.',
        );
      }
      if (record.replay) {
        const validUndefined =
          record.replay.kind === 'undefined' &&
          hasExactKeys(record.replay, ['kind', 'outcomeHash']);
        const validJson =
          record.replay.kind === 'json' &&
          hasExactKeys(record.replay, ['kind', 'value', 'outcomeHash']);
        if (!validUndefined && !validJson) {
          throw new WorkflowEffectReconciliationRequiredError(
            'Workflow effect sibling replay shape is invalid.',
          );
        }
        const recomputed = replayValue(
          record.replay.kind === 'undefined' ? undefined : record.replay.value,
        );
        if (
          recomputed.outcomeHash !== record.replay.outcomeHash ||
          recomputed.outcomeHash !== record.completion.outcomeHash
        ) {
          throw new WorkflowEffectReconciliationRequiredError(
            'Workflow effect sibling replay value does not match its outcome hash.',
          );
        }
      }
    } else if (record.replay) {
      throw new WorkflowEffectReconciliationRequiredError(
        'Workflow effect sibling replay exists without completion.',
      );
    }
    return Object.freeze(record);
  }

  async putAuthorization(
    record: EffectSiblingRecord,
  ): Promise<{ readonly record: EffectSiblingRecord; readonly created: boolean }> {
    const path = join(this.#paths().records, `${record.identityHash}.json`);
    const exact = canonical(record);
    try {
      await writeExclusive(path, exact, this.#security);
      await syncDirectory(this.#paths().records);
      return { record, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await this.read(record.identityHash);
    if (!existing || canonical(existing) !== exact) {
      throw new WorkflowEffectReconciliationRequiredError(
        'Workflow effect sibling claim conflicts with prior durable evidence.',
      );
    }
    return { record: existing, created: false };
  }

  async putCompletion(
    current: EffectSiblingRecord,
    completion: WorkflowRunnerEffectCompletionEvidence,
    replay?: ReplayValue,
  ): Promise<EffectSiblingRecord> {
    const next = Object.freeze({ ...current, completion, replay });
    const path = join(this.#paths().records, `${current.identityHash}.json`);
    await atomicWrite(path, canonical(next), this.#security);
    await syncDirectory(this.#paths().records);
    return next;
  }

  #paths(): { readonly records: string; readonly locks: string } {
    if (!this.#records || !this.#locks) {
      throw new WorkflowEffectReconciliationRequiredError(
        'Workflow effect sibling journal is not initialized.',
      );
    }
    return { records: this.#records, locks: this.#locks };
  }
}

function identityHash(descriptor: WorkflowRunnerV2ExecutionDescriptor, evaluationIndex: number) {
  return sha256(
    `openslack.workflow-runner-v2-effect-sibling.identity.v1\0${canonicalWorkflowControlAuthorityJson(
      {
        workspaceId: descriptor.workspaceId,
        runId: descriptor.workflowRunId,
        workflowId: descriptor.workflowId,
        workflowVersion: descriptor.workflowVersion,
        workflowSourceHash: descriptor.workflowSourceHash,
        manifestHash: descriptor.manifestHash,
        inputHash: descriptor.inputHash,
        evaluationIndex,
      },
    )}`,
  );
}

function sourceReceiptHash(schema: string, recordHash: string, acceptedRevision: number): string {
  return sha256(
    `openslack.workflow-runner-v2-effect-sibling.receipt.v1\0${canonicalWorkflowControlAuthorityJson(
      { schema, recordHash, acceptedRevision },
    )}`,
  );
}

function assertSiblingForPrepared(
  record: EffectSiblingRecord,
  prepared: PreparedState,
  descriptor: WorkflowRunnerV2ExecutionDescriptor,
  resumeGeneration: number,
): EffectSiblingRecord {
  const authorization = record.authorization;
  const identity = record.identityHash;
  const authorizationRecordHash = hashWorkflowEffectControlDomain('runner-v2-effect-claim-record', {
    identity,
    approvalId: authorization.approvalId,
    approvalStatus: authorization.approvalStatus,
    approvalRecordHash: authorization.approvalRecordHash,
    approvalDecisionHash: authorization.approvalDecisionHash,
    executionId: authorization.executionId,
    claimHash: authorization.claimHash,
  });
  if (
    record.runId !== descriptor.workflowRunId ||
    record.evaluationIndex !== prepared.evaluationIndex ||
    authorization.occurrenceId !== prepared.occurrenceId ||
    authorization.intentBindingHash !== prepared.intentBindingHash ||
    authorization.effectId !== prepared.effectId ||
    authorization.effectHash !== prepared.effectHash ||
    authorization.capabilityHash !== prepared.capabilityHash ||
    authorization.approvalId !== prepared.approvalId ||
    authorization.sourceAuthority.requestHash !== prepared.intentBindingHash ||
    authorization.sourceAuthority.expectedResumeGeneration !== resumeGeneration ||
    authorization.sourceAuthority.acceptedResumeGeneration !== resumeGeneration ||
    authorization.sourceAuthority.recordHash !== authorizationRecordHash ||
    authorization.sourceAuthority.receiptSchema === null ||
    authorization.sourceAuthority.acceptedRevision === null ||
    authorization.sourceAuthority.receiptHash !==
      sourceReceiptHash(
        authorization.sourceAuthority.receiptSchema,
        authorizationRecordHash,
        authorization.sourceAuthority.acceptedRevision,
      ) ||
    authorization.sourceAuthority.authorityBuildHash !==
      descriptor.authorityRoute.authorityBuildHash
  ) {
    throw new WorkflowEffectReconciliationRequiredError(
      'Workflow effect sibling does not match the prepared occurrence identity.',
    );
  }
  if (authorization.approvalStatus === 'approved') {
    const executionId = `WFEXECUTION-${hashWorkflowEffectControlDomain('execution-id', {
      approvalDecisionHash: authorization.approvalDecisionHash,
      occurrenceId: prepared.occurrenceId,
    })}`;
    const claimHash = hashWorkflowEffectControlDomain('runner-v2-execution-claim', {
      executionId,
      approvalDecisionHash: authorization.approvalDecisionHash,
      intentBindingHash: prepared.intentBindingHash,
    });
    if (
      authorization.executionId !== executionId ||
      authorization.claimHash !== claimHash ||
      authorization.grantHash !== claimHash
    ) {
      throw new WorkflowEffectReconciliationRequiredError(
        'Workflow effect sibling claim derivation is invalid.',
      );
    }
  }
  const completion = record.completion;
  const completionRecordHash = completion
    ? hashWorkflowEffectControlDomain('runner-v2-effect-completion-record', {
        identity,
        executionId: completion.executionId,
        claimHash: completion.claimHash,
        outcomeHash: completion.outcomeHash,
        ...(completion.status === 'reconciliation_required'
          ? { reconciliationToken: completion.reconciliationToken }
          : {}),
        status: completion.status,
      })
    : null;
  if (
    completion &&
    (completion.occurrenceId !== prepared.occurrenceId ||
      completion.effectId !== prepared.effectId ||
      completion.effectHash !== prepared.effectHash ||
      completion.executionId !== authorization.executionId ||
      completion.claimHash !== authorization.claimHash ||
      completion.sourceAuthority.requestHash !== authorization.claimHash ||
      completion.sourceAuthority.expectedRevision !== authorization.decisionRevision ||
      completion.sourceAuthority.acceptedRevision !== authorization.decisionRevision + 1 ||
      completion.sourceAuthority.expectedResumeGeneration !== resumeGeneration ||
      completion.sourceAuthority.acceptedResumeGeneration !== resumeGeneration ||
      completion.sourceAuthority.recordHash !== completionRecordHash ||
      completion.sourceAuthority.receiptSchema === null ||
      completion.sourceAuthority.acceptedRevision === null ||
      completion.sourceAuthority.receiptHash !==
        sourceReceiptHash(
          completion.sourceAuthority.receiptSchema,
          completionRecordHash!,
          completion.sourceAuthority.acceptedRevision,
        ) ||
      completion.sourceAuthority.authorityBuildHash !==
        descriptor.authorityRoute.authorityBuildHash)
  ) {
    throw new WorkflowEffectReconciliationRequiredError(
      'Workflow effect sibling completion does not match its prepared claim.',
    );
  }
  return record;
}

/**
 * F2b bridge from the runtime effect gate to the frozen D approval record and
 * an independent one-time v2 claim/outcome sibling. Pending approval creation
 * happens before staging and carries no execution authority; the claim itself
 * is committed only after the companion has durably staged the exact event.
 */
export async function createWorkflowRunnerV2EffectAuthorizationPort(options: {
  readonly workspaceRoot: string;
  readonly descriptor: WorkflowRunnerV2ExecutionDescriptor;
  readonly context: WorkflowRunnerV2ExecutionContext;
  readonly now?: () => string;
}): Promise<WorkflowEffectAuthorizationPort> {
  const now = options.now ?? (() => new Date().toISOString());
  const approvalRoot = join(
    options.workspaceRoot,
    '.openslack.local',
    'workflows',
    'effect-approvals',
  );
  const journal = new WorkflowRunnerV2EffectSiblingJournal(
    join(options.workspaceRoot, '.openslack.local', 'workflows', 'effect-authority-v2-siblings'),
  );
  await journal.initialize();

  const port: WorkflowEffectAuthorizationPort = Object.freeze({
    async prepare(input: Parameters<WorkflowEffectAuthorizationPort['prepare']>[0]) {
      if (input.runId !== options.descriptor.workflowRunId || input.evaluationIndex < 1) {
        throw new TypeError('Workflow runner v2 effect preparation identity is invalid.');
      }
      const effectHash = hashWorkflowRunnerEffect({
        detail: input.detail,
        operation: input.operation,
        runId: input.runId,
      });
      const effectId = `workflow-effect:sha256:${effectHash}`;
      const capabilityHash = hashWorkflowRunnerDomain('effect-capability', input.operation);
      const occurrenceId = deriveWorkflowEffectOccurrenceId(input.runId, input.evaluationIndex);
      const intentBindingHash = hashWorkflowEffectControlDomain('runner-v2-intent-binding', {
        workspaceId: options.descriptor.workspaceId,
        runId: input.runId,
        correlationId: options.descriptor.correlationId,
        workflowId: options.descriptor.workflowId,
        workflowVersion: options.descriptor.workflowVersion,
        workflowSourceHash: options.descriptor.workflowSourceHash,
        manifestHash: options.descriptor.manifestHash,
        inputHash: options.descriptor.inputHash,
        evaluationIndex: input.evaluationIndex,
        occurrenceId,
        effectId,
        effectHash,
        capabilityHash,
      });
      const approvalId = deriveWorkflowEffectApprovalId(occurrenceId, intentBindingHash);
      let approval;
      try {
        approval = await readWorkflowEffectApprovalRecordExact(
          approvalRoot,
          input.runId,
          approvalId,
        );
      } catch (error) {
        if (
          !(error instanceof WorkflowEffectApprovalStoreError) ||
          error.code !== 'WORKFLOW_EFFECT_APPROVAL_STORE_NOT_FOUND'
        ) {
          throw error;
        }
      }
      if (!approval) {
        const createdAt = now();
        const expiresAt = new Date(
          Math.min(
            Date.parse(options.descriptor.expiresAt),
            Date.parse(createdAt) + APPROVAL_TTL_MS,
          ),
        ).toISOString();
        approval = await persistWorkflowEffectApprovalPending(
          approvalRoot,
          {
            runId: input.runId,
            approvalId,
            correlationId: options.descriptor.correlationId,
            workflowId: options.descriptor.workflowId,
            workflowVersion: options.descriptor.workflowVersion,
            workflowHash: options.descriptor.workflowSourceHash,
            inputHash: options.descriptor.inputHash,
            effectId,
            effectHash,
            requiredCapability: 'workflow.effect.decide',
            createdAt,
            expiresAt,
          },
          createdAt,
        );
      }
      if (
        approval.effectId !== effectId ||
        approval.effectHash !== effectHash ||
        approval.correlationId !== options.descriptor.correlationId
      ) {
        throw new WorkflowEffectReconciliationRequiredError(
          'Workflow runner v2 effect approval identity changed.',
        );
      }
      const prepared = Object.freeze({
        kind: 'workflow_effect_prepared_authorization' as const,
        handle: Object.freeze({
          effectId,
          effectKind: input.operation,
          effectHash,
          capabilityHash,
          requiresHumanDecision: true as const,
        }),
      });
      PREPARED.set(prepared, {
        port,
        evaluationIndex: input.evaluationIndex,
        effectId,
        effectKind: input.operation,
        effectHash,
        capabilityHash,
        occurrenceId,
        intentBindingHash,
        approvalId,
      });
      return prepared;
    },

    async authorize(prepared: WorkflowEffectPreparedAuthorization) {
      const state = PREPARED.get(prepared);
      if (!state || state.port !== port) {
        throw new TypeError('Workflow runner v2 effect preparation is not host-minted.');
      }
      const identity = identityHash(options.descriptor, state.evaluationIndex);
      const existingValue = await journal.read(identity);
      const existing = existingValue
        ? assertSiblingForPrepared(
            existingValue,
            state,
            options.descriptor,
            options.context.resumeGeneration,
          )
        : null;
      if (existing?.completion && existing.replay) {
        return Object.freeze({
          disposition: 'replay' as const,
          value: replayed(existing.replay),
          executionId: existing.authorization.executionId!,
          outcomeHash: existing.replay.outcomeHash,
        });
      }
      if (existing) {
        throw new WorkflowEffectReconciliationRequiredError(
          'A durable effect claim has no proved terminal outcome.',
        );
      }
      const approval = await readWorkflowEffectApprovalRecordExact(
        approvalRoot,
        options.descriptor.workflowRunId,
        state.approvalId,
      );
      if (!approval || approval.status === 'pending') {
        throw new WorkflowEffectApprovalPendingError(
          options.descriptor.workflowRunId,
          state.approvalId,
        );
      }
      const authorityExpiresAt = new Date(
        Math.min(Date.parse(approval.expiresAt), Date.parse(options.descriptor.expiresAt)),
      ).toISOString();
      const expired = Date.parse(authorityExpiresAt) <= Date.parse(now());
      const humanDecision = expired
        ? null
        : projectWorkflowEffectHumanDecision({
            approval,
            issuedAt: approval.decision!.decidedAt,
            expiresAt: new Date(
              Math.min(
                Date.parse(approval.expiresAt),
                Date.parse(options.descriptor.expiresAt),
                Date.parse(approval.decision!.decidedAt) + 60_000,
              ),
            ).toISOString(),
          });
      const approvalStatus = expired ? ('expired' as const) : approval.status;
      const approvalRecordHash = expired ? null : hashWorkflowEffectApprovalRecord(approval);
      const approvalDecisionHash =
        expired || !humanDecision
          ? null
          : hashWorkflowEffectApprovalDecision(approval, humanDecision);
      const executionId =
        approvalStatus === 'approved'
          ? `WFEXECUTION-${hashWorkflowEffectControlDomain('execution-id', {
              approvalDecisionHash,
              occurrenceId: state.occurrenceId,
            })}`
          : null;
      const claimHash =
        executionId === null
          ? null
          : hashWorkflowEffectControlDomain('runner-v2-execution-claim', {
              executionId,
              approvalDecisionHash,
              intentBindingHash: state.intentBindingHash,
            });
      let claimCreatedByThisCall = false;
      const source: WorkflowRunnerAuthoritySourceAdapter = {
        async probe(stage) {
          if (stage.operation !== 'effect_authorize') {
            throw new WorkflowEffectReconciliationRequiredError(
              'Effect authorization source operation changed.',
            );
          }
          const foundValue = await journal.read(identity);
          const found = foundValue
            ? assertSiblingForPrepared(
                foundValue,
                state,
                options.descriptor,
                options.context.resumeGeneration,
              )
            : null;
          return found
            ? { state: 'committed' as const, evidence: found.authorization }
            : { state: 'not_committed' as const };
        },
        async commit(stage: WorkflowRunnerAuthorityBindingStage) {
          if (stage.operation !== 'effect_authorize') {
            throw new WorkflowEffectReconciliationRequiredError(
              'Effect authorization source operation changed.',
            );
          }
          return journal.runExclusive(identity, async () => {
            const foundValue = await journal.read(identity);
            const found = foundValue
              ? assertSiblingForPrepared(
                  foundValue,
                  state,
                  options.descriptor,
                  options.context.resumeGeneration,
                )
              : null;
            if (found) return found.authorization;
            const recordHash = hashWorkflowEffectControlDomain('runner-v2-effect-claim-record', {
              identity,
              approvalId: state.approvalId,
              approvalStatus,
              approvalRecordHash,
              approvalDecisionHash,
              executionId,
              claimHash,
            });
            const acceptedRevision = approval.revision;
            const evidence: WorkflowRunnerEffectAuthorityEvidence = {
              schema: 'openslack.workflow_runner_effect_authority_evidence.v1',
              sourceAuthority: {
                plane: 'effect_v2_sibling',
                evidenceState: 'committed',
                expectedRevision: Math.max(0, acceptedRevision - 1),
                acceptedRevision,
                expectedResumeGeneration: options.context.resumeGeneration,
                acceptedResumeGeneration: options.context.resumeGeneration,
                requestHash: state.intentBindingHash,
                receiptSchema: 'openslack.workflow_runner_effect_authority_receipt.v1',
                receiptHash: sourceReceiptHash(
                  'openslack.workflow_runner_effect_authority_receipt.v1',
                  recordHash,
                  acceptedRevision,
                ),
                recordHash,
                authorityBuildHash: options.descriptor.authorityRoute.authorityBuildHash,
              },
              occurrenceId: state.occurrenceId,
              intentBindingHash: state.intentBindingHash,
              effectId: state.effectId,
              effectHash: state.effectHash,
              capabilityHash: state.capabilityHash,
              approvalId: state.approvalId,
              approvalStatus,
              approvalRecordHash,
              approvalDecisionHash,
              decisionRevision: acceptedRevision,
              humanBindingHash: humanDecision?.bindingHash ?? null,
              attestationHash: humanDecision?.attestationHash ?? null,
              executionId,
              claimHash,
              grantHash: claimHash,
              expiresAt: authorityExpiresAt,
            };
            hashWorkflowRunnerAuthorityBindingEvidence(evidence, 'effect_authorize');
            const persisted = await journal.putAuthorization({
              schema: JOURNAL_SCHEMA,
              identityHash: identity,
              runId: options.descriptor.workflowRunId,
              evaluationIndex: state.evaluationIndex,
              authorization: evidence,
            });
            claimCreatedByThisCall = persisted.created;
            return evidence;
          });
        },
      };
      const decision = await options.context.authorizeEffect(
        {
          effectId: state.effectId,
          effectKind: state.effectKind,
          effectHash: state.effectHash,
          capabilityHash: state.capabilityHash,
          requiresHumanDecision: true,
        },
        source,
      );
      const payload = decision.payload as { readonly approvalStatus?: unknown };
      if (approvalStatus !== 'approved' || executionId === null || claimHash === null) {
        if (approvalStatus === 'rejected' && approvalDecisionHash) {
          throw new WorkflowEffectAuthorizationRejectedError(
            state.approvalId,
            approvalDecisionHash,
          );
        }
        throw new WorkflowEffectReconciliationRequiredError(
          'Expired workflow effect approval cannot authorize execution.',
        );
      }
      if (!claimCreatedByThisCall) {
        throw new WorkflowEffectAuthorizationBusyError(
          'The exact workflow effect occurrence is already owned by another claimant.',
        );
      }
      const reconcileUnexecutableClaim = async (causeCode: string) => {
        const authority = Object.freeze({
          kind: 'workflow_effect_claim_authorization' as const,
          executionId,
        });
        CLAIMS.set(authority, { port, prepared: state, executionId, claimHash });
        try {
          await port.reconcile(authority, causeCode);
        } catch (error) {
          throw new WorkflowEffectReconciliationRequiredError(
            'Committed workflow effect claim could not publish its reconciliation outcome.',
            { cause: error },
          );
        }
      };
      if (payload.approvalStatus !== 'approved') {
        await reconcileUnexecutableClaim('control_decision_mismatch');
        throw new WorkflowEffectReconciliationRequiredError(
          'Control decision differs from the committed TypeScript effect grant.',
        );
      }
      if (Date.parse(now()) >= Date.parse(authorityExpiresAt)) {
        await reconcileUnexecutableClaim('authority_expired_after_claim');
        throw new WorkflowEffectReconciliationRequiredError(
          'Workflow effect authority expired after its claim was committed.',
        );
      }
      const authority = Object.freeze({
        kind: 'workflow_effect_claim_authorization' as const,
        executionId,
      });
      CLAIMS.set(authority, { port, prepared: state, executionId, claimHash });
      return Object.freeze({ disposition: 'claimed' as const, authority, executionId });
    },

    async complete(authority: WorkflowEffectClaimAuthorization, value: unknown) {
      const claim = CLAIMS.get(authority);
      if (!claim || claim.port !== port) {
        throw new TypeError('Workflow runner v2 effect claim is not host-minted.');
      }
      const identity = identityHash(options.descriptor, claim.prepared.evaluationIndex);
      const replay = replayValue(value);
      let completionEvidence: WorkflowRunnerEffectCompletionEvidence | undefined;
      const source: WorkflowRunnerAuthoritySourceAdapter = {
        async probe(stage) {
          if (stage.operation !== 'effect_complete') {
            throw new WorkflowEffectReconciliationRequiredError(
              'Effect completion source operation changed.',
            );
          }
          const foundValue = await journal.read(identity);
          const found = foundValue
            ? assertSiblingForPrepared(
                foundValue,
                claim.prepared,
                options.descriptor,
                options.context.resumeGeneration,
              )
            : null;
          return found?.completion
            ? { state: 'committed' as const, evidence: found.completion }
            : { state: 'not_committed' as const };
        },
        async commit(stage) {
          if (stage.operation !== 'effect_complete') {
            throw new WorkflowEffectReconciliationRequiredError(
              'Effect completion source operation changed.',
            );
          }
          return journal.runExclusive(identity, async () => {
            const currentValue = await journal.read(identity);
            const current = currentValue
              ? assertSiblingForPrepared(
                  currentValue,
                  claim.prepared,
                  options.descriptor,
                  options.context.resumeGeneration,
                )
              : null;
            if (!current || current.authorization.executionId !== claim.executionId) {
              throw new WorkflowEffectReconciliationRequiredError(
                'Effect completion lost its durable one-time claim.',
              );
            }
            if (current.completion) return current.completion;
            const expectedRevision = current.authorization.decisionRevision;
            const recordHash = hashWorkflowEffectControlDomain(
              'runner-v2-effect-completion-record',
              {
                identity,
                executionId: claim.executionId,
                claimHash: claim.claimHash,
                outcomeHash: replay.outcomeHash,
                status: 'executed',
              },
            );
            const evidence: WorkflowRunnerEffectCompletionEvidence = {
              schema: 'openslack.workflow_runner_effect_completion_evidence.v1',
              sourceAuthority: {
                plane: 'effect_v2_sibling',
                evidenceState: 'committed',
                expectedRevision,
                acceptedRevision: expectedRevision + 1,
                expectedResumeGeneration: options.context.resumeGeneration,
                acceptedResumeGeneration: options.context.resumeGeneration,
                requestHash: claim.claimHash,
                receiptSchema: 'openslack.workflow_runner_effect_completion_receipt.v1',
                receiptHash: sourceReceiptHash(
                  'openslack.workflow_runner_effect_completion_receipt.v1',
                  recordHash,
                  expectedRevision + 1,
                ),
                recordHash,
                authorityBuildHash: options.descriptor.authorityRoute.authorityBuildHash,
              },
              occurrenceId: claim.prepared.occurrenceId,
              effectId: claim.prepared.effectId,
              effectHash: claim.prepared.effectHash,
              executionId: claim.executionId,
              claimHash: claim.claimHash,
              status: 'executed',
              outcomeHash: replay.outcomeHash,
              reconciliationToken: null,
            };
            hashWorkflowRunnerAuthorityBindingEvidence(evidence, 'effect_complete');
            await journal.putCompletion(current, evidence, replay);
            completionEvidence = evidence;
            return evidence;
          });
        },
      };
      await options.context.reportEffectOutcome(
        {
          effectId: claim.prepared.effectId,
          status: 'executed',
          outcomeHash: replay.outcomeHash,
        },
        source,
      );
      CLAIMS.delete(authority);
      const durableValue = await journal.read(identity);
      const durable =
        completionEvidence ??
        (durableValue
          ? assertSiblingForPrepared(
              durableValue,
              claim.prepared,
              options.descriptor,
              options.context.resumeGeneration,
            ).completion
          : undefined);
      if (!durable) {
        throw new WorkflowEffectReconciliationRequiredError(
          'Effect completion response lacks durable sibling evidence.',
        );
      }
      return Object.freeze({ outcomeHash: durable.outcomeHash });
    },

    async reconcile(authority: WorkflowEffectClaimAuthorization, causeCode: string) {
      const claim = CLAIMS.get(authority);
      if (!claim || claim.port !== port) {
        throw new TypeError('Workflow runner v2 effect claim is not host-minted.');
      }
      const identity = identityHash(options.descriptor, claim.prepared.evaluationIndex);
      const outcomeHash = hashWorkflowEffectControlDomain('execution-reconciliation', {
        causeCode,
        executionId: claim.executionId,
      });
      const reconciliationToken = `effect-reconciliation:${sha256(
        canonicalWorkflowControlAuthorityJson({
          causeCode,
          executionId: claim.executionId,
          identity,
        }),
      )}`;
      const source: WorkflowRunnerAuthoritySourceAdapter = {
        async probe(stage) {
          if (stage.operation !== 'effect_complete') {
            throw new WorkflowEffectReconciliationRequiredError(
              'Effect reconciliation source operation changed.',
            );
          }
          const foundValue = await journal.read(identity);
          const found = foundValue
            ? assertSiblingForPrepared(
                foundValue,
                claim.prepared,
                options.descriptor,
                options.context.resumeGeneration,
              )
            : null;
          return found?.completion
            ? { state: 'committed' as const, evidence: found.completion }
            : { state: 'not_committed' as const };
        },
        async commit(stage) {
          if (stage.operation !== 'effect_complete') {
            throw new WorkflowEffectReconciliationRequiredError(
              'Effect reconciliation source operation changed.',
            );
          }
          return journal.runExclusive(identity, async () => {
            const currentValue = await journal.read(identity);
            const current = currentValue
              ? assertSiblingForPrepared(
                  currentValue,
                  claim.prepared,
                  options.descriptor,
                  options.context.resumeGeneration,
                )
              : null;
            if (!current || current.authorization.executionId !== claim.executionId) {
              throw new WorkflowEffectReconciliationRequiredError(
                'Effect reconciliation lost its durable one-time claim.',
              );
            }
            if (current.completion) return current.completion;
            const expectedRevision = current.authorization.decisionRevision;
            const recordHash = hashWorkflowEffectControlDomain(
              'runner-v2-effect-completion-record',
              {
                identity,
                executionId: claim.executionId,
                claimHash: claim.claimHash,
                outcomeHash,
                reconciliationToken,
                status: 'reconciliation_required',
              },
            );
            const evidence: WorkflowRunnerEffectCompletionEvidence = {
              schema: 'openslack.workflow_runner_effect_completion_evidence.v1',
              sourceAuthority: {
                plane: 'effect_v2_sibling',
                evidenceState: 'committed',
                expectedRevision,
                acceptedRevision: expectedRevision + 1,
                expectedResumeGeneration: options.context.resumeGeneration,
                acceptedResumeGeneration: options.context.resumeGeneration,
                requestHash: claim.claimHash,
                receiptSchema: 'openslack.workflow_runner_effect_completion_receipt.v1',
                receiptHash: sourceReceiptHash(
                  'openslack.workflow_runner_effect_completion_receipt.v1',
                  recordHash,
                  expectedRevision + 1,
                ),
                recordHash,
                authorityBuildHash: options.descriptor.authorityRoute.authorityBuildHash,
              },
              occurrenceId: claim.prepared.occurrenceId,
              effectId: claim.prepared.effectId,
              effectHash: claim.prepared.effectHash,
              executionId: claim.executionId,
              claimHash: claim.claimHash,
              status: 'reconciliation_required',
              outcomeHash,
              reconciliationToken,
            };
            hashWorkflowRunnerAuthorityBindingEvidence(evidence, 'effect_complete');
            await journal.putCompletion(current, evidence);
            return evidence;
          });
        },
      };
      try {
        await options.context.reportEffectOutcome(
          {
            effectId: claim.prepared.effectId,
            status: 'reconciliation_required',
            outcomeHash,
          },
          source,
        );
      } finally {
        CLAIMS.delete(authority);
      }
    },
  });
  registerWorkflowEffectAuthorizationPort(port);
  return port;
}
