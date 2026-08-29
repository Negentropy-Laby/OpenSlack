import { createHash } from 'node:crypto';

import { canonicalWorkflowEffectJson } from './workflow-effect-json.js';
import { parseWorkflowEffectJson } from './workflow-effect-json.js';

export const WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_SCHEMA =
  'openslack.workflow_runner_v2_runtime_admission.v1' as const;
export const WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_RECEIPT_SCHEMA =
  'openslack.workflow_runner_v2_runtime_admission_receipt.v1' as const;
export const WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_KEY_PREFIX =
  'openslack.workflow-runner-v2-runtime-admission.v1.' as const;
export const WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_DOMAINS = Object.freeze({
  idempotency: 'openslack.workflow-runner-v2-runtime-admission.idempotency.v1\0',
  fingerprint: 'openslack.workflow-runner-v2-runtime-admission.fingerprint.v1\0',
});

export const WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxDepth: 16,
  maxNodes: 8_192,
  maxStringBytes: 524_288,
});
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ADMISSION_KEYS = Object.freeze([
  'schema',
  'workspaceId',
  'jobId',
  'workflowRunId',
  'attemptId',
  'leaseId',
  'fencingToken',
  'jobSpecHash',
  'disposition',
] as const);
const RECEIPT_KEYS = Object.freeze([
  'schema',
  'status',
  'workspaceId',
  'jobId',
  'workflowRunId',
  'attemptId',
  'leaseId',
  'fencingToken',
  'jobSpecHash',
  'disposition',
  'idempotencyKey',
  'requestFingerprint',
  'committedAt',
] as const);

export interface WorkflowRunnerV2RuntimeAdmission {
  readonly schema: typeof WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_SCHEMA;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly workflowRunId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly jobSpecHash: string;
  readonly disposition: 'initial' | 'resume';
}

export interface WorkflowRunnerV2PreparedRuntimeAdmission {
  readonly value: WorkflowRunnerV2RuntimeAdmission;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface WorkflowRunnerV2RuntimeAdmissionReceipt extends Omit<
  WorkflowRunnerV2RuntimeAdmission,
  'schema'
> {
  readonly schema: typeof WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_RECEIPT_SCHEMA;
  readonly status: 'accepted';
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly committedAt: string;
}

export class WorkflowRunnerV2RuntimeAdmissionError extends Error {
  readonly code = 'WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_FAILED' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkflowRunnerV2RuntimeAdmissionError';
  }
}

function sha256(domain: string, body: string): string {
  return createHash('sha256').update(domain, 'utf8').update(body, 'utf8').digest('hex');
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowRunnerV2RuntimeAdmissionError(`${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (
    canonicalWorkflowEffectJson(Object.keys(value).sort()) !==
    canonicalWorkflowEffectJson([...keys].sort())
  ) {
    throw new WorkflowRunnerV2RuntimeAdmissionError(`${label} field set is invalid.`);
  }
}

export function validateWorkflowRunnerV2RuntimeAdmission(
  input: unknown,
): WorkflowRunnerV2RuntimeAdmission {
  const value = object(input, 'Runtime admission');
  closed(value, ADMISSION_KEYS, 'Runtime admission');
  if (
    value.schema !== WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_SCHEMA ||
    !SAFE_ID.test(String(value.workspaceId ?? '')) ||
    !SAFE_ID.test(String(value.jobId ?? '')) ||
    !SAFE_ID.test(String(value.workflowRunId ?? '')) ||
    !SAFE_ID.test(String(value.attemptId ?? '')) ||
    !SAFE_ID.test(String(value.leaseId ?? '')) ||
    !Number.isSafeInteger(value.fencingToken) ||
    Number(value.fencingToken) < 1 ||
    typeof value.jobSpecHash !== 'string' ||
    !HASH.test(value.jobSpecHash) ||
    (value.disposition !== 'initial' && value.disposition !== 'resume')
  ) {
    throw new WorkflowRunnerV2RuntimeAdmissionError('Runtime admission identity is invalid.');
  }
  return Object.freeze({ ...value }) as unknown as WorkflowRunnerV2RuntimeAdmission;
}

export function prepareWorkflowRunnerV2RuntimeAdmission(
  input: WorkflowRunnerV2RuntimeAdmission,
): WorkflowRunnerV2PreparedRuntimeAdmission {
  const value = validateWorkflowRunnerV2RuntimeAdmission(input);
  const body = `${canonicalWorkflowEffectJson(value)}\n`;
  return Object.freeze({
    value,
    body,
    idempotencyKey: `${WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_KEY_PREFIX}${sha256(
      WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_DOMAINS.idempotency,
      body,
    )}`,
    requestFingerprint: `sha256:${sha256(
      WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_DOMAINS.fingerprint,
      body,
    )}`,
  });
}

export function parseWorkflowRunnerV2RuntimeAdmissionBytes(
  bytes: Uint8Array,
): WorkflowRunnerV2PreparedRuntimeAdmission {
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS.maxFrameBytes
  ) {
    throw new WorkflowRunnerV2RuntimeAdmissionError('Runtime admission framing is invalid.');
  }
  let exact: string;
  try {
    exact = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WorkflowRunnerV2RuntimeAdmissionError('Runtime admission is not valid UTF-8.', {
      cause: error,
    });
  }
  if (!exact.endsWith('\n') || exact.endsWith('\n\n') || exact.includes('\r')) {
    throw new WorkflowRunnerV2RuntimeAdmissionError('Runtime admission framing is invalid.');
  }
  let parsed: unknown;
  try {
    parsed = parseWorkflowEffectJson(Buffer.from(bytes.subarray(0, -1)), {
      maxDepth: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS.maxDepth,
      maxNodes: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS.maxNodes,
      maxStringLength: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS.maxStringBytes,
      maxStringBytes: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS.maxStringBytes,
      unicodeScalarsOnly: true,
      canonicalSafeIntegersOnly: true,
    });
  } catch (error) {
    throw new WorkflowRunnerV2RuntimeAdmissionError('Runtime admission is not JSON.', {
      cause: error,
    });
  }
  const prepared = prepareWorkflowRunnerV2RuntimeAdmission(
    parsed as WorkflowRunnerV2RuntimeAdmission,
  );
  if (prepared.body !== exact) {
    throw new WorkflowRunnerV2RuntimeAdmissionError(
      'Runtime admission is not exact canonical LF bytes.',
    );
  }
  return prepared;
}

export function validateWorkflowRunnerV2RuntimeAdmissionReceipt(
  input: unknown,
  prepared: WorkflowRunnerV2PreparedRuntimeAdmission,
): WorkflowRunnerV2RuntimeAdmissionReceipt {
  const receipt = object(input, 'Runtime admission receipt');
  closed(receipt, RECEIPT_KEYS, 'Runtime admission receipt');
  const committedAt = receipt.committedAt;
  const parsedAt = typeof committedAt === 'string' ? new Date(committedAt) : null;
  if (
    receipt.schema !== WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_RECEIPT_SCHEMA ||
    receipt.status !== 'accepted' ||
    receipt.idempotencyKey !== prepared.idempotencyKey ||
    receipt.requestFingerprint !== prepared.requestFingerprint ||
    !parsedAt ||
    !TIMESTAMP.test(committedAt as string) ||
    !Number.isFinite(parsedAt.getTime()) ||
    parsedAt.toISOString() !== committedAt
  ) {
    throw new WorkflowRunnerV2RuntimeAdmissionError(
      'Runtime admission receipt binding is invalid.',
    );
  }
  for (const field of ADMISSION_KEYS.slice(1)) {
    if (receipt[field] !== prepared.value[field]) {
      throw new WorkflowRunnerV2RuntimeAdmissionError(
        'Runtime admission receipt is cross-spliced.',
      );
    }
  }
  return Object.freeze({ ...receipt }) as unknown as WorkflowRunnerV2RuntimeAdmissionReceipt;
}

export function parseWorkflowRunnerV2RuntimeAdmissionReceiptBytes(
  bytes: Uint8Array,
  prepared: WorkflowRunnerV2PreparedRuntimeAdmission,
): WorkflowRunnerV2RuntimeAdmissionReceipt {
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS.maxFrameBytes
  ) {
    throw new WorkflowRunnerV2RuntimeAdmissionError(
      'Runtime admission receipt framing is invalid.',
    );
  }
  let exact: string;
  try {
    exact = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WorkflowRunnerV2RuntimeAdmissionError(
      'Runtime admission receipt is not valid UTF-8.',
      { cause: error },
    );
  }
  if (!exact.endsWith('\n') || exact.endsWith('\n\n') || exact.includes('\r')) {
    throw new WorkflowRunnerV2RuntimeAdmissionError(
      'Runtime admission receipt framing is invalid.',
    );
  }
  let parsed: unknown;
  try {
    parsed = parseWorkflowEffectJson(Buffer.from(bytes.subarray(0, -1)), {
      maxDepth: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS.maxDepth,
      maxNodes: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS.maxNodes,
      maxStringLength: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS.maxStringBytes,
      maxStringBytes: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS.maxStringBytes,
      unicodeScalarsOnly: true,
      canonicalSafeIntegersOnly: true,
    });
  } catch (error) {
    throw new WorkflowRunnerV2RuntimeAdmissionError('Runtime admission receipt is not JSON.', {
      cause: error,
    });
  }
  const receipt = validateWorkflowRunnerV2RuntimeAdmissionReceipt(parsed, prepared);
  if (`${canonicalWorkflowEffectJson(receipt)}\n` !== exact) {
    throw new WorkflowRunnerV2RuntimeAdmissionError(
      'Runtime admission receipt is not exact canonical LF bytes.',
    );
  }
  return receipt;
}
