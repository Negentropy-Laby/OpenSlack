import { createHash, randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalWorkflowEffectJson } from './workflow-effect-json.js';

export const WORKFLOW_EFFECT_APPROVAL_SCHEMA = 'openslack.workflow_effect_approval.v2' as const;

export type WorkflowEffectApprovalStatus = 'pending' | 'approved' | 'rejected';
export type WorkflowEffectApprovalDecision = Exclude<WorkflowEffectApprovalStatus, 'pending'>;

export interface WorkflowEffectApprovalDecisionEvidence {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly capability: string;
  readonly reasonHash: string;
  readonly attestationNonce: string;
  readonly decidedAt: string;
}

export type WorkflowEffectApprovalAuditProjection =
  | {
      readonly status: 'pending';
      readonly eventId: string;
    }
  | {
      readonly status: 'recorded';
      readonly eventId: string;
      readonly recordedAt: string;
    };

export interface WorkflowEffectApprovalRecord {
  readonly schema: typeof WORKFLOW_EFFECT_APPROVAL_SCHEMA;
  readonly runId: string;
  readonly approvalId: string;
  readonly correlationId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowHash: string;
  readonly inputHash: string;
  readonly effectId: string;
  readonly effectHash: string;
  readonly requiredCapability: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revision: number;
  readonly status: WorkflowEffectApprovalStatus;
  readonly decision: WorkflowEffectApprovalDecisionEvidence | null;
  readonly auditProjection: WorkflowEffectApprovalAuditProjection | null;
}

export interface CreatePendingWorkflowEffectApprovalInput {
  readonly runId: string;
  readonly approvalId: string;
  readonly correlationId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowHash: string;
  readonly inputHash: string;
  readonly effectId: string;
  readonly effectHash: string;
  readonly requiredCapability: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface HumanWorkflowEffectDecisionBinding {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly capability: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly decision: WorkflowEffectApprovalDecision;
  readonly reasonHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface WorkflowEffectDecisionAuthorityInput {
  readonly workspaceId: string;
  readonly humanPrincipalIds: readonly string[];
  readonly capabilities: readonly string[];
  readonly maxBindingTtlMs: number;
}

export interface IssueHumanWorkflowEffectDecisionBindingInput {
  readonly principalId: string;
  readonly capability: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly decision: WorkflowEffectApprovalDecision;
  readonly reasonHash: string;
  readonly expiresAt: string;
}

export interface AssertHumanWorkflowEffectDecisionBindingInput {
  readonly requiredCapability: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly decision: WorkflowEffectApprovalDecision;
  readonly reasonHash: string;
  readonly decidedAt: string;
}

export class WorkflowEffectApprovalContractError extends Error {
  readonly code:
    | 'WORKFLOW_EFFECT_APPROVAL_INVALID'
    | 'WORKFLOW_EFFECT_APPROVAL_TRANSITION_DENIED'
    | 'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID'
    | 'WORKFLOW_EFFECT_APPROVAL_EXPIRED';

  constructor(code: WorkflowEffectApprovalContractError['code'], message: string) {
    super(message);
    this.name = 'WorkflowEffectApprovalContractError';
    this.code = code;
  }
}

type DataRecord = Record<string, unknown>;

const HASH = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const CAPABILITY = /^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)+$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUDIT_EVENT_ID = /^WFAPPROVAL-AUDIT-[0-9a-f]{64}$/;
const MAX_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const SEALED_AUTHORITIES = new WeakSet<object>();
const BINDING_AUTHORITY = new WeakMap<object, WorkflowEffectDecisionAuthority>();

function fail(code: WorkflowEffectApprovalContractError['code'], message: string): never {
  throw new WorkflowEffectApprovalContractError(code, message);
}

function assertNotProxy(
  value: unknown,
  label: string,
  code: WorkflowEffectApprovalContractError['code'],
): void {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    if (nodeTypes.isProxy(value)) fail(code, `${label} cannot be a Proxy.`);
  }
}

function closedRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
  code: WorkflowEffectApprovalContractError['code'],
): DataRecord {
  assertNotProxy(value, label, code);
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail(code, `${label} must be an inert object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return fail(code, `${label} has missing or unknown fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return fail(code, `${label} must contain only enumerable data fields.`);
    }
  }
  return value as DataRecord;
}

function own(record: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function denseStrings(
  value: unknown,
  label: string,
  pattern: RegExp,
  code: WorkflowEffectApprovalContractError['code'],
): readonly string[] {
  assertNotProxy(value, label, code);
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 256
  ) {
    return fail(code, `${label} must be a bounded dense array.`);
  }
  const expected = new Set(['length']);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    expected.add(String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail(code, `${label} must contain only data values.`);
    }
    result.push(text(descriptor.value, `${label}/${index}`, pattern, code));
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !expected.has(key))) {
    return fail(code, `${label} cannot contain named or symbol fields.`);
  }
  if (new Set(result).size !== result.length) {
    return fail(code, `${label} contains duplicate values.`);
  }
  return Object.freeze(result.sort());
}

function text(
  value: unknown,
  label: string,
  pattern: RegExp,
  code: WorkflowEffectApprovalContractError['code'],
): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 512 || !pattern.test(value)) {
    return fail(code, `${label} is invalid.`);
  }
  return value;
}

function timestamp(
  value: unknown,
  label: string,
  code: WorkflowEffectApprovalContractError['code'],
): string {
  const result = text(value, label, CANONICAL_TIMESTAMP, code);
  const millis = Date.parse(result);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== result) {
    return fail(code, `${label} must be canonical RFC3339.`);
  }
  return result;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  code: WorkflowEffectApprovalContractError['code'] = 'WORKFLOW_EFFECT_APPROVAL_INVALID',
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail(code, `${label} is invalid.`);
  }
  return value as number;
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(immutable);
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach(immutable);
  return Object.freeze(value);
}

function commonFields(record: DataRecord) {
  const effectHash = text(
    own(record, 'effectHash'),
    'effectHash',
    HASH,
    'WORKFLOW_EFFECT_APPROVAL_INVALID',
  );
  const effectId = text(
    own(record, 'effectId'),
    'effectId',
    SAFE_ID,
    'WORKFLOW_EFFECT_APPROVAL_INVALID',
  );
  if (effectId !== `workflow-effect:sha256:${effectHash}`) {
    return fail('WORKFLOW_EFFECT_APPROVAL_INVALID', 'effectId must be derived from effectHash.');
  }
  const createdAt = timestamp(
    own(record, 'createdAt'),
    'createdAt',
    'WORKFLOW_EFFECT_APPROVAL_INVALID',
  );
  const expiresAt = timestamp(
    own(record, 'expiresAt'),
    'expiresAt',
    'WORKFLOW_EFFECT_APPROVAL_INVALID',
  );
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > MAX_APPROVAL_LIFETIME_MS) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
      'Approval expiry must follow creation within the bounded lifetime.',
    );
  }
  return {
    runId: text(own(record, 'runId'), 'runId', SAFE_ID, 'WORKFLOW_EFFECT_APPROVAL_INVALID'),
    approvalId: text(
      own(record, 'approvalId'),
      'approvalId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
    ),
    correlationId: text(
      own(record, 'correlationId'),
      'correlationId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
    ),
    workflowId: text(
      own(record, 'workflowId'),
      'workflowId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
    ),
    workflowVersion: text(
      own(record, 'workflowVersion'),
      'workflowVersion',
      SEMVER,
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
    ),
    workflowHash: text(
      own(record, 'workflowHash'),
      'workflowHash',
      HASH,
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
    ),
    inputHash: text(
      own(record, 'inputHash'),
      'inputHash',
      HASH,
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
    ),
    effectId,
    effectHash,
    requiredCapability: text(
      own(record, 'requiredCapability'),
      'requiredCapability',
      CAPABILITY,
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
    ),
    createdAt,
    expiresAt,
  } as const;
}

export function createPendingWorkflowEffectApproval(
  value: CreatePendingWorkflowEffectApprovalInput,
): WorkflowEffectApprovalRecord {
  const record = closedRecord(
    value,
    [
      'runId',
      'approvalId',
      'correlationId',
      'workflowId',
      'workflowVersion',
      'workflowHash',
      'inputHash',
      'effectId',
      'effectHash',
      'requiredCapability',
      'createdAt',
      'expiresAt',
    ],
    'pending workflow effect approval',
    'WORKFLOW_EFFECT_APPROVAL_INVALID',
  );
  return immutable({
    schema: WORKFLOW_EFFECT_APPROVAL_SCHEMA,
    ...commonFields(record),
    revision: 0,
    status: 'pending' as const,
    decision: null,
    auditProjection: null,
  });
}

export function validateWorkflowEffectApproval(value: unknown): WorkflowEffectApprovalRecord {
  const record = closedRecord(
    value,
    [
      'schema',
      'runId',
      'approvalId',
      'correlationId',
      'workflowId',
      'workflowVersion',
      'workflowHash',
      'inputHash',
      'effectId',
      'effectHash',
      'requiredCapability',
      'createdAt',
      'expiresAt',
      'revision',
      'status',
      'decision',
      'auditProjection',
    ],
    'workflow effect approval',
    'WORKFLOW_EFFECT_APPROVAL_INVALID',
  );
  if (own(record, 'schema') !== WORKFLOW_EFFECT_APPROVAL_SCHEMA) {
    return fail('WORKFLOW_EFFECT_APPROVAL_INVALID', 'Approval schema is unsupported.');
  }
  const status = own(record, 'status');
  if (!['pending', 'approved', 'rejected'].includes(status as string)) {
    return fail('WORKFLOW_EFFECT_APPROVAL_INVALID', 'Approval status is invalid.');
  }
  const revision = integer(own(record, 'revision'), 'revision', 0, 2);
  const decisionValue = own(record, 'decision');
  const auditProjectionValue = own(record, 'auditProjection');
  let decision: WorkflowEffectApprovalDecisionEvidence | null = null;
  let auditProjection: WorkflowEffectApprovalAuditProjection | null = null;
  if (status === 'pending') {
    if (revision !== 0 || decisionValue !== null || auditProjectionValue !== null) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_INVALID',
        'Pending approvals require revision zero and no decision evidence.',
      );
    }
  } else {
    if (revision !== 1 && revision !== 2) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_INVALID',
        'Terminal approvals require revision one or two.',
      );
    }
    const decisionRecord = closedRecord(
      decisionValue,
      ['principalId', 'workspaceId', 'capability', 'reasonHash', 'attestationNonce', 'decidedAt'],
      'approval decision evidence',
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
    );
    decision = Object.freeze({
      principalId: text(
        own(decisionRecord, 'principalId'),
        'principalId',
        SAFE_ID,
        'WORKFLOW_EFFECT_APPROVAL_INVALID',
      ),
      workspaceId: text(
        own(decisionRecord, 'workspaceId'),
        'workspaceId',
        SAFE_ID,
        'WORKFLOW_EFFECT_APPROVAL_INVALID',
      ),
      capability: text(
        own(decisionRecord, 'capability'),
        'capability',
        CAPABILITY,
        'WORKFLOW_EFFECT_APPROVAL_INVALID',
      ),
      reasonHash: text(
        own(decisionRecord, 'reasonHash'),
        'reasonHash',
        HASH,
        'WORKFLOW_EFFECT_APPROVAL_INVALID',
      ),
      attestationNonce: text(
        own(decisionRecord, 'attestationNonce'),
        'attestationNonce',
        UUID_V4,
        'WORKFLOW_EFFECT_APPROVAL_INVALID',
      ),
      decidedAt: timestamp(
        own(decisionRecord, 'decidedAt'),
        'decidedAt',
        'WORKFLOW_EFFECT_APPROVAL_INVALID',
      ),
    });
    const projectionRecord = closedRecord(
      auditProjectionValue,
      revision === 1 ? ['status', 'eventId'] : ['status', 'eventId', 'recordedAt'],
      'approval audit projection',
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
    );
    const projectionStatus = own(projectionRecord, 'status');
    if (
      (revision === 1 && projectionStatus !== 'pending') ||
      (revision === 2 && projectionStatus !== 'recorded')
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_INVALID',
        'Approval audit projection does not match its revision.',
      );
    }
    const eventId = text(
      own(projectionRecord, 'eventId'),
      'eventId',
      AUDIT_EVENT_ID,
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
    );
    auditProjection =
      projectionStatus === 'pending'
        ? Object.freeze({ status: 'pending' as const, eventId })
        : Object.freeze({
            status: 'recorded' as const,
            eventId,
            recordedAt: timestamp(
              own(projectionRecord, 'recordedAt'),
              'recordedAt',
              'WORKFLOW_EFFECT_APPROVAL_INVALID',
            ),
          });
  }
  const result = immutable({
    schema: WORKFLOW_EFFECT_APPROVAL_SCHEMA,
    ...commonFields(record),
    revision,
    status: status as WorkflowEffectApprovalStatus,
    decision,
    auditProjection,
  });
  if (
    result.auditProjection !== null &&
    result.auditProjection.eventId !==
      workflowEffectApprovalAuditEventId(result.runId, result.approvalId)
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
      'Approval audit projection event ID is not the deterministic decision event.',
    );
  }
  if (
    result.decision !== null &&
    (result.decision.capability !== result.requiredCapability ||
      Date.parse(result.decision.decidedAt) < Date.parse(result.createdAt) ||
      Date.parse(result.decision.decidedAt) >= Date.parse(result.expiresAt))
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_INVALID',
      'Decision evidence is outside the approval capability or lifetime.',
    );
  }
  return result;
}

export class WorkflowEffectDecisionAuthority {
  readonly #workspaceId: string;
  readonly #humanPrincipalIds: ReadonlySet<string>;
  readonly #capabilities: ReadonlySet<string>;
  readonly #maxBindingTtlMs: number;

  private constructor(input: WorkflowEffectDecisionAuthorityInput) {
    const record = closedRecord(
      input,
      ['workspaceId', 'humanPrincipalIds', 'capabilities', 'maxBindingTtlMs'],
      'workflow effect decision authority',
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    this.#workspaceId = text(
      own(record, 'workspaceId'),
      'workspaceId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    this.#humanPrincipalIds = new Set(
      denseStrings(
        own(record, 'humanPrincipalIds'),
        'humanPrincipalIds',
        SAFE_ID,
        'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
      ),
    );
    this.#capabilities = new Set(
      denseStrings(
        own(record, 'capabilities'),
        'capabilities',
        CAPABILITY,
        'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
      ),
    );
    this.#maxBindingTtlMs = integer(
      own(record, 'maxBindingTtlMs'),
      'maxBindingTtlMs',
      1_000,
      60 * 60 * 1_000,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    SEALED_AUTHORITIES.add(this);
    Object.freeze(this);
  }

  static create(input: WorkflowEffectDecisionAuthorityInput): WorkflowEffectDecisionAuthority {
    return new WorkflowEffectDecisionAuthority(input);
  }

  static assertSealed(value: unknown): asserts value is WorkflowEffectDecisionAuthority {
    assertNotProxy(
      value,
      'workflow effect decision authority',
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    if (
      typeof value !== 'object' ||
      value === null ||
      !(value instanceof WorkflowEffectDecisionAuthority) ||
      !SEALED_AUTHORITIES.has(value)
    ) {
      fail(
        'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
        'A host-created workflow effect decision authority is required.',
      );
    }
  }

  issueHumanDecisionBinding(
    value: IssueHumanWorkflowEffectDecisionBindingInput,
  ): HumanWorkflowEffectDecisionBinding {
    WorkflowEffectDecisionAuthority.assertSealed(this);
    const input = closedRecord(
      value,
      ['principalId', 'capability', 'runId', 'approvalId', 'decision', 'reasonHash', 'expiresAt'],
      'human decision binding request',
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const principalId = text(
      own(input, 'principalId'),
      'principalId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const capability = text(
      own(input, 'capability'),
      'capability',
      CAPABILITY,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const runId = text(
      own(input, 'runId'),
      'runId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const approvalId = text(
      own(input, 'approvalId'),
      'approvalId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const decision = own(input, 'decision');
    if (decision !== 'approved' && decision !== 'rejected') {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
        'Human decision binding decision is invalid.',
      );
    }
    const reasonHash = text(
      own(input, 'reasonHash'),
      'reasonHash',
      HASH,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const created = new Date().toISOString();
    const expiresAt = timestamp(
      own(input, 'expiresAt'),
      'expiresAt',
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    if (
      !this.#humanPrincipalIds.has(principalId) ||
      !this.#capabilities.has(capability) ||
      Date.parse(expiresAt) <= Date.parse(created) ||
      Date.parse(expiresAt) - Date.parse(created) > this.#maxBindingTtlMs
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
        'Human principal, capability, or binding lifetime is not authorized.',
      );
    }
    const binding = Object.freeze({
      principalId,
      workspaceId: this.#workspaceId,
      capability,
      runId,
      approvalId,
      decision,
      reasonHash,
      issuedAt: created,
      expiresAt,
      nonce: randomUUID(),
    });
    BINDING_AUTHORITY.set(binding, this);
    return binding;
  }

  assertHumanDecisionBinding(
    value: HumanWorkflowEffectDecisionBinding,
    requestValue: AssertHumanWorkflowEffectDecisionBindingInput,
  ): HumanWorkflowEffectDecisionBinding {
    WorkflowEffectDecisionAuthority.assertSealed(this);
    if (
      typeof value !== 'object' ||
      value === null ||
      nodeTypes.isProxy(value) ||
      BINDING_AUTHORITY.get(value) !== this
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
        'Human decision binding is not nominally issued by this authority.',
      );
    }
    const binding = closedRecord(
      value,
      [
        'principalId',
        'workspaceId',
        'capability',
        'runId',
        'approvalId',
        'decision',
        'reasonHash',
        'issuedAt',
        'expiresAt',
        'nonce',
      ],
      'human decision binding',
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const request = closedRecord(
      requestValue,
      ['requiredCapability', 'runId', 'approvalId', 'decision', 'reasonHash', 'decidedAt'],
      'human decision binding scope',
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const principalId = text(
      own(binding, 'principalId'),
      'principalId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const workspaceId = text(
      own(binding, 'workspaceId'),
      'workspaceId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const capability = text(
      own(binding, 'capability'),
      'capability',
      CAPABILITY,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const runId = text(
      own(binding, 'runId'),
      'runId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const approvalId = text(
      own(binding, 'approvalId'),
      'approvalId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const decision = own(binding, 'decision');
    const reasonHash = text(
      own(binding, 'reasonHash'),
      'reasonHash',
      HASH,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const issuedAt = timestamp(
      own(binding, 'issuedAt'),
      'issuedAt',
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const expiresAt = timestamp(
      own(binding, 'expiresAt'),
      'expiresAt',
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const decisionTime = timestamp(
      own(request, 'decidedAt'),
      'decidedAt',
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const requiredCapability = text(
      own(request, 'requiredCapability'),
      'requiredCapability',
      CAPABILITY,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const requestedRunId = text(
      own(request, 'runId'),
      'runId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const requestedApprovalId = text(
      own(request, 'approvalId'),
      'approvalId',
      SAFE_ID,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const requestedDecision = own(request, 'decision');
    const requestedReasonHash = text(
      own(request, 'reasonHash'),
      'reasonHash',
      HASH,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    const nonce = text(
      own(binding, 'nonce'),
      'nonce',
      UUID_V4,
      'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
    );
    if (
      workspaceId !== this.#workspaceId ||
      capability !== requiredCapability ||
      runId !== requestedRunId ||
      approvalId !== requestedApprovalId ||
      decision !== requestedDecision ||
      reasonHash !== requestedReasonHash ||
      (decision !== 'approved' && decision !== 'rejected') ||
      (requestedDecision !== 'approved' && requestedDecision !== 'rejected') ||
      !this.#humanPrincipalIds.has(principalId) ||
      !this.#capabilities.has(capability) ||
      Date.parse(issuedAt) > Date.parse(decisionTime) ||
      Date.parse(decisionTime) >= Date.parse(expiresAt)
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_BINDING_INVALID',
        'Human decision binding does not authorize this effect.',
      );
    }
    return value;
  }
}

export function createWorkflowEffectDecisionAuthority(
  input: WorkflowEffectDecisionAuthorityInput,
): WorkflowEffectDecisionAuthority {
  return WorkflowEffectDecisionAuthority.create(input);
}

export function applyWorkflowEffectApprovalDecision(
  currentValue: WorkflowEffectApprovalRecord,
  decision: WorkflowEffectApprovalDecision,
  binding: HumanWorkflowEffectDecisionBinding,
  authority: WorkflowEffectDecisionAuthority,
  reasonHash: string,
  decidedAt: string,
): WorkflowEffectApprovalRecord {
  const current = validateWorkflowEffectApproval(currentValue);
  if (current.status !== 'pending' || current.revision !== 0) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_TRANSITION_DENIED',
      'Workflow effect approval already has a terminal decision.',
    );
  }
  if (!['approved', 'rejected'].includes(decision)) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_TRANSITION_DENIED',
      'Workflow effect approval decision is invalid.',
    );
  }
  const canonicalDecidedAt = timestamp(decidedAt, 'decidedAt', 'WORKFLOW_EFFECT_APPROVAL_INVALID');
  const canonicalReasonHash = text(
    reasonHash,
    'reasonHash',
    HASH,
    'WORKFLOW_EFFECT_APPROVAL_INVALID',
  );
  if (
    Date.parse(canonicalDecidedAt) < Date.parse(current.createdAt) ||
    Date.parse(canonicalDecidedAt) >= Date.parse(current.expiresAt)
  ) {
    return fail('WORKFLOW_EFFECT_APPROVAL_EXPIRED', 'Workflow effect approval has expired.');
  }
  const validatedBinding = authority.assertHumanDecisionBinding(binding, {
    requiredCapability: current.requiredCapability,
    runId: current.runId,
    approvalId: current.approvalId,
    decision,
    reasonHash: canonicalReasonHash,
    decidedAt: canonicalDecidedAt,
  });
  return validateWorkflowEffectApproval({
    ...current,
    revision: 1,
    status: decision,
    decision: {
      principalId: validatedBinding.principalId,
      workspaceId: validatedBinding.workspaceId,
      capability: validatedBinding.capability,
      reasonHash: validatedBinding.reasonHash,
      attestationNonce: validatedBinding.nonce,
      decidedAt: canonicalDecidedAt,
    },
    auditProjection: {
      status: 'pending',
      eventId: workflowEffectApprovalAuditEventId(current.runId, current.approvalId),
    },
  });
}

export function workflowEffectApprovalAuditEventId(
  runIdValue: string,
  approvalIdValue: string,
): string {
  const runId = text(runIdValue, 'runId', SAFE_ID, 'WORKFLOW_EFFECT_APPROVAL_INVALID');
  const approvalId = text(
    approvalIdValue,
    'approvalId',
    SAFE_ID,
    'WORKFLOW_EFFECT_APPROVAL_INVALID',
  );
  const digest = createHash('sha256')
    .update(`${runId}\0${approvalId}\0decision-revision-1`, 'utf8')
    .digest('hex');
  return `WFAPPROVAL-AUDIT-${digest}`;
}

export function markWorkflowEffectApprovalAuditRecorded(
  currentValue: WorkflowEffectApprovalRecord,
  eventIdValue: string,
  recordedAtValue: string,
): WorkflowEffectApprovalRecord {
  const current = validateWorkflowEffectApproval(currentValue);
  if (
    current.status === 'pending' ||
    current.revision !== 1 ||
    current.auditProjection?.status !== 'pending'
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_TRANSITION_DENIED',
      'Workflow effect approval audit projection is not pending.',
    );
  }
  const eventId = text(eventIdValue, 'eventId', AUDIT_EVENT_ID, 'WORKFLOW_EFFECT_APPROVAL_INVALID');
  if (eventId !== current.auditProjection.eventId) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_TRANSITION_DENIED',
      'Workflow effect approval audit event does not match.',
    );
  }
  const recordedAt = timestamp(recordedAtValue, 'recordedAt', 'WORKFLOW_EFFECT_APPROVAL_INVALID');
  if (Date.parse(recordedAt) < Date.parse(current.decision!.decidedAt)) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_TRANSITION_DENIED',
      'Workflow effect approval audit cannot precede its decision.',
    );
  }
  return validateWorkflowEffectApproval({
    ...current,
    revision: 2,
    auditProjection: {
      status: 'recorded',
      eventId,
      recordedAt,
    },
  });
}

export function workflowEffectApprovalBytes(record: WorkflowEffectApprovalRecord): Buffer {
  return Buffer.from(`${canonicalWorkflowEffectJson(validateWorkflowEffectApproval(record))}\n`);
}
