import { types as nodeTypes } from 'node:util';
import {
  parseWorkflowRunRecoveryEvidence,
  validateWorkflowRunRecoveryEvidence,
  WorkflowRunRecoveryError,
  WORKFLOW_RECOVERY_V3_MEDIA_TYPE,
  type WorkflowRunRecoveryEvidencePort,
  type WorkflowRunRecoveryEvidence,
} from './workflow-run-recovery-evidence.js';
import { canonicalWorkflowControlAuthorityJson as canonical } from './workflow-control-authority-contract.js';

import {
  parseWorkflowRunnerAuthorityBindingReceiptBytes,
  type WorkflowRunnerAuthorityBindingPrepared,
  type WorkflowRunnerAuthorityBindingReceipt,
} from './workflow-runner-authority-binding-contract.js';
import {
  cancelWorkflowRunnerResponseBody,
  exactWorkflowRunnerLoopbackOrigin,
  readWorkflowRunnerResponseBytes,
  WorkflowRunnerOperationCancelledError,
  throwIfWorkflowRunnerAborted,
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

async function boundedReceipt(
  response: Response,
  signal?: AbortSignal,
): Promise<WorkflowRunnerAuthorityBindingReceipt> {
  const bytes = await readWorkflowRunnerResponseBytes(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    signal,
    validateContentLength: true,
    minimumBytes: 1,
    failure: (message, options) =>
      fail(
        options.kind === 'transport'
          ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_TRANSPORT_FAILED'
          : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_RESPONSE_INVALID',
        message,
        options,
      ),
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

/** Public inspection capability exposes no authority mutations. */
export function createWorkflowRunRecoveryEvidenceClient(
  config: WorkflowRunnerAuthorityBindingClientConfig,
): WorkflowRunRecoveryEvidencePort {
  const client = createWorkflowRunnerAuthorityBindingClient(config);
  return Object.freeze({ readRecoveryEvidence: client.readRecoveryEvidence.bind(client) });
}

export function createWorkflowRunnerAuthorityBindingClient(
  config: WorkflowRunnerAuthorityBindingClientConfig,
): WorkflowRunnerAuthorityBindingPort & WorkflowRunRecoveryEvidencePort {
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
    throwIfWorkflowRunnerAborted(signal);
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
      throwIfWorkflowRunnerAborted(signal);
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
        response.status === 429 || response.status >= 500
          ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_TRANSPORT_FAILED'
          : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_REJECTED',
        `Authority-binding POST returned HTTP ${response.status}.`,
      );
    }
    return boundedReceipt(response, signal);
  };

  return Object.freeze({
    async readRecoveryEvidence(runId: string, selectedBindingId?: string, signal?: AbortSignal) {
      if (!SAFE_ID.test(runId))
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_REQUEST_INVALID',
          'Recovery run ID is invalid.',
        );
      let result: WorkflowRunRecoveryEvidence | undefined;
      const collected = {
        bindings: [] as Array<WorkflowRunRecoveryEvidence['bindings'][number]>,
        settlements: [] as Array<NonNullable<WorkflowRunRecoveryEvidence['settlements']>[number]>,
        unfinished: [] as Array<WorkflowRunRecoveryEvidence['unfinished'][number]>,
        activeAttempts: [] as string[],
        recordKeys: [] as string[],
      };
      const seen = new Set<string>();
      for (;;) {
        throwIfWorkflowRunnerAborted(signal);
        const params = new URLSearchParams();
        if (selectedBindingId !== undefined) params.set('bindingId', bindingId(selectedBindingId));
        if (result?.nextCursor) {
          params.set('afterBindingId', result.nextCursor);
          params.set('snapshot', result.snapshot);
          if (result.schema === 'openslack.workflow_runner_recovery_evidence.v3') {
            params.set('recoveryVersion', result.recoveryVersion!);
            params.set('readAt', result.readAt!);
          }
        }
        const query = params.size ? `?${params}` : '';
        let response: Response;
        try {
          response = await request(
            `${origin}/v2/runner/runs/${encodeURIComponent(runId)}/recovery-evidence${query}`,
            {
              method: 'GET',
              headers: {
                ...commonHeaders,
                Accept: `${WORKFLOW_RECOVERY_V3_MEDIA_TYPE}, application/json;q=0.9`,
              },
              redirect: 'error',
              signal,
            },
          );
        } catch (cause) {
          if (signal?.aborted) throw new WorkflowRunnerOperationCancelledError(cause);
          throw new WorkflowRunRecoveryError(
            'WORKFLOW_RUN_RECOVERY_UNKNOWN',
            'Recovery evidence transport failed.',
            { cause },
          );
        }
        if (response.status !== 200) {
          cancelWorkflowRunnerResponseBody(response);
          throw new WorkflowRunRecoveryError(
            response.status === 429 || response.status >= 500
              ? 'WORKFLOW_RUN_RECOVERY_UNKNOWN'
              : 'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
            `Recovery evidence returned HTTP ${response.status}.`,
          );
        }
        const bytes = await readWorkflowRunnerResponseBytes(response, {
          // Same per-page bound as the runner HTTP response contract.
          maxBytes: 2 * 1024 * 1024,
          acceptedContentTypes: ['application/json', WORKFLOW_RECOVERY_V3_MEDIA_TYPE],
          validateContentLength: true,
          minimumBytes: 1,
          signal,
          failure: (_message, options) => {
            throw new WorkflowRunRecoveryError(
              options.kind === 'transport'
                ? 'WORKFLOW_RUN_RECOVERY_UNKNOWN'
                : 'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
              'Recovery evidence response could not be read completely.',
              options,
            );
          },
          messages: {
            contentType: 'invalid type',
            contentLength: 'invalid length',
            missingBody: 'missing body',
            readFailed: 'read failed',
            exceeded: 'limit exceeded',
            empty: 'empty body',
            lengthMismatch: 'length mismatch',
            aborted: 'cancelled',
          },
        });
        let decoded: string;
        try {
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (cause) {
          throw new WorkflowRunRecoveryError(
            'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
            'Recovery evidence is not valid UTF-8.',
            { cause },
          );
        }
        const page = parseWorkflowRunRecoveryEvidence(
          decoded,
          config.workspaceId,
          runId,
          selectedBindingId,
        );
        if (
          (response.headers.get('content-type') === WORKFLOW_RECOVERY_V3_MEDIA_TYPE) !==
          (page.schema === 'openslack.workflow_runner_recovery_evidence.v3')
        )
          throw new WorkflowRunRecoveryError(
            'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
            'Recovery media type and schema differ.',
          );
        if (
          result &&
          (page.schema !== result.schema ||
            page.snapshot !== result.snapshot ||
            page.recoveryVersion !== result.recoveryVersion ||
            page.readAt !== result.readAt ||
            canonical(page.route) !== canonical(result.route) ||
            (page.schema === 'openslack.workflow_runner_recovery_evidence.v1' &&
              (canonical(page.unfinished) !== canonical(result.unfinished) ||
                canonical(page.activeAttempts) !== canonical(result.activeAttempts))))
        )
          throw new WorkflowRunRecoveryError(
            'WORKFLOW_RUN_RECOVERY_UNKNOWN',
            'Recovery snapshot changed between pages.',
          );
        if (page.schema !== 'openslack.workflow_runner_recovery_evidence.v1') {
          for (const key of page.recordKeys ?? []) {
            if (seen.has(key) || (result?.nextCursor && key <= result.nextCursor))
              throw new WorkflowRunRecoveryError(
                'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
                'Recovery records repeat or reorder across pages.',
              );
            seen.add(key);
          }
        } else
          for (const entry of page.bindings) {
            if (
              seen.has(entry.bindingId) ||
              (result?.nextCursor && entry.bindingId <= result.nextCursor)
            )
              throw new WorkflowRunRecoveryError(
                'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
                'Recovery pages repeat or reorder bindings.',
              );
            seen.add(entry.bindingId);
          }
        if (
          page.schema === 'openslack.workflow_runner_recovery_evidence.v1' &&
          page.nextCursor !== null &&
          (page.bindings.length === 0 || page.nextCursor !== page.bindings.at(-1)!.bindingId)
        )
          throw new WorkflowRunRecoveryError(
            'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
            'Recovery page cursor does not advance.',
          );
        collected.bindings.push(...page.bindings);
        if (page.schema !== 'openslack.workflow_runner_recovery_evidence.v1') {
          collected.settlements.push(...(page.settlements ?? []));
          collected.unfinished.push(...page.unfinished);
          collected.activeAttempts.push(...page.activeAttempts);
          collected.recordKeys.push(...(page.recordKeys ?? []));
        }
        result = {
          ...page,
          bindings: collected.bindings,
          ...(page.schema !== 'openslack.workflow_runner_recovery_evidence.v1'
            ? {
                settlements: collected.settlements,
                unfinished: collected.unfinished,
                activeAttempts: collected.activeAttempts,
                recordKeys: collected.recordKeys,
              }
            : {}),
        };
        if (page.nextCursor === null) {
          validateWorkflowRunRecoveryEvidence(result);
          return result;
        }
      }
    },
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
      throwIfWorkflowRunnerAborted(signal);
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
        throwIfWorkflowRunnerAborted(signal);
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
          response.status === 429 || response.status >= 500
            ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_TRANSPORT_FAILED'
            : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_REJECTED',
          `Authority-binding receipt point-read returned HTTP ${response.status}.`,
        );
      }
      return boundedReceipt(response, signal);
    },
  } satisfies WorkflowRunnerAuthorityBindingPort & WorkflowRunRecoveryEvidencePort);
}
