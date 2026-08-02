import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalWorkflowEffectJson } from './workflow-effect-json.js';

export const WORKFLOW_CONTROL_OBSERVATION_SCHEMA =
  'openslack.workflow_control_observation.v1' as const;
export const WORKFLOW_CONTROL_READ_MODEL_SCHEMA =
  'openslack.workflow_control_read_model.v1' as const;
export const WORKFLOW_CONTROL_AUTHORITY = 'typescript' as const;
export const WORKFLOW_CONTROL_GO_ROLE = 'credential-free-read-model-only' as const;

export const WORKFLOW_CONTROL_RUN_STATES = Object.freeze([
  'created',
  'previewed',
  'confirmed',
  'running',
  'paused',
  'paused_waiting_approval',
  'resuming',
  'completed',
  'failed',
  'cancelled',
] as const);
export type WorkflowControlRunState = (typeof WORKFLOW_CONTROL_RUN_STATES)[number];

export const WORKFLOW_CONTROL_STATE_TRANSITIONS = Object.freeze({
  created: Object.freeze(['previewed', 'confirmed', 'running'] as const),
  previewed: Object.freeze(['confirmed', 'running'] as const),
  confirmed: Object.freeze(['running'] as const),
  running: Object.freeze([
    'paused',
    'paused_waiting_approval',
    'resuming',
    'completed',
    'failed',
    'cancelled',
  ] as const),
  paused: Object.freeze(['running'] as const),
  paused_waiting_approval: Object.freeze(['resuming', 'cancelled'] as const),
  resuming: Object.freeze(['running', 'failed', 'cancelled'] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
} satisfies Readonly<Record<WorkflowControlRunState, readonly WorkflowControlRunState[]>>);

export const WORKFLOW_CONTROL_DORMANT_STATES = Object.freeze([
  'created',
  'previewed',
  'confirmed',
] as const);
export const WORKFLOW_CONTROL_PRODUCTION_INITIAL_STATE = 'running' as const;
export const WORKFLOW_CONTROL_EXECUTION_MODES = Object.freeze([
  'validate',
  'preview',
  'dry-run',
  'execute',
] as const);
export type WorkflowControlExecutionMode = (typeof WORKFLOW_CONTROL_EXECUTION_MODES)[number];
export const WORKFLOW_CONTROL_CHECKPOINT_STATES = Object.freeze([
  'completed',
  'failed',
  'skipped',
] as const);
export type WorkflowControlCheckpointState = (typeof WORKFLOW_CONTROL_CHECKPOINT_STATES)[number];
export const WORKFLOW_CONTROL_APPROVAL_STATES = Object.freeze([
  'pending',
  'approved',
  'rejected',
] as const);
export type WorkflowControlApprovalState = (typeof WORKFLOW_CONTROL_APPROVAL_STATES)[number];
export const WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA =
  'openslack.workflow_effect_approval.v2' as const;

export const WORKFLOW_CONTROL_QUALIFICATION_GAPS = Object.freeze([
  'no-cas-or-revision',
  'no-lease',
  'no-fencing',
  'no-execution-abort',
  'no-durable-budget-authority',
  'resume-correctness-unqualified',
  'control-transition-bypass-exists',
] as const);

export const WORKFLOW_CONTROL_CONTRACT_LIMITS = Object.freeze({
  maxObservationBytes: 256 * 1024,
  maxIdentifierBytes: 256,
  maxWorkflowNameBytes: 512,
  maxPhaseNameBytes: 512,
  maxPhaseCheckpoints: 256,
  maxBudgetWarnings: 256,
  maxCount: 1_000_000,
  maxTokens: Number.MAX_SAFE_INTEGER,
  maxCostUsd: 1_000_000_000,
} as const);

export const WORKFLOW_CONTROL_CONTRACT_ERROR_CODES = Object.freeze([
  'WORKFLOW_CONTROL_INVALID',
  'WORKFLOW_CONTROL_UNKNOWN_FIELD',
  'WORKFLOW_CONTROL_LIMIT_EXCEEDED',
  'WORKFLOW_CONTROL_INVALID_TRANSITION',
  'WORKFLOW_CONTROL_APPROVAL_PLANE_MISMATCH',
  'WORKFLOW_CONTROL_SENSITIVE_FIELD_FORBIDDEN',
] as const);
export type WorkflowControlContractErrorCode =
  (typeof WORKFLOW_CONTROL_CONTRACT_ERROR_CODES)[number];

export class WorkflowControlContractError extends Error {
  constructor(
    readonly code: WorkflowControlContractErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowControlContractError';
  }
}

export interface WorkflowControlPhaseObservation {
  readonly phase: string;
  readonly observedAt: string;
  readonly status: WorkflowControlCheckpointState;
  readonly resultHash: string | null;
  readonly cacheKeyHash: string | null;
}

export interface WorkflowControlApprovalCounts {
  readonly pending: number;
  readonly approved: number;
  readonly rejected: number;
}

export interface WorkflowControlApprovalObservation {
  readonly legacyRunGate: {
    readonly plane: 'legacy-run-gate';
    readonly semantics: 'run-gate-only';
    readonly counts: WorkflowControlApprovalCounts;
  };
  readonly effectV2: {
    readonly plane: 'workflow-effect-v2';
    readonly semantics: 'effect-decision-only';
    readonly schema: typeof WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA;
    readonly counts: WorkflowControlApprovalCounts;
  };
}

export interface WorkflowControlBudgetObservation {
  readonly configured: boolean;
  readonly policyHash: string | null;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly costUsd: number | null;
  readonly agentCalls: number;
  readonly warnings: readonly {
    readonly observedAt: string;
    readonly kind: 'threshold' | 'exceeded';
    readonly tokensUsed: number;
    readonly tokenBudget: number;
    readonly percent: number;
    readonly costUsd: number | null;
  }[];
}

export interface WorkflowControlObservation {
  readonly schema: typeof WORKFLOW_CONTROL_OBSERVATION_SCHEMA;
  readonly authority: typeof WORKFLOW_CONTROL_AUTHORITY;
  readonly runId: string;
  readonly workflowName: string;
  readonly mode: WorkflowControlExecutionMode;
  readonly status: WorkflowControlRunState;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly manifestHash: string;
  readonly currentPhase: string | null;
  readonly phases: readonly WorkflowControlPhaseObservation[];
  readonly approvals: WorkflowControlApprovalObservation;
  readonly budget: WorkflowControlBudgetObservation;
}

export interface WorkflowControlReadModel {
  readonly schema: typeof WORKFLOW_CONTROL_READ_MODEL_SCHEMA;
  readonly authority: typeof WORKFLOW_CONTROL_AUTHORITY;
  readonly goRole: typeof WORKFLOW_CONTROL_GO_ROLE;
  readonly authorityEligible: false;
  readonly runId: string;
  readonly workflowName: string;
  readonly mode: WorkflowControlExecutionMode;
  readonly status: WorkflowControlRunState;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly manifestHash: string;
  readonly currentPhase: string | null;
  readonly terminal: boolean;
  readonly phaseCounts: {
    readonly total: number;
    readonly completed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly resultHashBound: number;
    readonly cacheKeyHashBound: number;
  };
  readonly approvals: WorkflowControlApprovalObservation;
  readonly budget: {
    readonly configured: boolean;
    readonly policyHash: string | null;
    readonly tokenBudget: number | null;
    readonly tokensUsed: number;
    readonly costUsd: number | null;
    readonly agentCalls: number;
    readonly warningCounts: { readonly threshold: number; readonly exceeded: number };
  };
  readonly qualificationGaps: typeof WORKFLOW_CONTROL_QUALIFICATION_GAPS;
  readonly observationHash: string;
}

type DataRecord = Record<string, unknown>;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SENSITIVE_RAW_FIELDS = new Set([
  'args',
  'result',
  'detail',
  'capability',
  'decision',
  'evidence',
  'attestationNonce',
  'nonce',
  'token',
  'secret',
  'prompt',
  'output',
]);

function fail(code: WorkflowControlContractErrorCode, path: string, message: string): never {
  throw new WorkflowControlContractError(code, path, message);
}

function assertInert(value: unknown, path: string): void {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    if (nodeTypes.isProxy(value))
      fail('WORKFLOW_CONTROL_INVALID', path, `${path} cannot be a Proxy.`);
  }
}

function rejectSensitiveRawFields(value: unknown, path = '$', seen = new Set<object>()): void {
  assertInert(value, path);
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) fail('WORKFLOW_CONTROL_INVALID', path, `${path} cannot contain cycles.`);
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail('WORKFLOW_CONTROL_INVALID', path, `${path} cannot contain symbol fields.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail('WORKFLOW_CONTROL_INVALID', `${path}/${key}`, 'Accessors are forbidden.');
    }
    if (SENSITIVE_RAW_FIELDS.has(key)) {
      fail(
        'WORKFLOW_CONTROL_SENSITIVE_FIELD_FORBIDDEN',
        `${path}/${key}`,
        `Raw field ${key} is forbidden; export only hashes or counts.`,
      );
    }
    rejectSensitiveRawFields(descriptor.value, `${path}/${key}`, seen);
  }
  seen.delete(value);
}

function closedRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): DataRecord {
  assertInert(value, path);
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail('WORKFLOW_CONTROL_INVALID', path, `${path} must be an inert object.`);
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      fail('WORKFLOW_CONTROL_INVALID', `${path}/${field}`, `Required field ${field} is missing.`);
    }
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail('WORKFLOW_CONTROL_UNKNOWN_FIELD', `${path}/${String(key)}`, 'Unknown field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(
        'WORKFLOW_CONTROL_INVALID',
        `${path}/${key}`,
        'Only enumerable data fields are allowed.',
      );
    }
  }
  return value as DataRecord;
}

function own(record: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function denseArray(value: unknown, maximum: number, path: string): readonly unknown[] {
  assertInert(value, path);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return fail('WORKFLOW_CONTROL_INVALID', path, `${path} must be a dense array.`);
  }
  if (value.length > maximum) {
    return fail('WORKFLOW_CONTROL_LIMIT_EXCEEDED', path, `${path} exceeds its item limit.`);
  }
  const expected = new Set(['length']);
  for (let index = 0; index < value.length; index += 1) {
    expected.add(String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail('WORKFLOW_CONTROL_INVALID', `${path}/${index}`, `${path} must be dense.`);
    }
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !expected.has(key))) {
    return fail('WORKFLOW_CONTROL_INVALID', path, `${path} cannot contain named fields.`);
  }
  return value;
}

function text(value: unknown, path: string, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    return fail('WORKFLOW_CONTROL_INVALID', path, `${path} is invalid.`);
  }
  return value;
}

function hash(value: unknown, path: string): string {
  return text(value, path, 64, HASH);
}

function nullableHash(value: unknown, path: string): string | null {
  return value === null ? null : hash(value, path);
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path, 24, CANONICAL_TIMESTAMP);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(Date.parse(result)).toISOString() !== result
  ) {
    return fail('WORKFLOW_CONTROL_INVALID', path, `${path} must be canonical RFC3339.`);
  }
  return result;
}

function numberInRange(value: unknown, path: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    return fail('WORKFLOW_CONTROL_INVALID', path, `${path} is outside its numeric bounds.`);
  }
  return value;
}

function integer(
  value: unknown,
  path: string,
  maximum: number = WORKFLOW_CONTROL_CONTRACT_LIMITS.maxCount,
): number {
  const result = numberInRange(value, path, maximum);
  if (!Number.isSafeInteger(result)) {
    return fail('WORKFLOW_CONTROL_INVALID', path, `${path} must be a safe integer.`);
  }
  return result;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return fail('WORKFLOW_CONTROL_INVALID', path, `${path} is outside the closed vocabulary.`);
  }
  return value as T;
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(immutable);
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach(immutable);
  return Object.freeze(value);
}

function approvalCounts(value: unknown, path: string): WorkflowControlApprovalCounts {
  const record = closedRecord(value, WORKFLOW_CONTROL_APPROVAL_STATES, [], path);
  return immutable({
    pending: integer(own(record, 'pending'), `${path}/pending`),
    approved: integer(own(record, 'approved'), `${path}/approved`),
    rejected: integer(own(record, 'rejected'), `${path}/rejected`),
  });
}

function approvals(value: unknown): WorkflowControlApprovalObservation {
  const record = closedRecord(value, ['legacyRunGate', 'effectV2'], [], '$/approvals');
  const legacy = closedRecord(
    own(record, 'legacyRunGate'),
    ['plane', 'semantics', 'counts'],
    [],
    '$/approvals/legacyRunGate',
  );
  const effect = closedRecord(
    own(record, 'effectV2'),
    ['plane', 'semantics', 'schema', 'counts'],
    [],
    '$/approvals/effectV2',
  );
  if (own(legacy, 'plane') !== 'legacy-run-gate' || own(legacy, 'semantics') !== 'run-gate-only') {
    return fail(
      'WORKFLOW_CONTROL_APPROVAL_PLANE_MISMATCH',
      '$/approvals/legacyRunGate',
      'Legacy pending approvals are run gates, not effect decisions.',
    );
  }
  if (
    own(effect, 'plane') !== 'workflow-effect-v2' ||
    own(effect, 'semantics') !== 'effect-decision-only' ||
    own(effect, 'schema') !== WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA
  ) {
    return fail(
      'WORKFLOW_CONTROL_APPROVAL_PLANE_MISMATCH',
      '$/approvals/effectV2',
      'Effect decisions require the workflow_effect_approval.v2 plane.',
    );
  }
  return immutable({
    legacyRunGate: {
      plane: 'legacy-run-gate' as const,
      semantics: 'run-gate-only' as const,
      counts: approvalCounts(own(legacy, 'counts'), '$/approvals/legacyRunGate/counts'),
    },
    effectV2: {
      plane: 'workflow-effect-v2' as const,
      semantics: 'effect-decision-only' as const,
      schema: WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
      counts: approvalCounts(own(effect, 'counts'), '$/approvals/effectV2/counts'),
    },
  });
}

function phase(value: unknown, index: number): WorkflowControlPhaseObservation {
  const path = `$/phases/${index}`;
  const record = closedRecord(
    value,
    ['phase', 'observedAt', 'status', 'resultHash', 'cacheKeyHash'],
    [],
    path,
  );
  return immutable({
    phase: text(
      own(record, 'phase'),
      `${path}/phase`,
      WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseNameBytes,
    ),
    observedAt: timestamp(own(record, 'observedAt'), `${path}/observedAt`),
    status: enumValue(own(record, 'status'), WORKFLOW_CONTROL_CHECKPOINT_STATES, `${path}/status`),
    resultHash: nullableHash(own(record, 'resultHash'), `${path}/resultHash`),
    cacheKeyHash: nullableHash(own(record, 'cacheKeyHash'), `${path}/cacheKeyHash`),
  });
}

function budget(value: unknown): WorkflowControlBudgetObservation {
  const record = closedRecord(
    value,
    ['configured', 'policyHash', 'tokenBudget', 'tokensUsed', 'costUsd', 'agentCalls', 'warnings'],
    [],
    '$/budget',
  );
  if (typeof own(record, 'configured') !== 'boolean') {
    return fail('WORKFLOW_CONTROL_INVALID', '$/budget/configured', 'configured must be boolean.');
  }
  const warningValues = denseArray(
    own(record, 'warnings'),
    WORKFLOW_CONTROL_CONTRACT_LIMITS.maxBudgetWarnings,
    '$/budget/warnings',
  );
  const warnings = warningValues.map((warning, index) => {
    const path = `$/budget/warnings/${index}`;
    const item = closedRecord(
      warning,
      ['observedAt', 'kind', 'tokensUsed', 'tokenBudget', 'percent', 'costUsd'],
      [],
      path,
    );
    return immutable({
      observedAt: timestamp(own(item, 'observedAt'), `${path}/observedAt`),
      kind: enumValue(own(item, 'kind'), ['threshold', 'exceeded'] as const, `${path}/kind`),
      tokensUsed: integer(
        own(item, 'tokensUsed'),
        `${path}/tokensUsed`,
        WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens,
      ),
      tokenBudget: integer(
        own(item, 'tokenBudget'),
        `${path}/tokenBudget`,
        WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens,
      ),
      percent: numberInRange(
        own(item, 'percent'),
        `${path}/percent`,
        WORKFLOW_CONTROL_CONTRACT_LIMITS.maxCount,
      ),
      costUsd:
        own(item, 'costUsd') === null
          ? null
          : numberInRange(
              own(item, 'costUsd'),
              `${path}/costUsd`,
              WORKFLOW_CONTROL_CONTRACT_LIMITS.maxCostUsd,
            ),
    });
  });
  const configured = own(record, 'configured') as boolean;
  const policyHash = nullableHash(own(record, 'policyHash'), '$/budget/policyHash');
  const tokenBudget =
    own(record, 'tokenBudget') === null
      ? null
      : integer(
          own(record, 'tokenBudget'),
          '$/budget/tokenBudget',
          WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens,
        );
  if (!configured && (policyHash !== null || tokenBudget !== null)) {
    return fail(
      'WORKFLOW_CONTROL_INVALID',
      '$/budget',
      'Unconfigured budget cannot advertise a policy hash or token limit.',
    );
  }
  return immutable({
    configured,
    policyHash,
    tokenBudget,
    tokensUsed: integer(
      own(record, 'tokensUsed'),
      '$/budget/tokensUsed',
      WORKFLOW_CONTROL_CONTRACT_LIMITS.maxTokens,
    ),
    costUsd:
      own(record, 'costUsd') === null
        ? null
        : numberInRange(
            own(record, 'costUsd'),
            '$/budget/costUsd',
            WORKFLOW_CONTROL_CONTRACT_LIMITS.maxCostUsd,
          ),
    agentCalls: integer(own(record, 'agentCalls'), '$/budget/agentCalls'),
    warnings: immutable(warnings),
  });
}

export function validateWorkflowControlTransition(
  from: WorkflowControlRunState,
  to: WorkflowControlRunState,
): void {
  const source = enumValue(from, WORKFLOW_CONTROL_RUN_STATES, '$/from');
  const target = enumValue(to, WORKFLOW_CONTROL_RUN_STATES, '$/to');
  if (
    !(WORKFLOW_CONTROL_STATE_TRANSITIONS[source] as readonly WorkflowControlRunState[]).includes(
      target,
    )
  ) {
    fail(
      'WORKFLOW_CONTROL_INVALID_TRANSITION',
      '$/transition',
      `Workflow control transition ${source} -> ${target} is not in the observed table.`,
    );
  }
}

export function validateWorkflowControlObservation(value: unknown): WorkflowControlObservation {
  rejectSensitiveRawFields(value);
  let canonical: string;
  try {
    canonical = canonicalWorkflowEffectJson(value);
  } catch (error) {
    return fail(
      'WORKFLOW_CONTROL_INVALID',
      '$',
      error instanceof Error ? error.message : 'Observation is not canonical JSON data.',
    );
  }
  if (Buffer.byteLength(canonical, 'utf8') > WORKFLOW_CONTROL_CONTRACT_LIMITS.maxObservationBytes) {
    return fail('WORKFLOW_CONTROL_LIMIT_EXCEEDED', '$', 'Observation exceeds its byte limit.');
  }
  const record = closedRecord(
    value,
    [
      'schema',
      'authority',
      'runId',
      'workflowName',
      'mode',
      'status',
      'startedAt',
      'updatedAt',
      'manifestHash',
      'currentPhase',
      'phases',
      'approvals',
      'budget',
    ],
    [],
    '$',
  );
  if (own(record, 'schema') !== WORKFLOW_CONTROL_OBSERVATION_SCHEMA) {
    return fail('WORKFLOW_CONTROL_INVALID', '$/schema', 'Observation schema is unsupported.');
  }
  if (own(record, 'authority') !== WORKFLOW_CONTROL_AUTHORITY) {
    return fail('WORKFLOW_CONTROL_INVALID', '$/authority', 'TypeScript must remain the authority.');
  }
  const phaseValues = denseArray(
    own(record, 'phases'),
    WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseCheckpoints,
    '$/phases',
  );
  const phases = phaseValues.map(phase);
  if (new Set(phases.map((item) => item.phase)).size !== phases.length) {
    return fail('WORKFLOW_CONTROL_INVALID', '$/phases', 'Phase checkpoint names must be unique.');
  }
  const startedAt = timestamp(own(record, 'startedAt'), '$/startedAt');
  const updatedAt = timestamp(own(record, 'updatedAt'), '$/updatedAt');
  if (Date.parse(updatedAt) < Date.parse(startedAt)) {
    return fail('WORKFLOW_CONTROL_INVALID', '$/updatedAt', 'updatedAt cannot precede startedAt.');
  }
  return immutable({
    schema: WORKFLOW_CONTROL_OBSERVATION_SCHEMA,
    authority: WORKFLOW_CONTROL_AUTHORITY,
    runId: text(
      own(record, 'runId'),
      '$/runId',
      WORKFLOW_CONTROL_CONTRACT_LIMITS.maxIdentifierBytes,
      SAFE_ID,
    ),
    workflowName: text(
      own(record, 'workflowName'),
      '$/workflowName',
      WORKFLOW_CONTROL_CONTRACT_LIMITS.maxWorkflowNameBytes,
    ),
    mode: enumValue(own(record, 'mode'), WORKFLOW_CONTROL_EXECUTION_MODES, '$/mode'),
    status: enumValue(own(record, 'status'), WORKFLOW_CONTROL_RUN_STATES, '$/status'),
    startedAt,
    updatedAt,
    manifestHash: hash(own(record, 'manifestHash'), '$/manifestHash'),
    currentPhase:
      own(record, 'currentPhase') === null
        ? null
        : text(
            own(record, 'currentPhase'),
            '$/currentPhase',
            WORKFLOW_CONTROL_CONTRACT_LIMITS.maxPhaseNameBytes,
          ),
    phases: immutable(phases),
    approvals: approvals(own(record, 'approvals')),
    budget: budget(own(record, 'budget')),
  });
}

export function canonicalWorkflowControlJson(value: unknown): string {
  return canonicalWorkflowEffectJson(value);
}

export function hashWorkflowControlValue(value: unknown): string {
  return createHash('sha256').update(canonicalWorkflowControlJson(value), 'utf8').digest('hex');
}

export function projectWorkflowControlReadModel(value: unknown): WorkflowControlReadModel {
  const observation = validateWorkflowControlObservation(value);
  const count = (status: WorkflowControlCheckpointState): number =>
    observation.phases.filter((item) => item.status === status).length;
  const warningCount = (kind: 'threshold' | 'exceeded'): number =>
    observation.budget.warnings.filter((item) => item.kind === kind).length;
  return immutable({
    schema: WORKFLOW_CONTROL_READ_MODEL_SCHEMA,
    authority: WORKFLOW_CONTROL_AUTHORITY,
    goRole: WORKFLOW_CONTROL_GO_ROLE,
    authorityEligible: false as const,
    runId: observation.runId,
    workflowName: observation.workflowName,
    mode: observation.mode,
    status: observation.status,
    startedAt: observation.startedAt,
    updatedAt: observation.updatedAt,
    manifestHash: observation.manifestHash,
    currentPhase: observation.currentPhase,
    terminal: ['completed', 'failed', 'cancelled'].includes(observation.status),
    phaseCounts: {
      total: observation.phases.length,
      completed: count('completed'),
      failed: count('failed'),
      skipped: count('skipped'),
      resultHashBound: observation.phases.filter((item) => item.resultHash !== null).length,
      cacheKeyHashBound: observation.phases.filter((item) => item.cacheKeyHash !== null).length,
    },
    approvals: observation.approvals,
    budget: {
      configured: observation.budget.configured,
      policyHash: observation.budget.policyHash,
      tokenBudget: observation.budget.tokenBudget,
      tokensUsed: observation.budget.tokensUsed,
      costUsd: observation.budget.costUsd,
      agentCalls: observation.budget.agentCalls,
      warningCounts: { threshold: warningCount('threshold'), exceeded: warningCount('exceeded') },
    },
    qualificationGaps: WORKFLOW_CONTROL_QUALIFICATION_GAPS,
    observationHash: hashWorkflowControlValue(observation),
  });
}
