import { isIP } from 'node:net';
import {
  WORKFLOW_CONTROL_SHADOW_POLICY,
  WORKFLOW_CONTROL_SHADOW_ROUTE,
  createWorkflowControlShadowPublisherPort,
  prepareWorkflowControlShadowRequest,
  validateWorkflowControlShadowReceipt,
  type WorkflowControlShadowEnvelope,
  type WorkflowControlShadowPublisherPort,
} from './workflow-control-shadow.js';
import { canonicalWorkflowControlJson } from './workflow-control-contract.js';

type WorkflowControlShadowFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WorkflowControlShadowHttpPublisherOptions {
  readonly origin: string;
  readonly networkMode?: 'loopback' | 'internal';
  readonly timeoutMs?: number;
  readonly maxReceiptBytes?: number;
  readonly orderingRetryDelayMs?: number;
  readonly fetch?: WorkflowControlShadowFetch;
}

export class WorkflowControlShadowHttpError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_CONTROL_SHADOW_POLICY_INVALID'
      | 'WORKFLOW_CONTROL_SHADOW_TIMEOUT'
      | 'WORKFLOW_CONTROL_SHADOW_NETWORK_ERROR'
      | 'WORKFLOW_CONTROL_SHADOW_HTTP_ERROR'
      | 'WORKFLOW_CONTROL_SHADOW_RECEIPT_INVALID'
      | 'WORKFLOW_CONTROL_SHADOW_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowControlShadowHttpError';
  }
}

function positiveInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new WorkflowControlShadowHttpError(
      'WORKFLOW_CONTROL_SHADOW_POLICY_INVALID',
      `${name} must be a positive integer no greater than ${maximum}.`,
    );
  }
  return value;
}

function ipv4Parts(address: string): readonly number[] {
  return address.split('.').map(Number);
}

function isLoopback(address: string, version: number): boolean {
  if (version === 4) return ipv4Parts(address)[0] === 127;
  return address.toLowerCase() === '::1';
}

function isInternal(address: string, version: number): boolean {
  if (isLoopback(address, version)) return true;
  if (version === 4) {
    const [first, second] = ipv4Parts(address);
    return (
      first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  const first = Number.parseInt(address.toLowerCase().split(':')[0] ?? '', 16);
  return (
    (Number.isFinite(first) && (first & 0xfe00) === 0xfc00) ||
    (Number.isFinite(first) && (first & 0xffc0) === 0xfe80)
  );
}

function normalizeOrigin(value: string, networkMode: 'loopback' | 'internal'): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new WorkflowControlShadowHttpError(
      'WORKFLOW_CONTROL_SHADOW_POLICY_INVALID',
      'Workflow Control shadow origin must be an absolute HTTP URL.',
    );
  }
  const address =
    origin.hostname.startsWith('[') && origin.hostname.endsWith(']')
      ? origin.hostname.slice(1, -1)
      : origin.hostname;
  const version = isIP(address);
  if (
    origin.protocol !== 'http:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    (origin.pathname !== '/' && origin.pathname !== '') ||
    version === 0 ||
    (networkMode === 'loopback' ? !isLoopback(address, version) : !isInternal(address, version))
  ) {
    throw new WorkflowControlShadowHttpError(
      'WORKFLOW_CONTROL_SHADOW_POLICY_INVALID',
      'Workflow Control shadow origin must be an allowed IP-literal HTTP origin.',
    );
  }
  return origin.origin;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Rejected response bodies are already unusable.
  }
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximum) {
    await cancelBody(response);
    throw new WorkflowControlShadowHttpError(
      'WORKFLOW_CONTROL_SHADOW_RECEIPT_INVALID',
      'Workflow Control shadow receipt exceeds its declared byte limit.',
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new WorkflowControlShadowHttpError(
          'WORKFLOW_CONTROL_SHADOW_RECEIPT_INVALID',
          'Workflow Control shadow receipt exceeds its byte limit.',
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseReceipt(bytes: Uint8Array, envelope: WorkflowControlShadowEnvelope) {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw new WorkflowControlShadowHttpError(
      'WORKFLOW_CONTROL_SHADOW_RECEIPT_INVALID',
      'Workflow Control shadow receipt is not strict UTF-8 JSON.',
    );
  }
  if (`${canonicalWorkflowControlJson(value)}\n` !== text) {
    throw new WorkflowControlShadowHttpError(
      'WORKFLOW_CONTROL_SHADOW_RECEIPT_INVALID',
      'Workflow Control shadow receipt is not exact canonical JSON.',
    );
  }
  try {
    return validateWorkflowControlShadowReceipt(value, envelope);
  } catch {
    throw new WorkflowControlShadowHttpError(
      'WORKFLOW_CONTROL_SHADOW_RECEIPT_INVALID',
      'Workflow Control shadow receipt does not bind the request.',
    );
  }
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function createWorkflowControlShadowHttpPublisher(
  options: WorkflowControlShadowHttpPublisherOptions,
): WorkflowControlShadowPublisherPort {
  const networkMode = options.networkMode ?? 'loopback';
  if (networkMode !== 'loopback' && networkMode !== 'internal') {
    throw new WorkflowControlShadowHttpError(
      'WORKFLOW_CONTROL_SHADOW_POLICY_INVALID',
      'Workflow Control shadow network mode is invalid.',
    );
  }
  const origin = normalizeOrigin(options.origin, networkMode);
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? WORKFLOW_CONTROL_SHADOW_POLICY.defaultTimeoutMs,
    WORKFLOW_CONTROL_SHADOW_POLICY.maxTimeoutMs,
    'timeoutMs',
  );
  const maxReceiptBytes = positiveInteger(
    options.maxReceiptBytes ?? WORKFLOW_CONTROL_SHADOW_POLICY.maxReceiptBytes,
    WORKFLOW_CONTROL_SHADOW_POLICY.maxReceiptBytes,
    'maxReceiptBytes',
  );
  const orderingRetryDelayMs = positiveInteger(
    options.orderingRetryDelayMs ?? WORKFLOW_CONTROL_SHADOW_POLICY.defaultOrderingRetryDelayMs,
    WORKFLOW_CONTROL_SHADOW_POLICY.maxOrderingRetryDelayMs,
    'orderingRetryDelayMs',
  );
  const transport = options.fetch ?? fetch;

  return createWorkflowControlShadowPublisherPort(async (envelope) => {
    const request = prepareWorkflowControlShadowRequest(envelope);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (
        let attempt = 1;
        attempt <= WORKFLOW_CONTROL_SHADOW_POLICY.orderingRetryAttempts;
        attempt += 1
      ) {
        let response: Response;
        try {
          response = await transport(`${origin}${WORKFLOW_CONTROL_SHADOW_ROUTE}`, {
            method: 'POST',
            redirect: 'manual',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'Idempotency-Key': request.idempotencyKey,
            },
            body: request.body,
            signal: controller.signal,
          });
        } catch {
          throw new WorkflowControlShadowHttpError(
            controller.signal.aborted
              ? 'WORKFLOW_CONTROL_SHADOW_TIMEOUT'
              : 'WORKFLOW_CONTROL_SHADOW_NETWORK_ERROR',
            controller.signal.aborted
              ? 'Workflow Control shadow request exceeded its total deadline.'
              : 'Workflow Control shadow request failed.',
          );
        }
        if (
          (response.status === 404 || response.status === 409) &&
          attempt < WORKFLOW_CONTROL_SHADOW_POLICY.orderingRetryAttempts
        ) {
          await cancelBody(response);
          await wait(orderingRetryDelayMs, controller.signal);
          if (controller.signal.aborted) {
            throw new WorkflowControlShadowHttpError(
              'WORKFLOW_CONTROL_SHADOW_TIMEOUT',
              'Workflow Control shadow request exceeded its total deadline.',
            );
          }
          continue;
        }
        if (response.status === 404 || response.status === 409) {
          await cancelBody(response);
          throw new WorkflowControlShadowHttpError(
            'WORKFLOW_CONTROL_SHADOW_CONFLICT',
            'Workflow Control shadow predecessor or sequence is unavailable.',
          );
        }
        if (response.status >= 300 && response.status < 400) {
          await cancelBody(response);
          throw new WorkflowControlShadowHttpError(
            'WORKFLOW_CONTROL_SHADOW_HTTP_ERROR',
            'Workflow Control shadow redirects are forbidden.',
          );
        }
        if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
          await cancelBody(response);
          throw new WorkflowControlShadowHttpError(
            'WORKFLOW_CONTROL_SHADOW_HTTP_ERROR',
            'Workflow Control shadow returned an unexpected HTTP status.',
          );
        }
        const contentType = response.headers.get('Content-Type');
        if (
          contentType === null ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
        ) {
          await cancelBody(response);
          throw new WorkflowControlShadowHttpError(
            'WORKFLOW_CONTROL_SHADOW_RECEIPT_INVALID',
            'Workflow Control shadow receipt content type is invalid.',
          );
        }
        const receipt = parseReceipt(await readBoundedBody(response, maxReceiptBytes), envelope);
        if (
          receipt.status === 'accepted'
            ? response.status !== 201
            : receipt.status === 'duplicate'
              ? response.status !== 200
              : response.status !== 202
        ) {
          throw new WorkflowControlShadowHttpError(
            'WORKFLOW_CONTROL_SHADOW_RECEIPT_INVALID',
            'Workflow Control shadow receipt status does not match HTTP status.',
          );
        }
        if (receipt.status === 'reconciliation_required') {
          throw new WorkflowControlShadowHttpError(
            'WORKFLOW_CONTROL_SHADOW_CONFLICT',
            'Workflow Control shadow completion is ambiguous and requires reconciliation.',
          );
        }
        return receipt;
      }
      throw new WorkflowControlShadowHttpError(
        'WORKFLOW_CONTROL_SHADOW_CONFLICT',
        'Workflow Control shadow retry limit was exhausted.',
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
}
