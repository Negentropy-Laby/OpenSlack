import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type {
  ConfirmationPolicy,
  WorkflowApprovalManifest,
  WorkflowMeta,
  WorkflowSource,
} from './types.js';
import { canonicalWorkflowEffectJson } from './workflow-effect-json.js';

export const WORKFLOW_RUNNER_DESCRIPTOR_SCHEMA =
  'openslack.workflow_runner_execution_descriptor.v1' as const;

export const WORKFLOW_RUNNER_DESCRIPTOR_SOURCES = Object.freeze([
  'openslack-project',
  'claude-project',
  'claude-user',
  'builtin',
] as const satisfies readonly WorkflowSource[]);

export const WORKFLOW_RUNNER_DESCRIPTOR_LIMITS = Object.freeze({
  maxDescriptorBytes: 1024 * 1024,
  maxInputBytes: 512 * 1024,
  maxEffects: 256,
  maxStringBytes: 2_048,
  maxLifetimeMs: 24 * 60 * 60 * 1_000,
} as const);

export interface WorkflowRunnerExecutionBudget {
  readonly tokens: number;
  readonly costUsd: number;
}

export interface WorkflowRunnerExecutionDescriptor {
  readonly schema: typeof WORKFLOW_RUNNER_DESCRIPTOR_SCHEMA;
  readonly descriptorRef: string;
  readonly workspaceId: string;
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSource: WorkflowSource;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly budget: WorkflowRunnerExecutionBudget;
  readonly confirmationPolicy: ConfirmationPolicy;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CreateWorkflowRunnerExecutionDescriptorInput {
  readonly descriptorRef: string;
  readonly workspaceId: string;
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSource: WorkflowSource;
  readonly workflowSourceBytes: Uint8Array;
  readonly manifest: WorkflowMeta;
  readonly input: Readonly<Record<string, unknown>>;
  readonly budget: WorkflowRunnerExecutionBudget;
  readonly confirmationPolicy: ConfirmationPolicy;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export class WorkflowRunnerDescriptorError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_DESCRIPTOR_INVALID'
      | 'WORKFLOW_RUNNER_DESCRIPTOR_EXPIRED'
      | 'WORKFLOW_RUNNER_DESCRIPTOR_HASH_MISMATCH'
      | 'WORKFLOW_RUNNER_DESCRIPTOR_LIMIT_EXCEEDED',
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowRunnerDescriptorError';
  }
}

type JsonRecord = Record<string, unknown>;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function fail(code: WorkflowRunnerDescriptorError['code'], path: string, message: string): never {
  throw new WorkflowRunnerDescriptorError(code, path, message);
}

function closedRecord(value: unknown, fields: readonly string[], path: string): JsonRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail('WORKFLOW_RUNNER_DESCRIPTOR_INVALID', path, `${path} must be an inert object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      path,
      `${path} has missing or unknown fields.`,
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return fail(
        'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
        `${path}/${String(key)}`,
        `${path} must contain only enumerable data fields.`,
      );
    }
  }
  return value as JsonRecord;
}

function closedRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): JsonRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail('WORKFLOW_RUNNER_DESCRIPTOR_INVALID', path, `${path} must be an inert object.`);
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (
    required.some((field) => !Object.hasOwn(value, field)) ||
    keys.some((key) => typeof key !== 'string' || !allowed.has(key))
  ) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      path,
      `${path} has missing or unknown fields.`,
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return fail(
        'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
        `${path}/${String(key)}`,
        `${path} must contain only enumerable data fields.`,
      );
    }
  }
  return value as JsonRecord;
}

function own(record: JsonRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function stringValue(value: unknown, path: string, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > WORKFLOW_RUNNER_DESCRIPTOR_LIMITS.maxStringBytes ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    return fail('WORKFLOW_RUNNER_DESCRIPTOR_INVALID', path, `${path} is invalid.`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  return stringValue(value, path, SAFE_ID);
}

function hash(value: unknown, path: string): string {
  return stringValue(value, path, HASH);
}

function timestamp(value: unknown, path: string): string {
  const result = stringValue(value, path, TIMESTAMP);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    return fail('WORKFLOW_RUNNER_DESCRIPTOR_INVALID', path, `${path} must be canonical RFC3339.`);
  }
  return result;
}

function safeNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fail('WORKFLOW_RUNNER_DESCRIPTOR_INVALID', path, `${path} is invalid.`);
  }
  return value;
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(immutable);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(immutable);
  return Object.freeze(value);
}

function canonicalData(value: unknown, path: string, maximum: number): unknown {
  let canonical: string;
  try {
    canonical = canonicalWorkflowEffectJson(value);
  } catch (error) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      path,
      `${path} must be canonical JSON data: ${(error as Error).message}`,
    );
  }
  if (Buffer.byteLength(canonical, 'utf8') > maximum) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_LIMIT_EXCEEDED',
      path,
      `${path} exceeds its byte limit.`,
    );
  }
  return JSON.parse(canonical) as unknown;
}

function validateApprovalManifest(value: unknown, runId: string): WorkflowApprovalManifest {
  const record = closedRecord(
    value,
    [
      'workflowName',
      'runId',
      'actorId',
      'workflowHash',
      'inputHash',
      'risk',
      'approvedAt',
      'expiresAt',
      'approvedEffects',
    ],
    '$/confirmationPolicy/approvalManifest',
  );
  if (own(record, 'runId') !== runId) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      '$/confirmationPolicy/approvalManifest/runId',
      'Approval manifest must bind the descriptor workflow run.',
    );
  }
  const effects = own(record, 'approvedEffects');
  if (
    !Array.isArray(effects) ||
    nodeTypes.isProxy(effects) ||
    effects.length > WORKFLOW_RUNNER_DESCRIPTOR_LIMITS.maxEffects
  ) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      '$/confirmationPolicy/approvalManifest/approvedEffects',
      'Approved effects must be a bounded dense array.',
    );
  }
  for (let index = 0; index < effects.length; index += 1) {
    const effect = closedRecordWithOptional(
      effects[index],
      ['kind', 'risk', 'summary'],
      ['objectHint'],
      `$/confirmationPolicy/approvalManifest/approvedEffects/${index}`,
    );
    stringValue(
      own(effect, 'kind'),
      `$/confirmationPolicy/approvalManifest/approvedEffects/${index}/kind`,
    );
    stringValue(
      own(effect, 'summary'),
      `$/confirmationPolicy/approvalManifest/approvedEffects/${index}/summary`,
    );
    if (!['low', 'medium', 'high'].includes(String(own(effect, 'risk')))) {
      return fail(
        'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
        `$/confirmationPolicy/approvalManifest/approvedEffects/${index}/risk`,
        'Approved effect risk is invalid.',
      );
    }
    if (Object.hasOwn(effect, 'objectHint')) {
      stringValue(
        own(effect, 'objectHint'),
        `$/confirmationPolicy/approvalManifest/approvedEffects/${index}/objectHint`,
      );
    }
  }
  stringValue(own(record, 'workflowName'), '$/confirmationPolicy/approvalManifest/workflowName');
  identifier(own(record, 'runId'), '$/confirmationPolicy/approvalManifest/runId');
  identifier(own(record, 'actorId'), '$/confirmationPolicy/approvalManifest/actorId');
  stringValue(own(record, 'workflowHash'), '$/confirmationPolicy/approvalManifest/workflowHash');
  stringValue(own(record, 'inputHash'), '$/confirmationPolicy/approvalManifest/inputHash');
  if (!['low', 'medium', 'high'].includes(String(own(record, 'risk')))) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      '$/confirmationPolicy/approvalManifest/risk',
      'Approval manifest risk is invalid.',
    );
  }
  timestamp(own(record, 'approvedAt'), '$/confirmationPolicy/approvalManifest/approvedAt');
  timestamp(own(record, 'expiresAt'), '$/confirmationPolicy/approvalManifest/expiresAt');
  return canonicalData(
    record,
    '$/confirmationPolicy/approvalManifest',
    WORKFLOW_RUNNER_DESCRIPTOR_LIMITS.maxInputBytes,
  ) as WorkflowApprovalManifest;
}

function validateConfirmationPolicy(value: unknown, runId: string): ConfirmationPolicy {
  const record = closedRecordWithOptional(
    value,
    ['mode', 'actorId', 'runId'],
    ['approvalManifest', 'allowUnattended', 'onUnexpectedEffect'],
    '$/confirmationPolicy',
  );
  const mode = own(record, 'mode');
  if (mode !== 'preapproved-manifest' && mode !== 'unattended-explicit') {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      '$/confirmationPolicy/mode',
      'Worker descriptors accept only sealed non-interactive confirmation modes.',
    );
  }
  identifier(own(record, 'actorId'), '$/confirmationPolicy/actorId');
  if (own(record, 'runId') !== runId) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      '$/confirmationPolicy/runId',
      'Confirmation policy must bind the descriptor workflow run.',
    );
  }
  if (mode === 'preapproved-manifest' && !Object.hasOwn(record, 'approvalManifest')) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      '$/confirmationPolicy/approvalManifest',
      'Preapproved mode requires an approval manifest.',
    );
  }
  if (mode === 'unattended-explicit' && own(record, 'allowUnattended') !== true) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      '$/confirmationPolicy/allowUnattended',
      'Unattended mode must be explicitly enabled in the sealed descriptor.',
    );
  }
  if (Object.hasOwn(record, 'approvalManifest')) {
    validateApprovalManifest(own(record, 'approvalManifest'), runId);
  }
  if (
    Object.hasOwn(record, 'onUnexpectedEffect') &&
    !['pause', 'fail'].includes(String(own(record, 'onUnexpectedEffect')))
  ) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      '$/confirmationPolicy/onUnexpectedEffect',
      'Unexpected-effect policy is invalid.',
    );
  }
  return canonicalData(
    record,
    '$/confirmationPolicy',
    WORKFLOW_RUNNER_DESCRIPTOR_LIMITS.maxInputBytes,
  ) as ConfirmationPolicy;
}

export function hashWorkflowRunnerDomain(domain: string, value: string | Uint8Array): string {
  const prefix = Buffer.from(`openslack.workflow-runner.${domain}.v1\0`, 'utf8');
  return createHash('sha256').update(prefix).update(value).digest('hex');
}

export function hashWorkflowRunnerSource(source: Uint8Array): string {
  return hashWorkflowRunnerDomain('workflow-source', source);
}

export function hashWorkflowRunnerManifest(manifest: WorkflowMeta): string {
  return hashWorkflowRunnerDomain('workflow-manifest', canonicalWorkflowEffectJson(manifest));
}

export function hashWorkflowRunnerInput(input: Readonly<Record<string, unknown>>): string {
  return hashWorkflowRunnerDomain('workflow-input', canonicalWorkflowEffectJson(input));
}

export function hashWorkflowRunnerResult(result: unknown): string {
  return hashWorkflowRunnerDomain('workflow-result', canonicalWorkflowEffectJson(result));
}

export function hashWorkflowRunnerEffect(value: unknown): string {
  return hashWorkflowRunnerDomain('workflow-effect', canonicalWorkflowEffectJson(value));
}

export function canonicalWorkflowRunnerDescriptorJson(
  descriptor: WorkflowRunnerExecutionDescriptor,
): string {
  return canonicalWorkflowEffectJson(validateWorkflowRunnerExecutionDescriptor(descriptor));
}

export function hashWorkflowRunnerDescriptor(
  descriptor: WorkflowRunnerExecutionDescriptor,
): string {
  return hashWorkflowRunnerDomain(
    'execution-descriptor',
    canonicalWorkflowRunnerDescriptorJson(descriptor),
  );
}

export function validateWorkflowRunnerExecutionDescriptor(
  value: unknown,
  now?: string,
): WorkflowRunnerExecutionDescriptor {
  const record = closedRecord(
    value,
    [
      'schema',
      'descriptorRef',
      'workspaceId',
      'workflowRunId',
      'correlationId',
      'workflowId',
      'workflowVersion',
      'workflowSource',
      'workflowSourceHash',
      'manifestHash',
      'inputHash',
      'input',
      'budget',
      'confirmationPolicy',
      'createdAt',
      'expiresAt',
    ],
    '$',
  );
  if (own(record, 'schema') !== WORKFLOW_RUNNER_DESCRIPTOR_SCHEMA) {
    return fail('WORKFLOW_RUNNER_DESCRIPTOR_INVALID', '$/schema', 'Descriptor schema is invalid.');
  }
  const descriptorRef = identifier(own(record, 'descriptorRef'), '$/descriptorRef');
  const workspaceId = identifier(own(record, 'workspaceId'), '$/workspaceId');
  const workflowRunId = identifier(own(record, 'workflowRunId'), '$/workflowRunId');
  const correlationId = identifier(own(record, 'correlationId'), '$/correlationId');
  const workflowId = identifier(own(record, 'workflowId'), '$/workflowId');
  const workflowVersion = stringValue(own(record, 'workflowVersion'), '$/workflowVersion', SEMVER);
  const workflowSource = own(record, 'workflowSource');
  if (!WORKFLOW_RUNNER_DESCRIPTOR_SOURCES.includes(workflowSource as WorkflowSource)) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      '$/workflowSource',
      'Workflow source is outside the closed vocabulary.',
    );
  }
  const workflowSourceHash = hash(own(record, 'workflowSourceHash'), '$/workflowSourceHash');
  const manifestHash = hash(own(record, 'manifestHash'), '$/manifestHash');
  const inputHash = hash(own(record, 'inputHash'), '$/inputHash');
  const input = canonicalData(
    own(record, 'input'),
    '$/input',
    WORKFLOW_RUNNER_DESCRIPTOR_LIMITS.maxInputBytes,
  );
  if (Array.isArray(input) || input === null || typeof input !== 'object') {
    return fail('WORKFLOW_RUNNER_DESCRIPTOR_INVALID', '$/input', 'Input must be a JSON object.');
  }
  if (hashWorkflowRunnerInput(input as Readonly<Record<string, unknown>>) !== inputHash) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_HASH_MISMATCH',
      '$/inputHash',
      'Input hash does not match the canonical input.',
    );
  }
  const budgetRecord = closedRecord(own(record, 'budget'), ['tokens', 'costUsd'], '$/budget');
  const budget = immutable({
    tokens: safeNumber(own(budgetRecord, 'tokens'), '$/budget/tokens'),
    costUsd: safeNumber(own(budgetRecord, 'costUsd'), '$/budget/costUsd'),
  });
  const confirmationPolicy = validateConfirmationPolicy(
    own(record, 'confirmationPolicy'),
    workflowRunId,
  );
  const createdAt = timestamp(own(record, 'createdAt'), '$/createdAt');
  const expiresAt = timestamp(own(record, 'expiresAt'), '$/expiresAt');
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > WORKFLOW_RUNNER_DESCRIPTOR_LIMITS.maxLifetimeMs) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_INVALID',
      '$/expiresAt',
      'Descriptor expiry is outside the bounded lifetime.',
    );
  }
  if (now !== undefined) {
    const current = timestamp(now, '$/now');
    if (
      Date.parse(current) < Date.parse(createdAt) ||
      Date.parse(current) >= Date.parse(expiresAt)
    ) {
      return fail(
        'WORKFLOW_RUNNER_DESCRIPTOR_EXPIRED',
        '$/expiresAt',
        'Descriptor is not active at the supplied time.',
      );
    }
  }
  const descriptor = immutable({
    schema: WORKFLOW_RUNNER_DESCRIPTOR_SCHEMA,
    descriptorRef,
    workspaceId,
    workflowRunId,
    correlationId,
    workflowId,
    workflowVersion,
    workflowSource: workflowSource as WorkflowSource,
    workflowSourceHash,
    manifestHash,
    inputHash,
    input: input as Readonly<Record<string, unknown>>,
    budget,
    confirmationPolicy,
    createdAt,
    expiresAt,
  });
  if (
    Buffer.byteLength(canonicalWorkflowEffectJson(descriptor), 'utf8') >
    WORKFLOW_RUNNER_DESCRIPTOR_LIMITS.maxDescriptorBytes
  ) {
    return fail(
      'WORKFLOW_RUNNER_DESCRIPTOR_LIMIT_EXCEEDED',
      '$',
      'Descriptor exceeds its byte limit.',
    );
  }
  return descriptor;
}

export function createWorkflowRunnerExecutionDescriptor(
  input: CreateWorkflowRunnerExecutionDescriptorInput,
): WorkflowRunnerExecutionDescriptor {
  return validateWorkflowRunnerExecutionDescriptor({
    schema: WORKFLOW_RUNNER_DESCRIPTOR_SCHEMA,
    descriptorRef: input.descriptorRef,
    workspaceId: input.workspaceId,
    workflowRunId: input.workflowRunId,
    correlationId: input.correlationId,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    workflowSource: input.workflowSource,
    workflowSourceHash: hashWorkflowRunnerSource(input.workflowSourceBytes),
    manifestHash: hashWorkflowRunnerManifest(input.manifest),
    inputHash: hashWorkflowRunnerInput(input.input),
    input: input.input,
    budget: input.budget,
    confirmationPolicy: input.confirmationPolicy,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}

export function assertWorkflowRunnerDescriptorOfferBinding(
  descriptor: WorkflowRunnerExecutionDescriptor,
  offer: {
    readonly workspaceId: string;
    readonly workflowRunId: string;
    readonly correlationId: string;
    readonly executionDescriptorRef: string;
    readonly executionDescriptorHash: string;
    readonly workflowId: string;
    readonly workflowVersion: string;
    readonly workflowSourceHash: string;
    readonly manifestHash: string;
    readonly inputHash: string;
  },
): void {
  const expected = {
    workspaceId: descriptor.workspaceId,
    workflowRunId: descriptor.workflowRunId,
    correlationId: descriptor.correlationId,
    executionDescriptorRef: descriptor.descriptorRef,
    executionDescriptorHash: hashWorkflowRunnerDescriptor(descriptor),
    workflowId: descriptor.workflowId,
    workflowVersion: descriptor.workflowVersion,
    workflowSourceHash: descriptor.workflowSourceHash,
    manifestHash: descriptor.manifestHash,
    inputHash: descriptor.inputHash,
  } as const;
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (offer[field as keyof typeof offer] !== expectedValue) {
      fail(
        'WORKFLOW_RUNNER_DESCRIPTOR_HASH_MISMATCH',
        `$/offer/${field}`,
        `Lease offer ${field} does not match the sealed descriptor.`,
      );
    }
  }
}
