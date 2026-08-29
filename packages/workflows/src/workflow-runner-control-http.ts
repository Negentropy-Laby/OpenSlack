import { isAbsolute, resolve } from 'node:path';
import { isWorkflowControlBearerToken } from './workflow-control-routing-identity.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

export interface WorkflowRunnerTransportConfigShape {
  readonly origin: string;
  readonly workspaceId: string;
  readonly bearerToken: string;
  readonly descriptorRoot: string;
}

export function isWorkflowRunnerTransportConfigShape(
  value: unknown,
): value is WorkflowRunnerTransportConfigShape {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<WorkflowRunnerTransportConfigShape>;
  return (
    typeof config.origin === 'string' &&
    typeof config.workspaceId === 'string' &&
    SAFE_ID.test(config.workspaceId) &&
    typeof config.bearerToken === 'string' &&
    isWorkflowControlBearerToken(config.bearerToken) &&
    typeof config.descriptorRoot === 'string' &&
    isAbsolute(config.descriptorRoot) &&
    resolve(config.descriptorRoot) === config.descriptorRoot
  );
}

export function exactWorkflowRunnerLoopbackOrigin(
  value: string,
  failure: (message: string, options?: ErrorOptions) => never,
  messages: { readonly invalid: string; readonly nonLoopback: string },
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    return failure(messages.invalid, { cause: error });
  }
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    parsed.port === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    return failure(messages.nonLoopback);
  }
  return parsed.origin;
}

export async function cancelWorkflowRunnerResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function readWorkflowRunnerResponseBytes(
  response: Response,
  options: {
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
    readonly validateContentLength: boolean;
    readonly minimumBytes: number;
    readonly failure: (message: string, options?: ErrorOptions) => never;
    readonly messages: {
      readonly contentType: string;
      readonly contentLength: string;
      readonly missingBody: string;
      readonly readFailed: string;
      readonly exceeded: string;
      readonly empty: string;
      readonly lengthMismatch: string;
      readonly aborted: string;
    };
  },
): Promise<Buffer> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (response.headers.get('content-type') !== 'application/json') {
      return options.failure(options.messages.contentType);
    }
    const declaredLength = response.headers.get('content-length');
    let expectedLength: number | null = null;
    if (options.validateContentLength && declaredLength !== null) {
      const parsed = Number(declaredLength);
      if (
        !Number.isSafeInteger(parsed) ||
        parsed < options.minimumBytes ||
        parsed > options.maxBytes
      ) {
        return options.failure(options.messages.contentLength);
      }
      expectedLength = parsed;
    }
    reader = response.body?.getReader();
    if (!reader) return options.failure(options.messages.missingBody);

    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error(options.messages.aborted);
      }
      let abort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(options.signal?.reason ?? new Error(options.messages.aborted));
        options.signal?.addEventListener('abort', abort, { once: true });
      });
      let next;
      try {
        next = await Promise.race([reader.read(), aborted]);
      } finally {
        if (abort) options.signal?.removeEventListener('abort', abort);
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > options.maxBytes) return options.failure(options.messages.exceeded);
      chunks.push(next.value);
    }
    if (size < options.minimumBytes) return options.failure(options.messages.empty);
    if (expectedLength !== null && expectedLength !== size) {
      return options.failure(options.messages.lengthMismatch);
    }
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      size,
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return options.failure(options.messages.readFailed, { cause: error });
  } finally {
    await reader?.cancel().catch(() => undefined);
    if (!reader) await response.body?.cancel().catch(() => undefined);
  }
}
