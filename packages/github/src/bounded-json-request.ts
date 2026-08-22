import { request as httpsRequest } from 'node:https';

export const DEFAULT_JSON_RESPONSE_MAX_BYTES = 64 * 1024;
export const DEFAULT_JSON_REQUEST_TIMEOUT_MS = 10_000;

export type BoundedJsonRequestFailureCode =
  | 'ABORTED'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'NETWORK_ERROR'
  | 'RESPONSE_TOO_LARGE'
  | 'TIMEOUT';

export class BoundedJsonRequestError extends Error {
  constructor(
    readonly code: BoundedJsonRequestFailureCode,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'BoundedJsonRequestError';
  }
}

export interface BoundedJsonRequestOptions {
  url: string;
  method: 'GET' | 'POST';
  body?: string | Buffer;
  headers?: Record<string, string>;
  maxResponseBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function boundedJsonRequest(options: BoundedJsonRequestOptions): Promise<unknown> {
  if (options.signal?.aborted) throw new BoundedJsonRequestError('ABORTED');
  const endpoint = new URL(options.url);
  const requestBody =
    options.body === undefined
      ? null
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_JSON_RESPONSE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JSON_REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseReceived = false;
    let request: ReturnType<typeof httpsRequest> | undefined;

    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortRequest);
    };
    const rejectSafe = (code: BoundedJsonRequestFailureCode, status?: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new BoundedJsonRequestError(code, status));
    };
    const resolveSafe = (value: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const abortRequest = (): void => {
      rejectSafe('ABORTED');
      request?.destroy();
    };
    const timeout = setTimeout(() => {
      rejectSafe('TIMEOUT');
      request?.destroy();
    }, timeoutMs);

    try {
      request = httpsRequest(
        {
          hostname: endpoint.hostname,
          port: endpoint.port || undefined,
          path: endpoint.pathname + endpoint.search,
          method: options.method,
          headers: {
            ...options.headers,
            ...(requestBody === null ? {} : { 'Content-Length': requestBody.byteLength }),
          },
        },
        (response) => {
          responseReceived = true;
          response.on('error', () => rejectSafe('NETWORK_ERROR'));
          response.on('aborted', () => rejectSafe('NETWORK_ERROR'));
          response.on('close', () => {
            if (!response.complete) rejectSafe('NETWORK_ERROR');
          });

          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            const status = response.statusCode ?? 0;
            response.resume();
            rejectSafe('HTTP_ERROR', status);
            request?.destroy();
            return;
          }

          const chunks: Buffer[] = [];
          let responseBytes = 0;
          response.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            responseBytes += bytes.byteLength;
            if (responseBytes > maxResponseBytes) {
              chunks.length = 0;
              rejectSafe('RESPONSE_TOO_LARGE');
              request?.destroy();
              return;
            }
            chunks.push(bytes);
          });
          response.on('end', () => {
            if (settled) return;
            if (response.complete === false) {
              rejectSafe('NETWORK_ERROR');
              return;
            }
            let text: string;
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks, responseBytes),
              );
            } catch {
              rejectSafe('INVALID_JSON');
              return;
            }
            try {
              resolveSafe(JSON.parse(text) as unknown);
            } catch {
              rejectSafe('INVALID_JSON');
            }
          });
        },
      );
    } catch {
      rejectSafe('NETWORK_ERROR');
      return;
    }

    request.on('error', () => rejectSafe('NETWORK_ERROR'));
    request.on('close', () => {
      if (!responseReceived) rejectSafe('NETWORK_ERROR');
    });
    options.signal?.addEventListener('abort', abortRequest, { once: true });
    if (options.signal?.aborted) {
      abortRequest();
      return;
    }

    try {
      if (requestBody !== null) request.write(requestBody);
      request.end();
    } catch {
      rejectSafe('NETWORK_ERROR');
    }
  });
}
