import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { canonicalWorkflowEffectJson } from './workflow-effect-json.js';
import {
  exactWorkflowRunnerLoopbackOrigin,
  isWorkflowRunnerTransportConfigShape,
  readWorkflowRunnerResponseBytes,
} from './workflow-runner-control-http.js';
import { isWorkflowControlBearerToken } from './workflow-control-routing-identity.js';

export const WORKFLOW_RUNNER_JOB_SPEC_SCHEMA = 'openslack.workflow_runner_job_spec.v1' as const;
export const WORKFLOW_RUNNER_JOB_RECEIPT_SCHEMA =
  'openslack.workflow_runner_job_receipt.v1' as const;
export const WORKFLOW_RUNNER_JOB_VIEW_SCHEMA = 'openslack.workflow_runner_job_view.v1' as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_WHOLE_TIMEOUT_MS = 1_000;
const MAX_WHOLE_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export interface WorkflowRunnerControlConfig {
  readonly origin: string;
  readonly workspaceId: string;
  readonly bearerToken: string;
  readonly descriptorRoot: string;
  readonly expectedBuildHash?: string;
}

export interface WorkflowRunnerJobSpec {
  readonly schema: typeof WORKFLOW_RUNNER_JOB_SPEC_SCHEMA;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly executionDescriptorRef: string;
  readonly executionDescriptorHash: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly wholeTimeoutMs: number;
  readonly submittedAt: string;
}

export interface PreparedWorkflowRunnerJobSpec {
  readonly spec: WorkflowRunnerJobSpec;
  readonly exactBody: string;
  readonly jobSpecHash: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface WorkflowRunnerJobReceipt {
  readonly schema: typeof WORKFLOW_RUNNER_JOB_RECEIPT_SCHEMA;
  readonly status: 'accepted' | 'duplicate' | 'reconciliation_required';
  readonly workspaceId: string;
  readonly jobId: string;
  readonly workflowRunId: string;
  readonly state: 'queued' | 'reconciliation_required';
  readonly revision: number;
  readonly jobSpecHash: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly committedAt: string;
  readonly reconciliationId: string | null;
}

export interface WorkflowRunnerJobView {
  readonly schema: typeof WORKFLOW_RUNNER_JOB_VIEW_SCHEMA;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly state:
    | 'queued'
    | 'offered'
    | 'running'
    | 'cancelling'
    | 'terminal'
    | 'reconciliation_required';
  readonly revision: number;
  readonly fencingToken: number;
  readonly attemptId: string | null;
  readonly leaseId: string | null;
  readonly attemptState:
    | 'offered'
    | 'accepted'
    | 'running'
    | 'cancelling'
    | 'terminal'
    | 'rejected'
    | 'expired'
    | 'crashed'
    | 'reconciliation_required'
    | null;
  readonly leaseExpiresAt: string | null;
  readonly terminalStatus:
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'timed_out'
    | 'reconciliation_required'
    | null;
  readonly terminalReason: string | null;
  readonly resultHash: string | null;
  readonly openEffectCount: number;
  readonly reconciliationId: string | null;
  readonly reconciliationCode: string | null;
  readonly executionStarted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowRunnerControlPort {
  readonly descriptorRoot: string;
  submit(
    prepared: PreparedWorkflowRunnerJobSpec,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerJobReceipt>;
  waitForTerminal(
    jobId: string,
    options: {
      readonly timeoutMs: number;
      readonly pollIntervalMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<WorkflowRunnerJobView>;
}

export class WorkflowRunnerControlError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID'
      | 'WORKFLOW_RUNNER_CONTROL_INPUT_INVALID'
      | 'WORKFLOW_RUNNER_CONTROL_TRANSPORT_FAILED'
      | 'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID'
      | 'WORKFLOW_RUNNER_CONTROL_REJECTED'
      | 'WORKFLOW_RUNNER_CONTROL_TIMEOUT'
      | 'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowRunnerControlError';
  }
}

function fail(
  code: WorkflowRunnerControlError['code'],
  message: string,
  options?: ErrorOptions,
): never {
  throw new WorkflowRunnerControlError(code, message, options);
}

function closedRecord(value: unknown, fields: readonly string[], label: string): JsonRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', `${label} must be an inert object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return fail(
      'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
      `${label} has missing or unknown fields.`,
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail(
        'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
        `${label} must contain only enumerable data fields.`,
      );
    }
  }
  return value as JsonRecord;
}

function own(record: JsonRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', `${label} is invalid.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', `${label} is invalid.`);
  }
  return value as number;
}

function nullable<T>(value: unknown, parse: (item: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function runnerErrorCode(value: unknown): string | undefined {
  try {
    const record = closedRecord(value, ['schema', 'code', 'message'], 'Runner error');
    return own(record, 'schema') === 'openslack.workflow_runner_control_error.v1' &&
      typeof own(record, 'code') === 'string' &&
      typeof own(record, 'message') === 'string'
      ? String(own(record, 'code')).slice(0, 128)
      : undefined;
  } catch {
    return undefined;
  }
}

function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', `${label} is invalid.`);
  }
  return value as T;
}

function validateOrigin(value: string): string {
  return exactWorkflowRunnerLoopbackOrigin(
    value,
    (message, options) => fail('WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID', message, options),
    {
      invalid: 'Runner control origin is invalid.',
      nonLoopback: 'Runner control origin must be an exact loopback HTTP origin.',
    },
  );
}

export function loadWorkflowRunnerControlConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowRunnerControlConfig {
  const names = [
    'OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN',
    'OPENSLACK_WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID',
    'OPENSLACK_WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN',
    'OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT',
  ] as const;
  const missing = names.filter((name) => !environment[name]);
  if (missing.length > 0) {
    return fail(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
      `Workflow runner transport is incomplete; missing ${missing.join(', ')}.`,
    );
  }
  const workspaceId = environment.OPENSLACK_WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID!;
  const bearerToken = environment.OPENSLACK_WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN!;
  const descriptorRoot = environment.OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT!;
  const expectedBuildHash = environment.OPENSLACK_WORKFLOW_RUNNER_CONTROL_BUILD_SHA;
  if (!SAFE_ID.test(workspaceId)) {
    return fail('WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID', 'Runner control workspace is invalid.');
  }
  if (!isWorkflowControlBearerToken(bearerToken)) {
    return fail('WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID', 'Runner control token is invalid.');
  }
  if (!isAbsolute(descriptorRoot) || resolve(descriptorRoot) !== descriptorRoot) {
    return fail(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
      'Runner descriptor root must be a normalized absolute path.',
    );
  }
  if (expectedBuildHash !== undefined && !HASH.test(expectedBuildHash)) {
    return fail(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
      'Runner control expected build hash is invalid.',
    );
  }
  return Object.freeze({
    origin: validateOrigin(environment.OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN!),
    workspaceId,
    bearerToken,
    descriptorRoot,
    ...(expectedBuildHash === undefined ? {} : { expectedBuildHash }),
  });
}

export function validateWorkflowRunnerJobSpec(value: unknown): WorkflowRunnerJobSpec {
  const record = closedRecord(
    value,
    [
      'schema',
      'workspaceId',
      'jobId',
      'workflowRunId',
      'correlationId',
      'executionDescriptorRef',
      'executionDescriptorHash',
      'workflowId',
      'workflowVersion',
      'workflowSourceHash',
      'manifestHash',
      'inputHash',
      'wholeTimeoutMs',
      'submittedAt',
    ],
    'Runner job specification',
  );
  if (own(record, 'schema') !== WORKFLOW_RUNNER_JOB_SPEC_SCHEMA) {
    return fail('WORKFLOW_RUNNER_CONTROL_INPUT_INVALID', 'Runner job schema is unsupported.');
  }
  const wholeTimeoutMs = own(record, 'wholeTimeoutMs');
  if (
    !Number.isSafeInteger(wholeTimeoutMs) ||
    (wholeTimeoutMs as number) < MIN_WHOLE_TIMEOUT_MS ||
    (wholeTimeoutMs as number) > MAX_WHOLE_TIMEOUT_MS
  ) {
    return fail(
      'WORKFLOW_RUNNER_CONTROL_INPUT_INVALID',
      'Runner job whole timeout is outside the closed range.',
    );
  }
  try {
    return Object.freeze({
      schema: WORKFLOW_RUNNER_JOB_SPEC_SCHEMA,
      workspaceId: safeId(own(record, 'workspaceId'), 'workspaceId'),
      jobId: safeId(own(record, 'jobId'), 'jobId'),
      workflowRunId: safeId(own(record, 'workflowRunId'), 'workflowRunId'),
      correlationId: safeId(own(record, 'correlationId'), 'correlationId'),
      executionDescriptorRef: safeId(
        own(record, 'executionDescriptorRef'),
        'executionDescriptorRef',
      ),
      executionDescriptorHash: hash(
        own(record, 'executionDescriptorHash'),
        'executionDescriptorHash',
      ),
      workflowId: safeId(own(record, 'workflowId'), 'workflowId'),
      workflowVersion: safeId(own(record, 'workflowVersion'), 'workflowVersion'),
      workflowSourceHash: hash(own(record, 'workflowSourceHash'), 'workflowSourceHash'),
      manifestHash: hash(own(record, 'manifestHash'), 'manifestHash'),
      inputHash: hash(own(record, 'inputHash'), 'inputHash'),
      wholeTimeoutMs: wholeTimeoutMs as number,
      submittedAt: timestamp(own(record, 'submittedAt'), 'submittedAt'),
    });
  } catch (error) {
    if (error instanceof WorkflowRunnerControlError) {
      throw new WorkflowRunnerControlError('WORKFLOW_RUNNER_CONTROL_INPUT_INVALID', error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

export function prepareWorkflowRunnerJobSpec(value: unknown): PreparedWorkflowRunnerJobSpec {
  const spec = validateWorkflowRunnerJobSpec(value);
  const exactBody = canonicalWorkflowEffectJson(spec);
  const jobSpecHash = createHash('sha256')
    .update('openslack.workflow-runner.job-spec.v1\0', 'utf8')
    .update(exactBody, 'utf8')
    .digest('hex');
  const idempotencyKey = `openslack.workflow-runner-job.v1.${createHash('sha256')
    .update('openslack.workflow-runner-job.idempotency.v1\0', 'utf8')
    .update(exactBody, 'utf8')
    .digest('hex')}`;
  const fingerprintBody = canonicalWorkflowEffectJson({
    schema: 'openslack.workflow_runner_job_fingerprint.v1',
    workspaceId: spec.workspaceId,
    jobId: spec.jobId,
    workflowRunId: spec.workflowRunId,
    jobSpecHash,
  });
  const requestFingerprint = `sha256:${createHash('sha256')
    .update(fingerprintBody, 'utf8')
    .digest('hex')}`;
  return Object.freeze({ spec, exactBody, jobSpecHash, idempotencyKey, requestFingerprint });
}

export function validateWorkflowRunnerJobReceipt(value: unknown): WorkflowRunnerJobReceipt {
  const record = closedRecord(
    value,
    [
      'schema',
      'status',
      'workspaceId',
      'jobId',
      'workflowRunId',
      'state',
      'revision',
      'jobSpecHash',
      'idempotencyKey',
      'requestFingerprint',
      'committedAt',
      'reconciliationId',
    ],
    'Runner job receipt',
  );
  if (own(record, 'schema') !== WORKFLOW_RUNNER_JOB_RECEIPT_SCHEMA) {
    return fail(
      'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
      'Runner job receipt schema is invalid.',
    );
  }
  const result = Object.freeze({
    schema: WORKFLOW_RUNNER_JOB_RECEIPT_SCHEMA,
    status: enumValue(
      own(record, 'status'),
      ['accepted', 'duplicate', 'reconciliation_required'],
      'receipt.status',
    ),
    workspaceId: safeId(own(record, 'workspaceId'), 'receipt.workspaceId'),
    jobId: safeId(own(record, 'jobId'), 'receipt.jobId'),
    workflowRunId: safeId(own(record, 'workflowRunId'), 'receipt.workflowRunId'),
    state: enumValue(own(record, 'state'), ['queued', 'reconciliation_required'], 'receipt.state'),
    revision: integer(own(record, 'revision'), 'receipt.revision', 1),
    jobSpecHash: hash(own(record, 'jobSpecHash'), 'receipt.jobSpecHash'),
    idempotencyKey: String(own(record, 'idempotencyKey')),
    requestFingerprint: String(own(record, 'requestFingerprint')),
    committedAt: timestamp(own(record, 'committedAt'), 'receipt.committedAt'),
    reconciliationId: nullable(own(record, 'reconciliationId'), (item) =>
      safeId(item, 'receipt.reconciliationId'),
    ),
  });
  if (
    !/^openslack\.workflow-runner-job\.v1\.[0-9a-f]{64}$/u.test(result.idempotencyKey) ||
    !/^sha256:[0-9a-f]{64}$/u.test(result.requestFingerprint) ||
    (result.status === 'reconciliation_required') !==
      (result.state === 'reconciliation_required' && result.reconciliationId !== null)
  ) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', 'Runner job receipt is inconsistent.');
  }
  return result;
}

export function validateWorkflowRunnerJobView(value: unknown): WorkflowRunnerJobView {
  const record = closedRecord(
    value,
    [
      'schema',
      'workspaceId',
      'jobId',
      'workflowRunId',
      'correlationId',
      'state',
      'revision',
      'fencingToken',
      'attemptId',
      'leaseId',
      'attemptState',
      'leaseExpiresAt',
      'terminalStatus',
      'terminalReason',
      'resultHash',
      'openEffectCount',
      'reconciliationId',
      'reconciliationCode',
      'executionStarted',
      'createdAt',
      'updatedAt',
    ],
    'Runner job view',
  );
  if (own(record, 'schema') !== WORKFLOW_RUNNER_JOB_VIEW_SCHEMA) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', 'Runner job view schema is invalid.');
  }
  const executionStarted = own(record, 'executionStarted');
  if (typeof executionStarted !== 'boolean') {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', 'job.executionStarted is invalid.');
  }
  const stringOrNull = (key: string) =>
    nullable(own(record, key), (item) => {
      if (typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > 2048) {
        return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', `job.${key} is invalid.`);
      }
      return item;
    });
  const result = Object.freeze({
    schema: WORKFLOW_RUNNER_JOB_VIEW_SCHEMA,
    workspaceId: safeId(own(record, 'workspaceId'), 'job.workspaceId'),
    jobId: safeId(own(record, 'jobId'), 'job.jobId'),
    workflowRunId: safeId(own(record, 'workflowRunId'), 'job.workflowRunId'),
    correlationId: safeId(own(record, 'correlationId'), 'job.correlationId'),
    state: enumValue(
      own(record, 'state'),
      ['queued', 'offered', 'running', 'cancelling', 'terminal', 'reconciliation_required'],
      'job.state',
    ),
    revision: integer(own(record, 'revision'), 'job.revision', 1),
    fencingToken: integer(own(record, 'fencingToken'), 'job.fencingToken'),
    attemptId: nullable(own(record, 'attemptId'), (item) => safeId(item, 'job.attemptId')),
    leaseId: nullable(own(record, 'leaseId'), (item) => safeId(item, 'job.leaseId')),
    attemptState: nullable(own(record, 'attemptState'), (item) =>
      enumValue(
        item,
        [
          'offered',
          'accepted',
          'running',
          'cancelling',
          'terminal',
          'rejected',
          'expired',
          'crashed',
          'reconciliation_required',
        ],
        'job.attemptState',
      ),
    ),
    leaseExpiresAt: nullable(own(record, 'leaseExpiresAt'), (item) =>
      timestamp(item, 'job.leaseExpiresAt'),
    ),
    terminalStatus: nullable(own(record, 'terminalStatus'), (item) =>
      enumValue(
        item,
        ['completed', 'failed', 'cancelled', 'timed_out', 'reconciliation_required'],
        'job.terminalStatus',
      ),
    ),
    terminalReason: stringOrNull('terminalReason'),
    resultHash: nullable(own(record, 'resultHash'), (item) => hash(item, 'job.resultHash')),
    openEffectCount: integer(own(record, 'openEffectCount'), 'job.openEffectCount'),
    reconciliationId: nullable(own(record, 'reconciliationId'), (item) =>
      safeId(item, 'job.reconciliationId'),
    ),
    reconciliationCode: stringOrNull('reconciliationCode'),
    executionStarted,
    createdAt: timestamp(own(record, 'createdAt'), 'job.createdAt'),
    updatedAt: timestamp(own(record, 'updatedAt'), 'job.updatedAt'),
  });
  if (
    (result.state === 'terminal' || result.state === 'reconciliation_required') !==
      (result.terminalStatus !== null) ||
    (result.state === 'reconciliation_required') !==
      (result.terminalStatus === 'reconciliation_required') ||
    (result.terminalStatus === 'completed') !== (result.resultHash !== null) ||
    (result.state === 'reconciliation_required') !== (result.reconciliationId !== null)
  ) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', 'Runner job view is inconsistent.');
  }
  return result;
}

async function readBoundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const bytes = await readWorkflowRunnerResponseBytes(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    signal,
    validateContentLength: false,
    minimumBytes: 0,
    failure: (message, options) =>
      fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', message, options),
    messages: {
      contentType: 'Runner response type is invalid.',
      contentLength: 'Runner response content length is invalid.',
      missingBody: 'Runner response body is missing.',
      readFailed: 'Runner response read failed.',
      exceeded: 'Runner response exceeds its limit.',
      empty: 'Runner response body is empty.',
      lengthMismatch: 'Runner response content length does not match its body.',
      aborted: 'runner response read aborted',
    },
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', 'Runner response is invalid JSON.', {
      cause: error,
    });
  }
  if (`${canonicalWorkflowEffectJson(value)}\n` !== bytes.toString('utf8')) {
    return fail(
      'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
      'Runner response is not canonical JSON.',
    );
  }
  return value;
}

function boundedSignal(
  timeoutMs: number,
  signal?: AbortSignal,
): {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error('runner request timeout'));
  }, timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

export class WorkflowRunnerControlClient implements WorkflowRunnerControlPort {
  readonly #config: WorkflowRunnerControlConfig;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(
    config: WorkflowRunnerControlConfig,
    options: { readonly fetch?: typeof fetch; readonly requestTimeoutMs?: number } = {},
  ) {
    if (!config || typeof config !== 'object' || !SAFE_ID.test(config.workspaceId)) {
      fail('WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID', 'Runner control workspace is invalid.');
    }
    if (!isWorkflowRunnerTransportConfigShape(config)) {
      fail('WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID', 'Runner control configuration is invalid.');
    }
    this.#config = Object.freeze({
      origin: validateOrigin(config.origin),
      workspaceId: config.workspaceId,
      bearerToken: config.bearerToken,
      descriptorRoot: config.descriptorRoot,
    });
    this.#fetch = options.fetch ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1 ||
      this.#requestTimeoutMs > MAX_WHOLE_TIMEOUT_MS
    ) {
      fail('WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID', 'Runner request timeout is invalid.');
    }
  }

  get descriptorRoot(): string {
    return this.#config.descriptorRoot;
  }

  async submit(
    preparedValue: PreparedWorkflowRunnerJobSpec,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerJobReceipt> {
    const prepared = prepareWorkflowRunnerJobSpec(preparedValue.spec);
    if (
      prepared.exactBody !== preparedValue.exactBody ||
      prepared.jobSpecHash !== preparedValue.jobSpecHash ||
      prepared.idempotencyKey !== preparedValue.idempotencyKey ||
      prepared.requestFingerprint !== preparedValue.requestFingerprint
    ) {
      return fail(
        'WORKFLOW_RUNNER_CONTROL_INPUT_INVALID',
        'Prepared runner job binding is invalid.',
      );
    }
    const response = await this.#requestJson(
      '/v1/runner/jobs',
      {
        method: 'POST',
        body: prepared.exactBody,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': prepared.idempotencyKey,
          'X-OpenSlack-Request-Fingerprint': prepared.requestFingerprint,
        },
      },
      signal,
    );
    if (![200, 201, 202].includes(response.status)) return this.#rejected(response);
    const errorCode = runnerErrorCode(response.value);
    if (response.status === 202 && errorCode !== undefined) {
      return fail(
        'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
        `Runner control rejected the request (${errorCode}).`,
      );
    }
    const receipt = validateWorkflowRunnerJobReceipt(response.value);
    if (
      receipt.workspaceId !== this.#config.workspaceId ||
      receipt.jobId !== prepared.spec.jobId ||
      receipt.workflowRunId !== prepared.spec.workflowRunId ||
      receipt.jobSpecHash !== prepared.jobSpecHash ||
      receipt.idempotencyKey !== prepared.idempotencyKey ||
      receipt.requestFingerprint !== prepared.requestFingerprint ||
      (response.status === 200 && receipt.status !== 'duplicate') ||
      (response.status === 201 && receipt.status !== 'accepted') ||
      (response.status === 202 && receipt.status !== 'reconciliation_required')
    ) {
      return fail('WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID', 'Runner receipt binding is invalid.');
    }
    return receipt;
  }

  async readJob(jobIdValue: string, signal?: AbortSignal): Promise<WorkflowRunnerJobView> {
    let jobId: string;
    try {
      jobId = safeId(jobIdValue, 'jobId');
    } catch (error) {
      return fail('WORKFLOW_RUNNER_CONTROL_INPUT_INVALID', 'Runner job identity is invalid.', {
        cause: error,
      });
    }
    const response = await this.#requestJson(
      `/v1/runner/jobs/${encodeURIComponent(jobId)}`,
      { method: 'GET' },
      signal,
    );
    if (response.status !== 200) return this.#rejected(response);
    const view = validateWorkflowRunnerJobView(response.value);
    if (view.workspaceId !== this.#config.workspaceId || view.jobId !== jobId) {
      return fail(
        'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
        'Runner job view binding is invalid.',
      );
    }
    return view;
  }

  async waitForTerminal(
    jobId: string,
    options: {
      readonly timeoutMs: number;
      readonly pollIntervalMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<WorkflowRunnerJobView> {
    const interval = options.pollIntervalMs ?? 250;
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > MAX_WHOLE_TIMEOUT_MS ||
      !Number.isSafeInteger(interval) ||
      interval < 25 ||
      interval > 30_000
    ) {
      return fail('WORKFLOW_RUNNER_CONTROL_INPUT_INVALID', 'Runner polling bounds are invalid.');
    }
    const overall = boundedSignal(options.timeoutMs, options.signal);
    try {
      while (!overall.signal.aborted) {
        const view = await this.readJob(jobId, overall.signal);
        if (view.state === 'terminal' || view.state === 'reconciliation_required') return view;
        await new Promise<void>((resolvePromise, reject) => {
          const finish = () => {
            overall.signal.removeEventListener('abort', abort);
            resolvePromise();
          };
          const timer = setTimeout(finish, interval);
          const abort = () => {
            clearTimeout(timer);
            overall.signal.removeEventListener('abort', abort);
            reject(overall.signal.reason ?? new Error('runner polling aborted'));
          };
          overall.signal.addEventListener('abort', abort, { once: true });
        });
      }
    } catch (error) {
      if (!overall.timedOut()) throw error;
    } finally {
      overall.dispose();
    }
    return fail('WORKFLOW_RUNNER_CONTROL_TIMEOUT', 'Runner job did not reach a terminal state.');
  }

  async #requestJson(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ readonly status: number; readonly value: unknown }> {
    const bounded = boundedSignal(this.#requestTimeoutMs, signal);
    try {
      const response = await this.#fetch(`${this.#config.origin}${path}`, {
        ...init,
        redirect: 'error',
        signal: bounded.signal,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${this.#config.bearerToken}`,
          'X-OpenSlack-Workspace-ID': this.#config.workspaceId,
        },
      });
      return Object.freeze({
        status: response.status,
        value: await readBoundedJson(response, bounded.signal),
      });
    } catch (error) {
      if (error instanceof WorkflowRunnerControlError) throw error;
      return fail(
        bounded.timedOut()
          ? 'WORKFLOW_RUNNER_CONTROL_TIMEOUT'
          : 'WORKFLOW_RUNNER_CONTROL_TRANSPORT_FAILED',
        bounded.timedOut() ? 'Runner control request timed out.' : 'Runner control request failed.',
        { cause: error },
      );
    } finally {
      bounded.dispose();
    }
  }

  async #rejected(response: { readonly status: number; readonly value: unknown }): Promise<never> {
    const code = runnerErrorCode(response.value) ?? `HTTP_${response.status}`;
    return fail(
      response.status === 408
        ? 'WORKFLOW_RUNNER_CONTROL_TIMEOUT'
        : response.status === 202
          ? 'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED'
          : 'WORKFLOW_RUNNER_CONTROL_REJECTED',
      `Runner control rejected the request (${code}).`,
    );
  }
}
