import { createHash } from 'node:crypto';
import { canonicalWorkflowEffectJson } from './workflow-effect-json.js';

export const WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_SCHEMA =
  'openslack.workflow_runner_v2_runtime_admission.v1' as const;
export const WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_RECEIPT_SCHEMA =
  'openslack.workflow_runner_v2_runtime_admission_receipt.v1' as const;
const KEY_PREFIX = 'openslack.workflow-runner-v2-runtime-admission.v1.';
const MAX_RESPONSE_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

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

function assertAdmission(value: WorkflowRunnerV2RuntimeAdmission): void {
  if (
    value.schema !== WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_SCHEMA ||
    !SAFE_ID.test(value.workspaceId) ||
    !SAFE_ID.test(value.jobId) ||
    !SAFE_ID.test(value.workflowRunId) ||
    !SAFE_ID.test(value.attemptId) ||
    !SAFE_ID.test(value.leaseId) ||
    !Number.isSafeInteger(value.fencingToken) ||
    value.fencingToken < 1 ||
    !HASH.test(value.jobSpecHash) ||
    (value.disposition !== 'initial' && value.disposition !== 'resume')
  ) {
    throw new WorkflowRunnerV2RuntimeAdmissionError('Runtime admission identity is invalid.');
  }
}

export function prepareWorkflowRunnerV2RuntimeAdmission(
  value: WorkflowRunnerV2RuntimeAdmission,
): WorkflowRunnerV2PreparedRuntimeAdmission {
  assertAdmission(value);
  const body = `${canonicalWorkflowEffectJson(value)}\n`;
  return Object.freeze({
    value: Object.freeze({ ...value }),
    body,
    idempotencyKey: `${KEY_PREFIX}${sha256(
      'openslack.workflow-runner-v2-runtime-admission.idempotency.v1\0',
      body,
    )}`,
    requestFingerprint: `sha256:${sha256(
      'openslack.workflow-runner-v2-runtime-admission.fingerprint.v1\0',
      body,
    )}`,
  });
}

function validateReceipt(
  exactBytes: string,
  prepared: WorkflowRunnerV2PreparedRuntimeAdmission,
): WorkflowRunnerV2RuntimeAdmissionReceipt {
  if (
    Buffer.byteLength(exactBytes, 'utf8') > MAX_RESPONSE_BYTES ||
    !exactBytes.endsWith('\n') ||
    exactBytes.endsWith('\n\n')
  ) {
    throw new WorkflowRunnerV2RuntimeAdmissionError(
      'Runtime admission receipt framing is invalid.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(exactBytes);
  } catch (error) {
    throw new WorkflowRunnerV2RuntimeAdmissionError('Runtime admission receipt is not JSON.', {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkflowRunnerV2RuntimeAdmissionError('Runtime admission receipt is not an object.');
  }
  const receipt = parsed as Record<string, unknown>;
  const expectedKeys = [
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
  ].sort();
  if (
    canonicalWorkflowEffectJson(Object.keys(receipt).sort()) !==
      canonicalWorkflowEffectJson(expectedKeys) ||
    `${canonicalWorkflowEffectJson(receipt)}\n` !== exactBytes ||
    receipt.schema !== WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_RECEIPT_SCHEMA ||
    receipt.status !== 'accepted' ||
    receipt.idempotencyKey !== prepared.idempotencyKey ||
    receipt.requestFingerprint !== prepared.requestFingerprint ||
    typeof receipt.committedAt !== 'string' ||
    !TIMESTAMP.test(receipt.committedAt) ||
    !Number.isFinite(Date.parse(receipt.committedAt))
  ) {
    throw new WorkflowRunnerV2RuntimeAdmissionError(
      'Runtime admission receipt binding is invalid.',
    );
  }
  for (const field of [
    'workspaceId',
    'jobId',
    'workflowRunId',
    'attemptId',
    'leaseId',
    'fencingToken',
    'jobSpecHash',
    'disposition',
  ] as const) {
    if (receipt[field] !== prepared.value[field]) {
      throw new WorkflowRunnerV2RuntimeAdmissionError(
        'Runtime admission receipt is cross-spliced.',
      );
    }
  }
  return Object.freeze(receipt as unknown as WorkflowRunnerV2RuntimeAdmissionReceipt);
}

export interface WorkflowRunnerV2RuntimeAdmissionPort {
  seal(
    value: WorkflowRunnerV2RuntimeAdmission,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerV2RuntimeAdmissionReceipt>;
}

export function createWorkflowRunnerV2RuntimeAdmissionClient(config: {
  readonly origin: string;
  readonly workspaceId: string;
  readonly bearerToken: string;
  readonly fetch?: typeof fetch;
}): WorkflowRunnerV2RuntimeAdmissionPort {
  const send = config.fetch ?? fetch;
  return Object.freeze({
    async seal(value: WorkflowRunnerV2RuntimeAdmission, signal?: AbortSignal) {
      const prepared = prepareWorkflowRunnerV2RuntimeAdmission(value);
      if (prepared.value.workspaceId !== config.workspaceId) {
        throw new WorkflowRunnerV2RuntimeAdmissionError(
          'Runtime admission differs from the sealed workspace.',
        );
      }
      const attempt = async () => {
        const response = await send(`${config.origin}/v2/runner/runtime-admissions:seal`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.bearerToken}`,
            'Content-Type': 'application/json',
            'X-OpenSlack-Workspace-ID': config.workspaceId,
            'Idempotency-Key': prepared.idempotencyKey,
            'X-OpenSlack-Request-Fingerprint': prepared.requestFingerprint,
          },
          body: prepared.body,
          signal,
        });
        if (response.status !== 200 && response.status !== 201) {
          await response.body?.cancel();
          throw new WorkflowRunnerV2RuntimeAdmissionError(
            `Runtime admission returned HTTP ${response.status}.`,
          );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_RESPONSE_BYTES) {
          throw new WorkflowRunnerV2RuntimeAdmissionError(
            'Runtime admission receipt exceeds its byte limit.',
          );
        }
        return validateReceipt(new TextDecoder('utf-8', { fatal: true }).decode(bytes), prepared);
      };
      try {
        return await attempt();
      } catch (first) {
        if (first instanceof WorkflowRunnerV2RuntimeAdmissionError || signal?.aborted) throw first;
        try {
          return await attempt();
        } catch (second) {
          throw new WorkflowRunnerV2RuntimeAdmissionError(
            'Runtime admission response is unknown after an exact idempotent retry.',
            { cause: second },
          );
        }
      }
    },
  });
}
