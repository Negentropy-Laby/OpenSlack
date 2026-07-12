import { request as httpsRequest } from 'node:https';

export const DEFAULT_JSON_RESPONSE_MAX_BYTES = 64 * 1024;
export const DEFAULT_JSON_REQUEST_TIMEOUT_MS = 10_000;

export type BoundedJsonPostFailureCode =
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'RESPONSE_TOO_LARGE'
  | 'TIMEOUT';

export class BoundedJsonPostError extends Error {
  constructor(readonly code: BoundedJsonPostFailureCode) {
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
}

/**
 * Posts a bounded request and validates only that the response is a JSON object.
 * Callers must perform endpoint-specific field and value validation.
 */
export async function boundedJsonPost(
  options: BoundedJsonPostOptions,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(options.url);
  const requestBody = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_JSON_RESPONSE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JSON_REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    const requestState: { timeout?: ReturnType<typeof setTimeout> } = {};

    const rejectSafe = (code: BoundedJsonPostFailureCode): void => {
      if (settled) return;
      settled = true;
      if (requestState.timeout) clearTimeout(requestState.timeout);
      reject(new BoundedJsonPostError(code));
    };

    const resolveSafe = (value: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      if (requestState.timeout) clearTimeout(requestState.timeout);
      resolve(value);
    };

    let req: ReturnType<typeof httpsRequest>;
    try {
      req = httpsRequest(
        {
          hostname: endpoint.hostname,
          port: endpoint.port || undefined,
          path: endpoint.pathname + endpoint.search,
          method: 'POST',
          headers: {
            ...options.headers,
            'Content-Length': requestBody.byteLength,
          },
        },
        (response) => {
          response.on('error', () => rejectSafe('NETWORK_ERROR'));
          response.on('aborted', () => rejectSafe('NETWORK_ERROR'));

          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            rejectSafe('HTTP_ERROR');
            req.destroy();
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
              req.destroy();
              return;
            }
            chunks.push(bytes);
          });
          response.on('end', () => {
            if (settled) return;

            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks, responseBytes).toString('utf8'));
            } catch {
              rejectSafe('INVALID_JSON');
              return;
            }

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              rejectSafe('INVALID_RESPONSE');
              return;
            }
            resolveSafe(parsed as Record<string, unknown>);
          });
        },
      );
    } catch {
      rejectSafe('NETWORK_ERROR');
      return;
    }

    requestState.timeout = setTimeout(() => {
      rejectSafe('TIMEOUT');
      req.destroy();
    }, timeoutMs);
    requestState.timeout.unref();
    req.on('error', () => rejectSafe('NETWORK_ERROR'));

    try {
      req.write(requestBody);
      req.end();
    } catch {
      rejectSafe('NETWORK_ERROR');
    }
  });
}
