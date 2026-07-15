import type { IncomingMessage } from 'node:http';

export const DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_GITHUB_WEBHOOK_READ_TIMEOUT_MS = 5_000;

export type WebhookBodyReadErrorCode =
  | 'INVALID_CONTENT_LENGTH'
  | 'BODY_TOO_LARGE'
  | 'BODY_READ_TIMEOUT'
  | 'BODY_READ_FAILED';

export class WebhookBodyReadError extends Error {
  constructor(
    readonly code: WebhookBodyReadErrorCode,
    readonly statusCode: 400 | 408 | 413,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookBodyReadError';
  }
}

export interface WebhookBodyReadOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export function readWebhookBody(
  request: IncomingMessage,
  options: WebhookBodyReadOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_WEBHOOK_READ_TIMEOUT_MS;
  assertPositiveInteger(maxBytes, 'maxBytes');
  assertPositiveInteger(timeoutMs, 'timeoutMs');

  let declaredLength: number | undefined;
  try {
    declaredLength = parseContentLength(request.headers['content-length']);
  } catch (error) {
    guardRejectedRequest(request);
    return Promise.reject(error);
  }
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    guardRejectedRequest(request);
    return Promise.reject(
      new WebhookBodyReadError(
        'BODY_TOO_LARGE',
        413,
        `GitHub webhook body exceeds the ${maxBytes}-byte limit.`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };

    const fail = (error: WebhookBodyReadError, drain = false): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) guardRejectedRequest(request);
      reject(error);
    };

    const onData = (chunk: string | Buffer): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        fail(
          new WebhookBodyReadError(
            'BODY_TOO_LARGE',
            413,
            `GitHub webhook body exceeds the ${maxBytes}-byte limit.`,
          ),
          true,
        );
        return;
      }
      chunks.push(bytes);
    };

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    };

    const onError = (): void => {
      fail(
        new WebhookBodyReadError('BODY_READ_FAILED', 400, 'GitHub webhook body could not be read.'),
      );
    };

    const onAborted = (): void => {
      fail(
        new WebhookBodyReadError(
          'BODY_READ_FAILED',
          400,
          'GitHub webhook body was aborted before completion.',
        ),
      );
    };

    const timer = setTimeout(() => {
      fail(
        new WebhookBodyReadError(
          'BODY_READ_TIMEOUT',
          408,
          `GitHub webhook body was not received within ${timeoutMs}ms.`,
        ),
        true,
      );
    }, timeoutMs);

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

function guardRejectedRequest(request: IncomingMessage): void {
  if (request.destroyed) return;
  request.pause();
  const ignoreRejectedRequestError = (): void => {};
  const cleanup = (): void => {
    request.off('error', ignoreRejectedRequestError);
    request.off('close', cleanup);
  };
  request.on('error', ignoreRejectedRequestError);
  request.once('close', cleanup);
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new WebhookBodyReadError(
      'INVALID_CONTENT_LENGTH',
      400,
      'GitHub webhook Content-Length is invalid.',
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new WebhookBodyReadError(
      'INVALID_CONTENT_LENGTH',
      400,
      'GitHub webhook Content-Length is invalid.',
    );
  }
  return length;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}
