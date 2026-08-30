import { createHash } from 'node:crypto';
import type { ConfirmationPolicy, WorkflowMeta, WorkflowSource } from './types.js';
import { closedDataRecord, ownDataField } from './internal/contract-validation.js';
import { canonicalWorkflowEffectJson } from './workflow-effect-json.js';
import type { WorkflowRunnerDescriptorCodec } from './workflow-runner-descriptor-store.js';
import {
  WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
  validateWorkflowControlAuthorityRoute,
  type WorkflowControlAuthorityRoute,
} from './workflow-control-authority-contract.js';
import {
  isWorkflowRunnerCapabilitySet,
  WORKFLOW_RUNNER_CAPABILITIES,
} from './workflow-runner-contract.js';

export type WorkflowRunnerV2Capability = (typeof WORKFLOW_RUNNER_CAPABILITIES)[number];

export const WORKFLOW_RUNNER_V2_DESCRIPTOR_SCHEMA =
  'openslack.workflow_runner_execution_descriptor.v2' as const;

export const WORKFLOW_RUNNER_V2_DESCRIPTOR_LIMITS = Object.freeze({
  maxDescriptorBytes: 1024 * 1024,
  maxInputBytes: 512 * 1024,
  maxStringBytes: 2_048,
  maxLifetimeMs: 24 * 60 * 60 * 1_000,
} as const);

export interface WorkflowRunnerV2BudgetPolicyBinding {
  readonly accountId: string;
  readonly policyHash: string;
  readonly rateNanoUsdPerToken: string;
  readonly tokenLimit: string;
  readonly costLimitNanoUsd: string;
  readonly callLimit: string;
}

export interface WorkflowRunnerV2ExecutionDescriptor {
  readonly schema: typeof WORKFLOW_RUNNER_V2_DESCRIPTOR_SCHEMA;
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
  readonly confirmationPolicy: ConfirmationPolicy;
  readonly requiredProtocolVersion: typeof WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION;
  readonly requiredCapabilities: readonly WorkflowRunnerV2Capability[];
  readonly authorityRoute: WorkflowControlAuthorityRoute;
  readonly runRevision: number;
  readonly resumeGeneration: number;
  readonly budgetPolicy: WorkflowRunnerV2BudgetPolicyBinding;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CreateWorkflowRunnerV2ExecutionDescriptorInput {
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
  readonly confirmationPolicy: ConfirmationPolicy;
  readonly requiredCapabilities: readonly WorkflowRunnerV2Capability[];
  readonly authorityRoute: WorkflowControlAuthorityRoute;
  readonly runRevision: number;
  readonly resumeGeneration: number;
  readonly budgetPolicy: WorkflowRunnerV2BudgetPolicyBinding;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export class WorkflowRunnerV2DescriptorError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID'
      | 'WORKFLOW_RUNNER_V2_DESCRIPTOR_HASH_MISMATCH'
      | 'WORKFLOW_RUNNER_V2_DESCRIPTOR_EXPIRED'
      | 'WORKFLOW_RUNNER_V2_DESCRIPTOR_LIMIT_EXCEEDED'
      | 'WORKFLOW_RUNNER_V2_ADMISSION_BINDING_MISMATCH',
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowRunnerV2DescriptorError';
  }
}

type JsonRecord = Record<string, unknown>;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const DECIMAL_RATE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,17}[1-9])?$/u;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const SOURCES = Object.freeze([
  'openslack-project',
  'claude-project',
  'claude-user',
  'builtin',
] as const satisfies readonly WorkflowSource[]);

function fail(code: WorkflowRunnerV2DescriptorError['code'], path: string, message: string): never {
  throw new WorkflowRunnerV2DescriptorError(code, path, message);
}

function record(value: unknown, fields: readonly string[], path: string): JsonRecord {
  return closedDataRecord(value, fields, path, {
    inert: (failurePath) =>
      fail(
        'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
        failurePath,
        `${failurePath} must be an inert object.`,
      ),
    missing: (failurePath) =>
      fail(
        'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
        failurePath,
        `${failurePath} has missing or unknown fields.`,
      ),
    unknown: (failurePath) =>
      fail(
        'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
        failurePath,
        `${failurePath} has missing or unknown fields.`,
      ),
    dataField: (failurePath, key) =>
      fail(
        'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
        `${failurePath}/${String(key)}`,
        `${failurePath} must contain only enumerable data fields.`,
      ),
  });
}

function own(value: JsonRecord, key: string): unknown {
  return ownDataField(value, key);
}

function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID', path, `${path} is invalid.`);
  }
  return value;
}

function hash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID', path, `${path} must be a SHA-256 hash.`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID', path, `${path} is outside its range.`);
  }
  return value as number;
}

function timestamp(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID', path, `${path} is not canonical UTC.`);
  }
  return value;
}

function decimal(value: unknown, path: string, rate = false): string {
  if (typeof value !== 'string' || !(rate ? DECIMAL_RATE : DECIMAL_INTEGER).test(value)) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID', path, `${path} is not canonical decimal.`);
  }
  if (!rate && BigInt(value) > MAX_INT64) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID', path, `${path} exceeds int64.`);
  }
  return value;
}

function route(value: unknown): WorkflowControlAuthorityRoute {
  try {
    return validateWorkflowControlAuthorityRoute(value, '$/authorityRoute');
  } catch {
    return fail(
      'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
      '$/authorityRoute',
      'Authority route is inconsistent.',
    );
  }
}

function capabilities(value: unknown): readonly WorkflowRunnerV2Capability[] {
  if (!isWorkflowRunnerCapabilitySet(value)) {
    return fail(
      'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
      '$/requiredCapabilities',
      'Required capabilities must match the frozen qualification set.',
    );
  }
  return Object.freeze([...WORKFLOW_RUNNER_CAPABILITIES]);
}

function deepFreezeCanonicalData<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeCanonicalData(entry);
  } else {
    for (const entry of Object.values(value)) deepFreezeCanonicalData(entry);
  }
  return Object.freeze(value);
}

function canonicalData(value: unknown, path: string): unknown {
  let canonical: string;
  try {
    canonical = canonicalWorkflowEffectJson(value);
  } catch (error) {
    return fail(
      'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
      path,
      `${path} is not strict JSON: ${error instanceof Error ? error.message : 'invalid'}`,
    );
  }
  if (Buffer.byteLength(canonical, 'utf8') > WORKFLOW_RUNNER_V2_DESCRIPTOR_LIMITS.maxInputBytes) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_LIMIT_EXCEEDED', path, `${path} is too large.`);
  }
  return deepFreezeCanonicalData(JSON.parse(canonical) as unknown);
}

function confirmationPolicy(value: unknown, runId: string): ConfirmationPolicy {
  const canonical = canonicalData(value, '$/confirmationPolicy');
  if (canonical === null || typeof canonical !== 'object' || Array.isArray(canonical)) {
    return fail(
      'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
      '$/confirmationPolicy',
      'Confirmation policy must be an object.',
    );
  }
  if ((canonical as { runId?: unknown }).runId !== runId) {
    return fail(
      'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
      '$/confirmationPolicy/runId',
      'Confirmation policy must bind the workflow run.',
    );
  }
  return canonical as ConfirmationPolicy;
}

function budgetPolicy(value: unknown): WorkflowRunnerV2BudgetPolicyBinding {
  const item = record(
    value,
    [
      'accountId',
      'policyHash',
      'rateNanoUsdPerToken',
      'tokenLimit',
      'costLimitNanoUsd',
      'callLimit',
    ],
    '$/budgetPolicy',
  );
  const tokenLimit = decimal(own(item, 'tokenLimit'), '$/budgetPolicy/tokenLimit');
  const callLimit = decimal(own(item, 'callLimit'), '$/budgetPolicy/callLimit');
  if (
    BigInt(tokenLimit) > BigInt(Number.MAX_SAFE_INTEGER) ||
    BigInt(callLimit) > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return fail(
      'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
      '$/budgetPolicy',
      'Qualification runtime token and call limits must be safe integers.',
    );
  }
  return Object.freeze({
    accountId: id(own(item, 'accountId'), '$/budgetPolicy/accountId'),
    policyHash: hash(own(item, 'policyHash'), '$/budgetPolicy/policyHash'),
    rateNanoUsdPerToken: decimal(
      own(item, 'rateNanoUsdPerToken'),
      '$/budgetPolicy/rateNanoUsdPerToken',
      true,
    ),
    tokenLimit,
    costLimitNanoUsd: decimal(own(item, 'costLimitNanoUsd'), '$/budgetPolicy/costLimitNanoUsd'),
    callLimit,
  });
}

export function hashWorkflowRunnerV2Domain(domain: string, value: string | Uint8Array): string {
  return createHash('sha256')
    .update(`openslack.workflow-runner.${domain}.v2\0`, 'utf8')
    .update(value)
    .digest('hex');
}

export function hashWorkflowRunnerV2Source(value: Uint8Array): string {
  return hashWorkflowRunnerV2Domain('workflow-source', value);
}

export function hashWorkflowRunnerV2Manifest(value: WorkflowMeta): string {
  return hashWorkflowRunnerV2Domain('workflow-manifest', canonicalWorkflowEffectJson(value));
}

export function hashWorkflowRunnerV2Input(value: Readonly<Record<string, unknown>>): string {
  return hashWorkflowRunnerV2Domain('workflow-input', canonicalWorkflowEffectJson(value));
}

export function hashWorkflowRunnerV2Result(value: unknown): string {
  return hashWorkflowRunnerV2Domain('workflow-result', canonicalWorkflowEffectJson(value));
}

export function canonicalWorkflowRunnerV2DescriptorJson(
  value: WorkflowRunnerV2ExecutionDescriptor,
): string {
  return canonicalWorkflowEffectJson(validateWorkflowRunnerV2ExecutionDescriptor(value));
}

export function hashWorkflowRunnerV2Descriptor(value: WorkflowRunnerV2ExecutionDescriptor): string {
  return hashWorkflowRunnerV2Domain(
    'execution-descriptor',
    canonicalWorkflowRunnerV2DescriptorJson(value),
  );
}

export const WORKFLOW_RUNNER_V2_DESCRIPTOR_CODEC: WorkflowRunnerDescriptorCodec<WorkflowRunnerV2ExecutionDescriptor> =
  Object.freeze({
    validate: validateWorkflowRunnerV2ExecutionDescriptor,
    canonical: canonicalWorkflowRunnerV2DescriptorJson,
    hash: hashWorkflowRunnerV2Descriptor,
  });

export function validateWorkflowRunnerV2ExecutionDescriptor(
  value: unknown,
  now?: string,
): WorkflowRunnerV2ExecutionDescriptor {
  const item = record(
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
      'confirmationPolicy',
      'requiredProtocolVersion',
      'requiredCapabilities',
      'authorityRoute',
      'runRevision',
      'resumeGeneration',
      'budgetPolicy',
      'createdAt',
      'expiresAt',
    ],
    '$',
  );
  if (own(item, 'schema') !== WORKFLOW_RUNNER_V2_DESCRIPTOR_SCHEMA) {
    return fail(
      'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
      '$/schema',
      'Descriptor schema is invalid.',
    );
  }
  if (own(item, 'requiredProtocolVersion') !== WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION) {
    return fail(
      'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
      '$/requiredProtocolVersion',
      'Descriptor must require runner protocol v2.',
    );
  }
  const workflowRunId = id(own(item, 'workflowRunId'), '$/workflowRunId');
  const input = canonicalData(own(item, 'input'), '$/input');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID', '$/input', 'Input must be a JSON object.');
  }
  const inputHash = hash(own(item, 'inputHash'), '$/inputHash');
  if (hashWorkflowRunnerV2Input(input as Readonly<Record<string, unknown>>) !== inputHash) {
    return fail(
      'WORKFLOW_RUNNER_V2_DESCRIPTOR_HASH_MISMATCH',
      '$/inputHash',
      'Input hash does not match canonical input.',
    );
  }
  const createdAt = timestamp(own(item, 'createdAt'), '$/createdAt');
  const expiresAt = timestamp(own(item, 'expiresAt'), '$/expiresAt');
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > WORKFLOW_RUNNER_V2_DESCRIPTOR_LIMITS.maxLifetimeMs) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID', '$/expiresAt', 'Lifetime is invalid.');
  }
  if (now !== undefined) {
    const current = timestamp(now, '$/now');
    if (
      Date.parse(current) < Date.parse(createdAt) ||
      Date.parse(current) >= Date.parse(expiresAt)
    ) {
      return fail(
        'WORKFLOW_RUNNER_V2_DESCRIPTOR_EXPIRED',
        '$/expiresAt',
        'Descriptor is inactive.',
      );
    }
  }
  const workflowSource = own(item, 'workflowSource');
  if (!SOURCES.includes(workflowSource as WorkflowSource)) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID', '$/workflowSource', 'Source is invalid.');
  }
  const workflowVersion = own(item, 'workflowVersion');
  if (typeof workflowVersion !== 'string' || !SEMVER.test(workflowVersion)) {
    return fail(
      'WORKFLOW_RUNNER_V2_DESCRIPTOR_INVALID',
      '$/workflowVersion',
      'Workflow version is invalid.',
    );
  }
  const result = Object.freeze({
    schema: WORKFLOW_RUNNER_V2_DESCRIPTOR_SCHEMA,
    descriptorRef: id(own(item, 'descriptorRef'), '$/descriptorRef'),
    workspaceId: id(own(item, 'workspaceId'), '$/workspaceId'),
    workflowRunId,
    correlationId: id(own(item, 'correlationId'), '$/correlationId'),
    workflowId: id(own(item, 'workflowId'), '$/workflowId'),
    workflowVersion,
    workflowSource: workflowSource as WorkflowSource,
    workflowSourceHash: hash(own(item, 'workflowSourceHash'), '$/workflowSourceHash'),
    manifestHash: hash(own(item, 'manifestHash'), '$/manifestHash'),
    inputHash,
    input: Object.freeze(input as Readonly<Record<string, unknown>>),
    confirmationPolicy: confirmationPolicy(own(item, 'confirmationPolicy'), workflowRunId),
    requiredProtocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    requiredCapabilities: capabilities(own(item, 'requiredCapabilities')),
    authorityRoute: route(own(item, 'authorityRoute')),
    runRevision: integer(own(item, 'runRevision'), '$/runRevision', 1),
    resumeGeneration: integer(own(item, 'resumeGeneration'), '$/resumeGeneration', 0),
    budgetPolicy: budgetPolicy(own(item, 'budgetPolicy')),
    createdAt,
    expiresAt,
  } satisfies WorkflowRunnerV2ExecutionDescriptor);
  if (
    Buffer.byteLength(canonicalWorkflowEffectJson(result), 'utf8') >
    WORKFLOW_RUNNER_V2_DESCRIPTOR_LIMITS.maxDescriptorBytes
  ) {
    return fail('WORKFLOW_RUNNER_V2_DESCRIPTOR_LIMIT_EXCEEDED', '$', 'Descriptor is too large.');
  }
  return result;
}

export function createWorkflowRunnerV2ExecutionDescriptor(
  input: CreateWorkflowRunnerV2ExecutionDescriptorInput,
): WorkflowRunnerV2ExecutionDescriptor {
  return validateWorkflowRunnerV2ExecutionDescriptor({
    schema: WORKFLOW_RUNNER_V2_DESCRIPTOR_SCHEMA,
    descriptorRef: input.descriptorRef,
    workspaceId: input.workspaceId,
    workflowRunId: input.workflowRunId,
    correlationId: input.correlationId,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    workflowSource: input.workflowSource,
    workflowSourceHash: hashWorkflowRunnerV2Source(input.workflowSourceBytes),
    manifestHash: hashWorkflowRunnerV2Manifest(input.manifest),
    inputHash: hashWorkflowRunnerV2Input(input.input),
    input: input.input,
    confirmationPolicy: input.confirmationPolicy,
    requiredProtocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    requiredCapabilities: input.requiredCapabilities,
    authorityRoute: input.authorityRoute,
    runRevision: input.runRevision,
    resumeGeneration: input.resumeGeneration,
    budgetPolicy: input.budgetPolicy,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}

export function assertWorkflowRunnerV2AdmissionBinding(
  descriptor: WorkflowRunnerV2ExecutionDescriptor,
  binding: {
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
    readonly requiredProtocolVersion: string;
    readonly requiredCapabilities: readonly string[];
    readonly authorityRoute: WorkflowControlAuthorityRoute;
    readonly runRevision: number;
    readonly resumeGeneration: number;
  },
): void {
  const expected = {
    workspaceId: descriptor.workspaceId,
    workflowRunId: descriptor.workflowRunId,
    correlationId: descriptor.correlationId,
    executionDescriptorRef: descriptor.descriptorRef,
    executionDescriptorHash: hashWorkflowRunnerV2Descriptor(descriptor),
    workflowId: descriptor.workflowId,
    workflowVersion: descriptor.workflowVersion,
    workflowSourceHash: descriptor.workflowSourceHash,
    manifestHash: descriptor.manifestHash,
    inputHash: descriptor.inputHash,
    requiredProtocolVersion: descriptor.requiredProtocolVersion,
    requiredCapabilities: descriptor.requiredCapabilities,
    authorityRoute: descriptor.authorityRoute,
    runRevision: descriptor.runRevision,
    resumeGeneration: descriptor.resumeGeneration,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (
      canonicalWorkflowEffectJson(binding[field as keyof typeof binding]) !==
      canonicalWorkflowEffectJson(expectedValue)
    ) {
      return fail(
        'WORKFLOW_RUNNER_V2_ADMISSION_BINDING_MISMATCH',
        `$/binding/${field}`,
        `Admission ${field} does not match the sealed descriptor.`,
      );
    }
  }
}
