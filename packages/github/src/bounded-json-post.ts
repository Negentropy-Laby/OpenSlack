import {
  boundedJsonRequest,
  BoundedJsonRequestError,
  DEFAULT_JSON_REQUEST_TIMEOUT_MS,
  DEFAULT_JSON_RESPONSE_MAX_BYTES,
  type BoundedJsonRequestFailureCode,
} from './bounded-json-request.js';

export { DEFAULT_JSON_REQUEST_TIMEOUT_MS, DEFAULT_JSON_RESPONSE_MAX_BYTES };

export type BoundedJsonPostFailureCode = BoundedJsonRequestFailureCode | 'INVALID_RESPONSE';

export class BoundedJsonPostError extends Error {
  constructor(
    readonly code: BoundedJsonPostFailureCode,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'BoundedJsonPostError';
  }
}

export interface BoundedJsonPostOptions {
  url: string;
  body: string | Buffer;
  headers?: Record<string, string>;
  maxResponseBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Posts a bounded request and validates only that the response is a JSON object.
 * Callers must perform endpoint-specific field and value validation.
 */
export async function boundedJsonPost(
  options: BoundedJsonPostOptions,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await boundedJsonRequest({ ...options, method: 'POST' });
  } catch (error) {
    if (error instanceof BoundedJsonRequestError) {
      throw new BoundedJsonPostError(error.code, error.status);
    }
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BoundedJsonPostError('INVALID_RESPONSE');
  }
  return parsed as Record<string, unknown>;
}
