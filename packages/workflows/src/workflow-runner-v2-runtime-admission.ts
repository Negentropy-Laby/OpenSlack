import {
  cancelWorkflowRunnerResponseBody,
  readWorkflowRunnerResponseBytes,
} from './workflow-runner-control-http.js';
import {
  parseWorkflowRunnerV2RuntimeAdmissionReceiptBytes,
  prepareWorkflowRunnerV2RuntimeAdmission,
  WorkflowRunnerV2RuntimeAdmissionError,
  type WorkflowRunnerV2RuntimeAdmission,
  type WorkflowRunnerV2RuntimeAdmissionReceipt,
} from './workflow-runner-runtime-admission-contract.js';

export {
  WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_DOMAINS,
  WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_KEY_PREFIX,
  WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS,
  WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_RECEIPT_SCHEMA,
  WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_SCHEMA,
  WorkflowRunnerV2RuntimeAdmissionError,
  parseWorkflowRunnerV2RuntimeAdmissionBytes,
  parseWorkflowRunnerV2RuntimeAdmissionReceiptBytes,
  prepareWorkflowRunnerV2RuntimeAdmission,
  validateWorkflowRunnerV2RuntimeAdmission,
  validateWorkflowRunnerV2RuntimeAdmissionReceipt,
  type WorkflowRunnerV2PreparedRuntimeAdmission,
  type WorkflowRunnerV2RuntimeAdmission,
  type WorkflowRunnerV2RuntimeAdmissionReceipt,
} from './workflow-runner-runtime-admission-contract.js';

const MAX_RESPONSE_BYTES = 64 * 1024;

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
          await cancelWorkflowRunnerResponseBody(response);
          throw new WorkflowRunnerV2RuntimeAdmissionError(
            `Runtime admission returned HTTP ${response.status}.`,
          );
        }
        const bytes = await readWorkflowRunnerResponseBytes(response, {
          maxBytes: MAX_RESPONSE_BYTES,
          signal,
          validateContentLength: true,
          minimumBytes: 2,
          failure: (message, options) => {
            throw new WorkflowRunnerV2RuntimeAdmissionError(message, options);
          },
          messages: {
            contentType: 'Runtime admission receipt content type is invalid.',
            contentLength: 'Runtime admission receipt content length is invalid.',
            missingBody: 'Runtime admission receipt body is missing.',
            readFailed: 'Runtime admission receipt body could not be read.',
            exceeded: 'Runtime admission receipt exceeds its byte limit.',
            empty: 'Runtime admission receipt body is empty.',
            lengthMismatch: 'Runtime admission receipt body length is inconsistent.',
            aborted: 'Runtime admission receipt read was aborted.',
          },
        });
        return parseWorkflowRunnerV2RuntimeAdmissionReceiptBytes(bytes, prepared);
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
