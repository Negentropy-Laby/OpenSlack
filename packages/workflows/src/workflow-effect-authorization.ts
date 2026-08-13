import { join } from 'node:path';
import { types as nodeTypes } from 'node:util';
import {
  deriveWorkflowEffectApprovalId,
  hashWorkflowEffectIntentBinding,
  type WorkflowEffectIntentArtifact,
} from './workflow-effect-control-contract.js';
import { createPendingWorkflowEffectApproval } from './workflow-effect-approval.js';
import {
  persistWorkflowEffectApprovalPending,
  readWorkflowEffectApprovalRecordExact,
} from './workflow-effect-approval-store.js';
import {
  LocalWorkflowEffectAuthorityStore,
  WorkflowEffectAuthorityStoreError,
  type PreparedWorkflowEffectOccurrence,
} from './workflow-effect-authority-store.js';
import type {
  WorkflowEffectBoundary,
  WorkflowEffectBoundaryHandle,
} from './workflow-runner-effect-boundary.js';
import {
  hashWorkflowRunnerDomain,
  hashWorkflowRunnerEffect,
} from './workflow-runner-descriptor.js';
import {
  workflowEffectLeaseBindingFromAuthority,
  type WorkflowEffectLeaseAuthority,
} from './internal/workflow-effect-lease-authority.js';
import {
  registerWorkflowEffectAuthorizationPort,
  WorkflowEffectApprovalPendingError,
  WorkflowEffectAuthorizationRejectedError,
  WorkflowEffectReconciliationRequiredError,
  type WorkflowEffectAuthorizationPort,
  type WorkflowEffectPreparedAuthorization,
  type WorkflowEffectClaimAuthorization,
} from './internal/workflow-effect-authorization-contract.js';

export {
  assertWorkflowEffectAuthorizationPort,
  WorkflowEffectApprovalPendingError,
  WorkflowEffectAuthorizationRejectedError,
  WorkflowEffectAuthorizationRequiredError,
  WorkflowEffectReconciliationRequiredError,
  type WorkflowEffectAuthorizationDisposition,
  type WorkflowEffectAuthorizationPort,
  type WorkflowEffectPreparedAuthorization,
  type WorkflowEffectClaimAuthorization,
} from './internal/workflow-effect-authorization-contract.js';

const APPROVAL_TTL_MS = 15 * 60_000;

type PrepareInput = Parameters<WorkflowEffectAuthorizationPort['prepare']>[0];
type PreparedAuthorization = Parameters<WorkflowEffectAuthorizationPort['authorize']>[0];
type ClaimAuthorization = Parameters<WorkflowEffectAuthorizationPort['complete']>[0];

interface PreparedState {
  readonly port: WorkflowEffectAuthorizationPort;
  readonly occurrence: PreparedWorkflowEffectOccurrence;
}

interface ClaimState {
  readonly port: WorkflowEffectAuthorizationPort;
  readonly storeAuthority: { readonly executionId: string };
}

const PREPARED = new WeakMap<object, PreparedState>();
const CLAIMS = new WeakMap<object, ClaimState>();

function intentArtifact(
  record: PreparedWorkflowEffectOccurrence['record'],
): WorkflowEffectIntentArtifact {
  const artifact = record.artifact;
  if (!artifact)
    throw new WorkflowEffectReconciliationRequiredError('Durable effect intent is unavailable.');
  if (artifact.kind === 'effect_intent') return artifact;
  return artifact.intentArtifact;
}

function mapStoreError(error: unknown): never {
  if (!(error instanceof WorkflowEffectAuthorityStoreError)) throw error;
  if (error.code === 'WORKFLOW_EFFECT_AUTHORITY_PENDING') {
    throw error;
  }
  if (error.code === 'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED') {
    throw new WorkflowEffectReconciliationRequiredError(error.message, { cause: error });
  }
  throw error;
}

export function createWorkflowEffectAuthorizationPort(options: {
  readonly workspaceRoot: string;
  readonly effectBoundary: WorkflowEffectBoundary;
  readonly leaseAuthority: WorkflowEffectLeaseAuthority;
  readonly now?: () => string;
}): WorkflowEffectAuthorizationPort {
  if (
    !options ||
    typeof options !== 'object' ||
    nodeTypes.isProxy(options) ||
    typeof options.workspaceRoot !== 'string' ||
    !options.effectBoundary ||
    typeof options.effectBoundary !== 'object'
  ) {
    throw new TypeError('Workflow effect authorization composition is invalid.');
  }
  const binding = workflowEffectLeaseBindingFromAuthority(options.leaseAuthority);
  const now = options.now ?? (() => new Date().toISOString());
  const approvalRoot = join(
    options.workspaceRoot,
    '.openslack.local',
    'workflows',
    'effect-approvals',
  );
  const store = new LocalWorkflowEffectAuthorityStore(approvalRoot, now);

  const port: WorkflowEffectAuthorizationPort = Object.freeze({
    async prepare(input: PrepareInput) {
      if (
        input.runId !== binding.runId ||
        !Number.isSafeInteger(input.evaluationIndex) ||
        input.evaluationIndex < 1 ||
        typeof input.operation !== 'string' ||
        typeof input.detail !== 'string'
      ) {
        throw new TypeError('Workflow effect authorization request is invalid.');
      }
      const effectHash = hashWorkflowRunnerEffect({
        detail: input.detail,
        operation: input.operation,
        runId: input.runId,
      });
      const handle: WorkflowEffectBoundaryHandle = Object.freeze({
        effectId: `workflow-effect:sha256:${effectHash}`,
        effectKind: input.operation,
        effectHash,
        capabilityHash: hashWorkflowRunnerDomain('effect-capability', input.operation),
        requiresHumanDecision: true,
      });
      let occurrence: PreparedWorkflowEffectOccurrence;
      let currentHandle = handle;
      let intentReceiptAccepted = false;
      try {
        const existing = await store.find(
          binding,
          input.evaluationIndex,
          handle.effectKind,
          handle.effectId,
          handle.effectHash,
        );
        if (existing) {
          occurrence = existing;
          // The durable approval/claim chain is reused across attempts, but
          // runner-v1 still needs an exact intent/outcome pair on this lease.
          const currentEvidence = await binding.emitIntent(handle, async () => undefined);
          currentHandle = Object.freeze({ ...currentEvidence.message.payload });
          if (
            currentHandle.effectId !== handle.effectId ||
            currentHandle.effectKind !== handle.effectKind ||
            currentHandle.effectHash !== handle.effectHash ||
            currentHandle.capabilityHash !== handle.capabilityHash ||
            currentHandle.requiresHumanDecision !== true
          ) {
            throw new TypeError('Replayed workflow effect boundary identity changed.');
          }
        } else {
          const evidence = await binding.emitIntent(handle, (preparation) =>
            store.persistProvisional(
              binding,
              input.evaluationIndex,
              handle.effectKind,
              handle.effectId,
              handle.effectHash,
              preparation,
            ),
          );
          intentReceiptAccepted = true;
          occurrence = await store.acceptIntent(
            binding,
            input.evaluationIndex,
            handle.effectKind,
            handle.effectId,
            handle.effectHash,
            evidence,
          );
        }
      } catch (error) {
        if (intentReceiptAccepted) {
          const reconciliation = new WorkflowEffectReconciliationRequiredError(
            'Durable runner intent could not be committed into the exact TypeScript authority chain.',
            { cause: error },
          );
          try {
            await options.effectBoundary.outcome(handle, {
              status: 'reconciliation_required',
              evidence: { code: reconciliation.code },
            });
          } catch (outcomeError) {
            throw new WorkflowEffectReconciliationRequiredError(
              'Runner intent and TypeScript authority outcomes both require reconciliation.',
              { cause: new AggregateError([error, outcomeError]) },
            );
          }
          throw reconciliation;
        }
        mapStoreError(error);
      }
      const prepared = Object.freeze({
        kind: 'workflow_effect_prepared_authorization' as const,
        handle: currentHandle,
      });
      PREPARED.set(prepared, { port, occurrence });
      return prepared;
    },

    async authorize(prepared: PreparedAuthorization, signal?: AbortSignal) {
      const state = PREPARED.get(prepared);
      if (!state || state.port !== port) {
        throw new TypeError('Workflow effect prepared authorization is not host-minted.');
      }
      let occurrence: PreparedWorkflowEffectOccurrence;
      try {
        occurrence =
          (await store.find(
            binding,
            state.occurrence.record.evaluationIndex,
            state.occurrence.record.effectKind,
            state.occurrence.record.effectId,
            state.occurrence.record.effectHash,
          )) ?? state.occurrence;
      } catch (error) {
        mapStoreError(error);
      }
      if (
        occurrence.record.state === 'decision_prepared' &&
        occurrence.record.artifact?.kind === 'effect_approval_pending'
      ) {
        const pending = occurrence.record.artifact.approval;
        occurrence = await store.recoverPreparedDecision(
          occurrence,
          await readWorkflowEffectApprovalRecordExact(
            approvalRoot,
            pending.runId,
            pending.approvalId,
          ),
        );
      }
      if (occurrence.record.state === 'intent_accepted') {
        const intent = intentArtifact(occurrence.record);
        const intentBindingHash = hashWorkflowEffectIntentBinding(
          intent,
          occurrence.record.validationContext,
        );
        const createdAt = now();
        const expiresAt = new Date(Date.parse(createdAt) + APPROVAL_TTL_MS).toISOString();
        const pendingInput = {
          runId: binding.runId,
          approvalId: deriveWorkflowEffectApprovalId(intent.occurrenceId, intentBindingHash),
          correlationId: binding.correlationId,
          workflowId: binding.workflowId,
          workflowVersion: binding.workflowVersion,
          workflowHash: binding.workflowSourceHash,
          inputHash: binding.inputHash,
          effectId: intent.runnerV1Message.payload.effectId,
          effectHash: intent.runnerV1Message.payload.effectHash,
          requiredCapability: 'workflow.effect.decide',
          createdAt,
          expiresAt,
        } as const;
        const approval = createPendingWorkflowEffectApproval(pendingInput);
        occurrence = await store.commitPending(occurrence, approval);
      }
      const artifact = occurrence.record.artifact;
      if (artifact?.kind === 'effect_approval_pending') {
        if (occurrence.record.state === 'approval_committed') {
          const pending = artifact.approval;
          await persistWorkflowEffectApprovalPending(
            approvalRoot,
            {
              runId: pending.runId,
              approvalId: pending.approvalId,
              correlationId: pending.correlationId,
              workflowId: pending.workflowId,
              workflowVersion: pending.workflowVersion,
              workflowHash: pending.workflowHash,
              inputHash: pending.inputHash,
              effectId: pending.effectId,
              effectHash: pending.effectHash,
              requiredCapability: pending.requiredCapability,
              createdAt: pending.createdAt,
              expiresAt: pending.expiresAt,
            },
            now(),
          );
        }
        throw new WorkflowEffectApprovalPendingError(binding.runId, artifact.approval.approvalId);
      }
      if (
        (artifact?.kind === 'effect_decision_committed' ||
          artifact?.kind === 'effect_audit_recorded') &&
        artifact.approval.status === 'rejected'
      ) {
        if (artifact.approvalDecisionHash === null) {
          throw new WorkflowEffectReconciliationRequiredError(
            'Rejected workflow effect decision has no exact decision hash.',
          );
        }
        throw new WorkflowEffectAuthorizationRejectedError(
          artifact.approval.approvalId,
          artifact.approvalDecisionHash,
        );
      }
      try {
        const result = await store.claim(occurrence, signal);
        if (result.disposition === 'replay') {
          return Object.freeze({
            disposition: 'replay' as const,
            value: result.value,
            executionId: result.artifact.executionId,
            outcomeHash: result.artifact.outcomeHash!,
          });
        }
        const authority = Object.freeze({
          kind: 'workflow_effect_claim_authorization' as const,
          executionId: result.artifact.executionId,
        });
        CLAIMS.set(authority, {
          port,
          storeAuthority: result.authority,
        });
        return Object.freeze({
          disposition: 'claimed' as const,
          authority,
          executionId: result.artifact.executionId,
        });
      } catch (error) {
        mapStoreError(error);
      }
    },

    async complete(authority: ClaimAuthorization, value: unknown) {
      const state = CLAIMS.get(authority);
      if (!state || state.port !== port) {
        throw new TypeError('Workflow effect claim authorization is not host-minted.');
      }
      try {
        const artifact = await store.complete(state.storeAuthority, value);
        CLAIMS.delete(authority);
        return Object.freeze({ outcomeHash: artifact.outcomeHash! });
      } catch (error) {
        CLAIMS.delete(authority);
        mapStoreError(error);
      }
    },

    async reconcile(authority: ClaimAuthorization, causeCode: string) {
      const state = CLAIMS.get(authority);
      if (!state || state.port !== port) {
        throw new TypeError('Workflow effect claim authorization is not host-minted.');
      }
      try {
        await store.reconcile(state.storeAuthority, causeCode);
        CLAIMS.delete(authority);
      } catch (error) {
        CLAIMS.delete(authority);
        mapStoreError(error);
      }
    },
  });
  registerWorkflowEffectAuthorizationPort(port);
  return port;
}
