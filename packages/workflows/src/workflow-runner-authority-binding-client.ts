import { types as nodeTypes } from 'node:util';

import {
  parseWorkflowRunnerAuthorityBindingReceiptBytes,
  type WorkflowRunnerAuthorityBindingPrepared,
  type WorkflowRunnerAuthorityBindingReceipt,
} from './workflow-runner-authority-binding-contract.js';
import {
  cancelWorkflowRunnerResponseBody,
  exactWorkflowRunnerLoopbackOrigin,
  readWorkflowRunnerResponseBytes,
} from './workflow-runner-control-http.js';

export const WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_ROUTE =
  '/v2/runner/authority-bindings:stage' as const;
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_ROUTE_PREFIX =
  '/v2/runner/authority-bindings/' as const;
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_ROUTE_PREFIX =
  '/v2/runner/authority-bindings/receipts/' as const;

export interface WorkflowRunnerAuthorityBindingPort {
  stage(
    prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityBindingReceipt>;
  resolve(
    bindingId: string,
    prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityBindingReceipt>;
  acknowledgeControl(
    bindingId: string,
    prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityBindingReceipt>;
  readReceipt(
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityBindingReceipt | null>;
}

export interface WorkflowRunnerAuthorityBindingClientConfig {
  readonly origin: string;
  readonly workspaceId: string;
  readonly bearerToken: string;
  readonly fetch?: typeof fetch;
}

export class WorkflowRunnerAuthorityBindingClientError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_CONFIG_INVALID'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_REQUEST_INVALID'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_TRANSPORT_FAILED'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_RESPONSE_INVALID'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_REJECTED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowRunnerAuthorityBindingClientError';
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const IDEMPOTENCY = /^openslack\.workflow-runner-authority-binding\.v1\.[0-9a-f]{64}$/u;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const MAX_RESPONSE_BYTES = 65_536;

function fail(
  code: WorkflowRunnerAuthorityBindingClientError['code'],
  message: string,
  options?: ErrorOptions,
): never {
  throw new WorkflowRunnerAuthorityBindingClientError(code, message, options);
}

function exactOrigin(value: string): string {
  return exactWorkflowRunnerLoopbackOrigin(
    value,
    (message, options) =>
      fail('WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_CONFIG_INVALID', message, options),
    {
      invalid: 'Authority-binding origin is invalid.',
      nonLoopback: 'Authority-binding origin must be an exact loopback HTTP origin.',
    },
  );
}

function bindingId(value: string): string {
  if (!/^WFRUNNER-BINDING-[0-9a-f]{64}$/u.test(value)) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_REQUEST_INVALID',
      'Authority-binding ID is invalid.',
    );
  }
  return value;
}

function preparedRequest(
  value: WorkflowRunnerAuthorityBindingPrepared<unknown>,
): WorkflowRunnerAuthorityBindingPrepared<unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    nodeTypes.isProxy(value) ||
    typeof value.body !== 'string' ||
    !value.body.endsWith('\n') ||
    !IDEMPOTENCY.test(value.idempotencyKey) ||
    !FINGERPRINT.test(value.requestFingerprint)
  ) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_REQUEST_INVALID',
      'Authority-binding prepared request is invalid.',
    );
  }
  return value;
}

async function boundedReceipt(response: Response): Promise<WorkflowRunnerAuthorityBindingReceipt> {
  const bytes = await readWorkflowRunnerResponseBytes(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    validateContentLength: true,
    minimumBytes: 1,
    failure: (message, options) =>
      fail('WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_RESPONSE_INVALID', message, options),
    messages: {
      contentType: 'Authority-binding response content type is invalid.',
      contentLength: 'Authority-binding response content length is invalid.',
      missingBody: 'Authority-binding response body is missing.',
      readFailed: 'Authority-binding response read failed.',
      exceeded: 'Authority-binding response exceeds its byte limit.',
      empty: 'Authority-binding response body is empty.',
      lengthMismatch: 'Authority-binding response content length does not match its body.',
      aborted: 'authority-binding response read aborted',
    },
  });
  try {
    return parseWorkflowRunnerAuthorityBindingReceiptBytes(bytes);
  } catch (error) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_RESPONSE_INVALID',
      'Authority-binding response is not an exact F2a receipt frame.',
      { cause: error },
    );
  }
}

export function createWorkflowRunnerAuthorityBindingClient(
  config: WorkflowRunnerAuthorityBindingClientConfig,
): WorkflowRunnerAuthorityBindingPort {
  const origin = exactOrigin(config.origin);
  if (!SAFE_ID.test(config.workspaceId) || config.bearerToken.length < 32) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_CONFIG_INVALID',
      'Authority-binding workspace or bearer configuration is invalid.',
    );
  }
  if (config.fetch !== undefined && typeof config.fetch !== 'function') {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_CONFIG_INVALID',
      'Authority-binding fetch implementation is invalid.',
    );
  }
  const request = config.fetch ?? globalThis.fetch;
  const commonHeaders = Object.freeze({
    Authorization: `Bearer ${config.bearerToken}`,
    'X-OpenSlack-Workspace-ID': config.workspaceId,
  });

  const post = async (
    path: string,
    preparedValue: WorkflowRunnerAuthorityBindingPrepared<unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthorityBindingReceipt> => {
    const prepared = preparedRequest(preparedValue);
    let response: Response;
    try {
      response = await request(`${origin}${path}`, {
        method: 'POST',
        headers: {
          ...commonHeaders,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(prepared.body, 'utf8')),
          'Idempotency-Key': prepared.idempotencyKey,
          'X-OpenSlack-Request-Fingerprint': prepared.requestFingerprint,
        },
        body: prepared.body,
        signal,
      });
    } catch (error) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_TRANSPORT_FAILED',
        'Authority-binding POST transport failed with an unknown outcome.',
        { cause: error },
      );
    }
    // 202 is the exact durable reconciliation receipt, not a transport error.
    // The runtime validates its status and latches reconciliation without
    // retrying the source mutation or changing bytes/key.
    if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
      cancelWorkflowRunnerResponseBody(response);
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_REJECTED',
        `Authority-binding POST returned HTTP ${response.status}.`,
      );
    }
    return boundedReceipt(response);
  };

  return Object.freeze({
    stage: (prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>, signal?: AbortSignal) =>
      post(WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_ROUTE, prepared, signal),
    resolve: (
      id: string,
      prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
      signal?: AbortSignal,
    ) =>
      post(
        `${WORKFLOW_RUNNER_AUTHORITY_BINDING_ROUTE_PREFIX}${encodeURIComponent(bindingId(id))}:resolve`,
        prepared,
        signal,
      ),
    acknowledgeControl: (
      id: string,
      prepared: WorkflowRunnerAuthorityBindingPrepared<unknown>,
      signal?: AbortSignal,
    ) =>
      post(
        `${WORKFLOW_RUNNER_AUTHORITY_BINDING_ROUTE_PREFIX}${encodeURIComponent(bindingId(id))}:ack-control`,
        prepared,
        signal,
      ),
    async readReceipt(idempotencyKey: string, signal?: AbortSignal) {
      if (!IDEMPOTENCY.test(idempotencyKey)) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_REQUEST_INVALID',
          'Authority-binding receipt idempotency key is invalid.',
        );
      }
      let response: Response;
      try {
        response = await request(
          `${origin}${WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_ROUTE_PREFIX}${encodeURIComponent(idempotencyKey)}`,
          { method: 'GET', headers: commonHeaders, signal },
        );
      } catch (error) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_TRANSPORT_FAILED',
          'Authority-binding receipt point-read failed.',
          { cause: error },
        );
      }
      if (response.status === 404) {
        cancelWorkflowRunnerResponseBody(response);
        return null;
      }
      if (response.status !== 200) {
        cancelWorkflowRunnerResponseBody(response);
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_REJECTED',
          `Authority-binding receipt point-read returned HTTP ${response.status}.`,
        );
      }
      return boundedReceipt(response);
    },
  } satisfies WorkflowRunnerAuthorityBindingPort);
}
