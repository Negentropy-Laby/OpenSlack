import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import type { GovernedPlanAuditSink } from '@openslack/operator';
import {
  LocalWorkflowEffectApprovalStore,
  type HumanWorkflowEffectDecisionBinding,
  type WorkflowEffectApprovalDecision,
  type WorkflowEffectApprovalRecord,
} from '@openslack/workflows';
import type { OpenSlackGovernedMutationInvocation } from './mutations.js';

export interface WorkflowApprovalDecisionResult {
  readonly record: WorkflowEffectApprovalRecord;
  readonly auditRecorded: boolean;
  readonly terminalConflict: boolean;
}

export interface OpenSlackWorkflowApprovalPort {
  decide(
    input: Readonly<Record<string, unknown>>,
    invocation: OpenSlackGovernedMutationInvocation,
  ): Promise<WorkflowApprovalDecisionResult>;
  read(runId: string, approvalId: string): Promise<WorkflowEffectApprovalRecord | undefined>;
}

export interface CreateOpenSlackWorkflowApprovalPortOptions {
  readonly store: LocalWorkflowEffectApprovalStore;
  readonly attestation: OpenSlackWorkflowApprovalAttestationPort;
  readonly audit: GovernedPlanAuditSink;
}

const NOMINAL_PORTS = new WeakSet<object>();
const NOMINAL_ATTESTATION_PORTS = new WeakSet<object>();
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

export interface WorkflowApprovalAttestationRequest {
  readonly runId: string;
  readonly approvalId: string;
  readonly decision: WorkflowEffectApprovalDecision;
  readonly reason: string;
  readonly reasonHash: string;
  readonly requiredCapability: string;
  readonly correlationId: string;
  readonly approvalExpiresAt: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: string;
}

export interface OpenSlackWorkflowApprovalAttestationPort {
  attest(
    request: WorkflowApprovalAttestationRequest,
  ): HumanWorkflowEffectDecisionBinding | Promise<HumanWorkflowEffectDecisionBinding>;
}

export function createOpenSlackWorkflowApprovalAttestationPort(
  attest: OpenSlackWorkflowApprovalAttestationPort['attest'],
): OpenSlackWorkflowApprovalAttestationPort {
  if (typeof attest !== 'function' || utilTypes.isProxy(attest)) {
    throw new TypeError('Workflow approval attestation must be a host-owned function.');
  }
  const port: OpenSlackWorkflowApprovalAttestationPort = Object.freeze({
    attest: (request: WorkflowApprovalAttestationRequest) => attest(request),
  });
  NOMINAL_ATTESTATION_PORTS.add(port);
  return port;
}

function assertAttestationPort(value: unknown): OpenSlackWorkflowApprovalAttestationPort {
  if (
    !value ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !NOMINAL_ATTESTATION_PORTS.has(value)
  ) {
    throw new TypeError(
      'Workflow approval requires a separately authenticated per-decision attestation port.',
    );
  }
  return value as OpenSlackWorkflowApprovalAttestationPort;
}

function inertOptions(value: CreateOpenSlackWorkflowApprovalPortOptions): PropertyDescriptorMap {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) {
    throw new TypeError('Workflow approval port options must be host-owned.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ['attestation', 'audit', 'store'];
  if (
    Reflect.ownKeys(descriptors).length !== expected.length ||
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' ||
        !expected.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  ) {
    throw new TypeError('Workflow approval port options have missing or unknown fields.');
  }
  return descriptors;
}

function invocation(
  value: OpenSlackGovernedMutationInvocation,
): OpenSlackGovernedMutationInvocation {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) {
    throw new TypeError('Workflow approval invocation must be host-owned.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== 2 ||
    !['signal', 'deadlineAt'].every(
      (key) => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key]!, 'value'),
    ) ||
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !['signal', 'deadlineAt'].includes(key),
    )
  ) {
    throw new TypeError('Workflow approval invocation has missing or unknown fields.');
  }
  const signal = descriptors.signal!.value;
  const deadlineAt = descriptors.deadlineAt!.value;
  if (
    utilTypes.isProxy(signal) ||
    !(signal instanceof AbortSignal) ||
    typeof deadlineAt !== 'string' ||
    !Number.isFinite(Date.parse(deadlineAt)) ||
    new Date(Date.parse(deadlineAt)).toISOString() !== deadlineAt
  ) {
    throw new TypeError('Workflow approval invocation has invalid execution control.');
  }
  return Object.freeze({ signal, deadlineAt });
}

function decisionInput(value: Readonly<Record<string, unknown>>): {
  readonly runId: string;
  readonly approvalId: string;
  readonly decision: WorkflowEffectApprovalDecision;
  readonly reason: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError('Workflow approval input must be validated inert data.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ['approvalId', 'decision', 'reason', 'runId'];
  if (
    Reflect.ownKeys(descriptors).length !== expected.length ||
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' ||
        !expected.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  ) {
    throw new TypeError('Workflow approval input has missing or unknown fields.');
  }
  const runId = descriptors.runId!.value;
  const approvalId = descriptors.approvalId!.value;
  const decision = descriptors.decision!.value;
  const reason = descriptors.reason!.value;
  if (
    typeof runId !== 'string' ||
    !SAFE_ID.test(runId) ||
    typeof approvalId !== 'string' ||
    !SAFE_ID.test(approvalId) ||
    (decision !== 'approved' && decision !== 'rejected') ||
    typeof reason !== 'string' ||
    reason.length < 1 ||
    Buffer.byteLength(reason, 'utf8') > 4_096
  ) {
    throw new TypeError('Workflow approval input is invalid.');
  }
  return Object.freeze({ runId, approvalId, decision, reason });
}

export function createOpenSlackWorkflowApprovalPort(
  options: CreateOpenSlackWorkflowApprovalPortOptions,
): OpenSlackWorkflowApprovalPort {
  const descriptors = inertOptions(options);
  const store = descriptors.store!.value;
  const attestation = assertAttestationPort(descriptors.attestation!.value);
  const audit = descriptors.audit!.value;
  if (utilTypes.isProxy(store) || !(store instanceof LocalWorkflowEffectApprovalStore)) {
    throw new TypeError('Workflow approval store must be the v2 local store.');
  }
  if (typeof audit !== 'function' || utilTypes.isProxy(audit)) {
    throw new TypeError('Workflow approval audit must be a host-owned sink.');
  }

  const projectAudit = async (
    recordValue: WorkflowEffectApprovalRecord,
  ): Promise<{
    readonly record: WorkflowEffectApprovalRecord;
    readonly auditRecorded: boolean;
  }> => {
    if (recordValue.auditProjection?.status === 'recorded') {
      return Object.freeze({ record: recordValue, auditRecorded: true });
    }
    if (
      recordValue.status === 'pending' ||
      recordValue.auditProjection?.status !== 'pending' ||
      !recordValue.decision
    ) {
      return Object.freeze({ record: recordValue, auditRecorded: false });
    }
    try {
      await audit({
        schema: 'openslack.governed_plan_audit.v1',
        eventId: recordValue.auditProjection.eventId,
        type: 'workflow.approval_decided',
        occurredAt: recordValue.decision.decidedAt,
        planId: recordValue.approvalId,
        kind: 'workflow.approval.decide',
        actorId: recordValue.decision.principalId,
        workspaceId: recordValue.decision.workspaceId,
        correlationId: recordValue.correlationId,
        state: 'succeeded',
        revision: recordValue.revision,
        evidenceRefs: [
          `workflow-effect-approval:${recordValue.runId}:${recordValue.approvalId}:revision:${recordValue.revision}`,
        ],
        details: { decision: recordValue.status },
      });
      try {
        const recorded = await store.markAuditProjected({
          runId: recordValue.runId,
          approvalId: recordValue.approvalId,
          expectedRevision: 1,
          eventId: recordValue.auditProjection.eventId,
        });
        return Object.freeze({ record: recorded, auditRecorded: true });
      } catch {
        const latest = await store.read(recordValue.runId, recordValue.approvalId);
        if (latest?.auditProjection?.status === 'recorded') {
          return Object.freeze({ record: latest, auditRecorded: true });
        }
        return Object.freeze({ record: latest ?? recordValue, auditRecorded: false });
      }
    } catch {
      return Object.freeze({ record: recordValue, auditRecorded: false });
    }
  };

  const port: OpenSlackWorkflowApprovalPort = Object.freeze({
    async decide(
      inputValue: Readonly<Record<string, unknown>>,
      invocationValue: OpenSlackGovernedMutationInvocation,
    ) {
      const input = decisionInput(inputValue);
      const control = invocation(invocationValue);
      if (control.signal.aborted || Date.now() >= Date.parse(control.deadlineAt)) {
        throw new Error('WORKFLOW_APPROVAL_ABORTED_BEFORE_DECISION');
      }
      const current = await store.read(input.runId, input.approvalId);
      if (!current) throw new Error('WORKFLOW_EFFECT_APPROVAL_NOT_FOUND');
      const reasonHash = createHash('sha256').update(input.reason, 'utf8').digest('hex');
      if (current.status !== 'pending') {
        const projected = await projectAudit(current);
        return Object.freeze({
          ...projected,
          terminalConflict:
            current.status !== input.decision || current.decision?.reasonHash !== reasonHash,
        });
      }
      const binding = await attestation.attest(
        Object.freeze({
          runId: current.runId,
          approvalId: current.approvalId,
          decision: input.decision,
          reason: input.reason,
          reasonHash,
          requiredCapability: current.requiredCapability,
          correlationId: current.correlationId,
          approvalExpiresAt: current.expiresAt,
          signal: control.signal,
          deadlineAt: control.deadlineAt,
        }),
      );
      if (control.signal.aborted || Date.now() >= Date.parse(control.deadlineAt)) {
        throw new Error('WORKFLOW_APPROVAL_ABORTED_BEFORE_CAS');
      }
      let record: WorkflowEffectApprovalRecord;
      try {
        record = await store.decide({
          runId: input.runId,
          approvalId: input.approvalId,
          expectedRevision: current.revision,
          decision: input.decision,
          reasonHash,
          binding,
        });
      } catch (error) {
        const latest = await store.read(input.runId, input.approvalId);
        if (!latest || latest.status === 'pending') throw error;
        const projected = await projectAudit(latest);
        return Object.freeze({
          ...projected,
          terminalConflict:
            latest.status !== input.decision || latest.decision?.reasonHash !== reasonHash,
        });
      }
      const projected = await projectAudit(record);
      return Object.freeze({ ...projected, terminalConflict: false });
    },
    read: (runId: string, approvalId: string) => store.read(runId, approvalId),
  });
  NOMINAL_PORTS.add(port);
  return port;
}

export function assertOpenSlackWorkflowApprovalPort(value: unknown): OpenSlackWorkflowApprovalPort {
  if (
    !value ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !NOMINAL_PORTS.has(value)
  ) {
    throw new TypeError('Workflow approval port requires a separately human-attested composition.');
  }
  return value as OpenSlackWorkflowApprovalPort;
}
