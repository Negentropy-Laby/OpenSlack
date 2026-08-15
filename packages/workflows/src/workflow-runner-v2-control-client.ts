import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { canonicalWorkflowEffectJson, parseWorkflowEffectJson } from './workflow-effect-json.js';
import type { WorkflowRunnerControlConfig } from './workflow-runner-control-client.js';
import {
  WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
  type WorkflowControlAuthorityRoute,
} from './workflow-control-authority-contract.js';
import { WORKFLOW_RUNNER_CAPABILITIES } from './workflow-runner-contract.js';

export const WORKFLOW_RUNNER_V2_JOB_SPEC_SCHEMA = 'openslack.workflow_runner_job_spec.v2' as const;
export const WORKFLOW_RUNNER_V2_JOB_RECEIPT_SCHEMA =
  'openslack.workflow_runner_job_receipt.v2' as const;
export const WORKFLOW_RUNNER_V2_JOB_VIEW_SCHEMA = 'openslack.workflow_runner_job_view.v2' as const;

export type WorkflowRunnerV2RequiredCapability = (typeof WORKFLOW_RUNNER_CAPABILITIES)[number];

export interface WorkflowRunnerV2JobSpec {
  readonly schema: typeof WORKFLOW_RUNNER_V2_JOB_SPEC_SCHEMA;
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
  readonly requiredProtocolVersion: typeof WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION;
  readonly requiredCapabilities: readonly WorkflowRunnerV2RequiredCapability[];
  readonly authorityRoute: WorkflowControlAuthorityRoute;
  readonly runRevision: number;
  readonly resumeGeneration: number;
}

export interface PreparedWorkflowRunnerV2JobSpec {
  readonly spec: WorkflowRunnerV2JobSpec;
  readonly exactBody: string;
  readonly jobSpecHash: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface WorkflowRunnerV2JobReceipt {
  readonly schema: typeof WORKFLOW_RUNNER_V2_JOB_RECEIPT_SCHEMA;
  readonly status: 'accepted' | 'reconciliation_required';
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

export interface WorkflowRunnerV2ControlPort {
  readonly descriptorRoot: string;
  submit(
    prepared: PreparedWorkflowRunnerV2JobSpec,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerV2JobReceipt>;
}

export class WorkflowRunnerV2ControlError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_V2_CONTROL_CONFIG_INVALID'
      | 'WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID'
      | 'WORKFLOW_RUNNER_V2_CONTROL_TRANSPORT_FAILED'
      | 'WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID'
      | 'WORKFLOW_RUNNER_V2_CONTROL_REJECTED'
      | 'WORKFLOW_RUNNER_V2_CONTROL_RECONCILIATION_REQUIRED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowRunnerV2ControlError';
  }
}

type JsonRecord = Record<string, unknown>;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const IDEMPOTENCY = /^openslack\.workflow-runner-job\.v2\.[0-9a-f]{64}$/u;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const declaredLength = response.headers.get('Content-Length');
  let expectedLength: number | null = null;
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_RESPONSE_BYTES) {
      return fail(
        'WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID',
        'V2 response content length is invalid.',
      );
    }
    expectedLength = parsed;
  }
  if (!response.body) {
    return fail('WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID', 'V2 response body is missing.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return fail(
          'WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID',
          'V2 response exceeds its byte limit.',
        );
      }
      chunks.push(item.value);
    }
  } catch (error) {
    return fail('WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID', 'V2 response read failed.', {
      cause: error,
    });
  }
  if (length === 0) {
    return fail('WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID', 'V2 response body is empty.');
  }
  if (expectedLength !== null && expectedLength !== length) {
    return fail(
      'WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID',
      'V2 response content length does not match its body.',
    );
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length,
  );
}

function exactLoopbackOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    return fail('WORKFLOW_RUNNER_V2_CONTROL_CONFIG_INVALID', 'V2 runner origin is invalid.', {
      cause: error,
    });
  }
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    parsed.port === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    return fail(
      'WORKFLOW_RUNNER_V2_CONTROL_CONFIG_INVALID',
      'V2 runner origin must be an exact loopback HTTP origin.',
    );
  }
  return parsed.origin;
}

function fail(
  code: WorkflowRunnerV2ControlError['code'],
  message: string,
  options?: ErrorOptions,
): never {
  throw new WorkflowRunnerV2ControlError(code, message, options);
}

function record(value: unknown, fields: readonly string[], label: string): JsonRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return fail('WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID', `${label} must be a plain object.`);
  }
  const result = value as JsonRecord;
  const actual = Object.keys(result).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    return fail(
      'WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID',
      `${label} has missing or unknown fields.`,
    );
  }
  return result;
}

function own(value: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return fail('WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function safeInteger(value: unknown, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail('WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID', `${label} is invalid.`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, TIMESTAMP, label);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(Date.parse(result)).toISOString() !== result
  ) {
    return fail('WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID', `${label} is not canonical UTC.`);
  }
  return result;
}

function route(value: unknown): WorkflowControlAuthorityRoute {
  const item = record(
    value,
    ['backend', 'authority', 'routingEpoch', 'authorityBuildHash'],
    'Authority route',
  );
  const backend = own(item, 'backend');
  const authority = own(item, 'authority');
  if (
    !(
      (backend === 'ts-local' && authority === 'typescript') ||
      (backend === 'go' && authority === 'workflow-control')
    )
  ) {
    return fail(
      'WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID',
      'Authority route backend and authority disagree.',
    );
  }
  return Object.freeze({
    backend,
    authority,
    routingEpoch: safeInteger(own(item, 'routingEpoch'), 1, 'routingEpoch'),
    authorityBuildHash: text(own(item, 'authorityBuildHash'), HASH, 'authorityBuildHash'),
  }) as WorkflowControlAuthorityRoute;
}

function capabilities(value: unknown): readonly WorkflowRunnerV2RequiredCapability[] {
  if (
    !Array.isArray(value) ||
    value.length !== WORKFLOW_RUNNER_CAPABILITIES.length ||
    value.some((entry, index) => entry !== WORKFLOW_RUNNER_CAPABILITIES[index])
  ) {
    return fail(
      'WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID',
      'V2 required capabilities must match the frozen qualification set.',
    );
  }
  return Object.freeze([...WORKFLOW_RUNNER_CAPABILITIES]);
}

export function validateWorkflowRunnerV2JobSpec(value: unknown): WorkflowRunnerV2JobSpec {
  const item = record(
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
      'requiredProtocolVersion',
      'requiredCapabilities',
      'authorityRoute',
      'runRevision',
      'resumeGeneration',
    ],
    'V2 runner job specification',
  );
  if (
    own(item, 'schema') !== WORKFLOW_RUNNER_V2_JOB_SPEC_SCHEMA ||
    own(item, 'requiredProtocolVersion') !== WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION
  ) {
    return fail(
      'WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID',
      'V2 runner job schema or required protocol is unsupported.',
    );
  }
  const wholeTimeoutMs = safeInteger(own(item, 'wholeTimeoutMs'), MIN_TIMEOUT_MS, 'wholeTimeoutMs');
  if (wholeTimeoutMs > MAX_TIMEOUT_MS) {
    return fail('WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID', 'wholeTimeoutMs exceeds its limit.');
  }
  return Object.freeze({
    schema: WORKFLOW_RUNNER_V2_JOB_SPEC_SCHEMA,
    workspaceId: text(own(item, 'workspaceId'), SAFE_ID, 'workspaceId'),
    jobId: text(own(item, 'jobId'), SAFE_ID, 'jobId'),
    workflowRunId: text(own(item, 'workflowRunId'), SAFE_ID, 'workflowRunId'),
    correlationId: text(own(item, 'correlationId'), SAFE_ID, 'correlationId'),
    executionDescriptorRef: text(
      own(item, 'executionDescriptorRef'),
      SAFE_ID,
      'executionDescriptorRef',
    ),
    executionDescriptorHash: text(
      own(item, 'executionDescriptorHash'),
      HASH,
      'executionDescriptorHash',
    ),
    workflowId: text(own(item, 'workflowId'), SAFE_ID, 'workflowId'),
    workflowVersion: (() => {
      const value = text(own(item, 'workflowVersion'), SEMVER, 'workflowVersion');
      if (value.length > 64) {
        return fail(
          'WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID',
          'workflowVersion exceeds its closed v2 limit.',
        );
      }
      return value;
    })(),
    workflowSourceHash: text(own(item, 'workflowSourceHash'), HASH, 'workflowSourceHash'),
    manifestHash: text(own(item, 'manifestHash'), HASH, 'manifestHash'),
    inputHash: text(own(item, 'inputHash'), HASH, 'inputHash'),
    wholeTimeoutMs,
    submittedAt: timestamp(own(item, 'submittedAt'), 'submittedAt'),
    requiredProtocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    requiredCapabilities: capabilities(own(item, 'requiredCapabilities')),
    authorityRoute: route(own(item, 'authorityRoute')),
    runRevision: safeInteger(own(item, 'runRevision'), 1, 'runRevision'),
    resumeGeneration: safeInteger(own(item, 'resumeGeneration'), 0, 'resumeGeneration'),
  });
}

export function prepareWorkflowRunnerV2JobSpec(value: unknown): PreparedWorkflowRunnerV2JobSpec {
  const spec = validateWorkflowRunnerV2JobSpec(value);
  const exactBody = canonicalWorkflowEffectJson(spec);
  const jobSpecHash = createHash('sha256')
    .update('openslack.workflow-runner.job-spec.v2\0', 'utf8')
    .update(exactBody, 'utf8')
    .digest('hex');
  const idempotencyKey = `openslack.workflow-runner-job.v2.${createHash('sha256')
    .update('openslack.workflow-runner-job.idempotency.v2\0', 'utf8')
    .update(exactBody, 'utf8')
    .digest('hex')}`;
  const requestFingerprint = `sha256:${createHash('sha256')
    .update(
      canonicalWorkflowEffectJson({
        schema: 'openslack.workflow_runner_job_fingerprint.v2',
        workspaceId: spec.workspaceId,
        jobId: spec.jobId,
        workflowRunId: spec.workflowRunId,
        jobSpecHash,
        requiredProtocolVersion: spec.requiredProtocolVersion,
      }),
      'utf8',
    )
    .digest('hex')}`;
  return Object.freeze({ spec, exactBody, jobSpecHash, idempotencyKey, requestFingerprint });
}

export function validateWorkflowRunnerV2JobReceipt(value: unknown): WorkflowRunnerV2JobReceipt {
  const item = record(
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
    'V2 runner job receipt',
  );
  const status = own(item, 'status');
  const state = own(item, 'state');
  const reconciliationId = own(item, 'reconciliationId');
  if (
    own(item, 'schema') !== WORKFLOW_RUNNER_V2_JOB_RECEIPT_SCHEMA ||
    !['accepted', 'reconciliation_required'].includes(String(status)) ||
    !['queued', 'reconciliation_required'].includes(String(state)) ||
    (status === 'reconciliation_required') !== (reconciliationId !== null) ||
    (state === 'reconciliation_required') !== (reconciliationId !== null) ||
    (status === 'accepted' && own(item, 'revision') !== 1)
  ) {
    return fail('WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID', 'V2 runner receipt is invalid.');
  }
  return Object.freeze({
    schema: WORKFLOW_RUNNER_V2_JOB_RECEIPT_SCHEMA,
    status: status as WorkflowRunnerV2JobReceipt['status'],
    workspaceId: text(own(item, 'workspaceId'), SAFE_ID, 'workspaceId'),
    jobId: text(own(item, 'jobId'), SAFE_ID, 'jobId'),
    workflowRunId: text(own(item, 'workflowRunId'), SAFE_ID, 'workflowRunId'),
    state: state as WorkflowRunnerV2JobReceipt['state'],
    revision: safeInteger(own(item, 'revision'), 1, 'revision'),
    jobSpecHash: text(own(item, 'jobSpecHash'), HASH, 'jobSpecHash'),
    idempotencyKey: text(own(item, 'idempotencyKey'), IDEMPOTENCY, 'idempotencyKey'),
    requestFingerprint: text(own(item, 'requestFingerprint'), FINGERPRINT, 'requestFingerprint'),
    committedAt: timestamp(own(item, 'committedAt'), 'committedAt'),
    reconciliationId:
      reconciliationId === null ? null : text(reconciliationId, SAFE_ID, 'reconciliationId'),
  });
}

export class WorkflowRunnerV2ControlClient implements WorkflowRunnerV2ControlPort {
  readonly #config: WorkflowRunnerControlConfig;
  readonly #fetch: typeof fetch;

  constructor(config: WorkflowRunnerControlConfig, fetchImpl: typeof fetch = fetch) {
    if (
      !config ||
      typeof config !== 'object' ||
      !SAFE_ID.test(config.workspaceId) ||
      typeof config.bearerToken !== 'string' ||
      config.bearerToken.length < 32 ||
      config.bearerToken.length > 4096 ||
      /[\u0000-\u0020\u007f]/u.test(config.bearerToken) ||
      !isAbsolute(config.descriptorRoot) ||
      resolve(config.descriptorRoot) !== config.descriptorRoot
    ) {
      fail('WORKFLOW_RUNNER_V2_CONTROL_CONFIG_INVALID', 'V2 runner control config is invalid.');
    }
    this.#config = Object.freeze({ ...config, origin: exactLoopbackOrigin(config.origin) });
    this.#fetch = fetchImpl;
  }

  get descriptorRoot(): string {
    return this.#config.descriptorRoot;
  }

  async submit(
    preparedValue: PreparedWorkflowRunnerV2JobSpec,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerV2JobReceipt> {
    const prepared = prepareWorkflowRunnerV2JobSpec(preparedValue.spec);
    if (
      prepared.exactBody !== preparedValue.exactBody ||
      prepared.jobSpecHash !== preparedValue.jobSpecHash ||
      prepared.idempotencyKey !== preparedValue.idempotencyKey ||
      prepared.requestFingerprint !== preparedValue.requestFingerprint
    ) {
      return fail(
        'WORKFLOW_RUNNER_V2_CONTROL_INPUT_INVALID',
        'Prepared v2 job binding is invalid.',
      );
    }
    let response: Response;
    try {
      response = await this.#fetch(new URL('/v2/runner/jobs', this.#config.origin), {
        method: 'POST',
        redirect: 'error',
        signal,
        body: prepared.exactBody,
        headers: {
          Authorization: `Bearer ${this.#config.bearerToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': prepared.idempotencyKey,
          'X-OpenSlack-Request-Fingerprint': prepared.requestFingerprint,
          'X-OpenSlack-Workspace-ID': this.#config.workspaceId,
        },
      });
    } catch (error) {
      return fail('WORKFLOW_RUNNER_V2_CONTROL_TRANSPORT_FAILED', 'V2 job submit failed.', {
        cause: error,
      });
    }
    if (response.redirected || ![200, 201, 202].includes(response.status)) {
      return fail(
        'WORKFLOW_RUNNER_V2_CONTROL_REJECTED',
        `V2 submit rejected (${response.status}).`,
      );
    }
    if (response.headers.get('Content-Type') !== 'application/json') {
      return fail(
        'WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID',
        'V2 response content type is invalid.',
      );
    }
    const replayHeader = response.headers.get('Idempotency-Replayed');
    if (
      (response.status === 200 && replayHeader !== 'true') ||
      (response.status !== 200 && replayHeader !== null)
    ) {
      return fail(
        'WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID',
        'V2 response replay metadata is invalid.',
      );
    }
    const bytes = await readBoundedResponse(response);
    let value: unknown;
    try {
      value = parseWorkflowEffectJson(bytes);
    } catch (error) {
      return fail('WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID', 'V2 response is invalid JSON.', {
        cause: error,
      });
    }
    let receipt: WorkflowRunnerV2JobReceipt;
    try {
      receipt = validateWorkflowRunnerV2JobReceipt(value);
    } catch (error) {
      return fail(
        'WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID',
        'V2 response receipt is invalid.',
        { cause: error },
      );
    }
    if (`${canonicalWorkflowEffectJson(receipt)}\n` !== bytes.toString('utf8')) {
      return fail(
        'WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID',
        'V2 response is not exact canonical JSON followed by one LF.',
      );
    }
    if (
      receipt.workspaceId !== this.#config.workspaceId ||
      receipt.jobId !== prepared.spec.jobId ||
      receipt.workflowRunId !== prepared.spec.workflowRunId ||
      receipt.jobSpecHash !== prepared.jobSpecHash ||
      receipt.idempotencyKey !== prepared.idempotencyKey ||
      receipt.requestFingerprint !== prepared.requestFingerprint ||
      (response.status === 201 && receipt.status !== 'accepted') ||
      (response.status === 202 && receipt.status !== 'reconciliation_required')
    ) {
      return fail('WORKFLOW_RUNNER_V2_CONTROL_RESPONSE_INVALID', 'V2 receipt binding is invalid.');
    }
    if (receipt.status === 'reconciliation_required') {
      return fail(
        'WORKFLOW_RUNNER_V2_CONTROL_RECONCILIATION_REQUIRED',
        'V2 admission requires reconciliation.',
      );
    }
    return receipt;
  }
}
