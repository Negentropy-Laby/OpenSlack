import { describe, expect, it } from 'vitest';
import { readWorkflowRunnerResponseBytes } from '../workflow-runner-control-http.js';

const headers = { 'content-type': 'application/json' };
const messages = {
  contentType: 'content type',
  contentLength: 'content length',
  missingBody: 'missing body',
  readFailed: 'read failed',
  exceeded: 'exceeded',
  empty: 'empty',
  lengthMismatch: 'length mismatch',
  aborted: 'aborted',
};

function read(response: Response, signal?: AbortSignal) {
  return readWorkflowRunnerResponseBytes(response, {
    maxBytes: 4,
    minimumBytes: 2,
    validateContentLength: true,
    signal,
    messages,
    failure(message, options): never {
      throw Object.assign(new Error(message, options), {
        code: options.kind === 'transport' ? 'TRANSPORT_FAILED' : 'RESPONSE_INVALID',
      });
    },
  });
}

describe('workflow runner bounded response reads', () => {
  it.each([
    ['content type', () => new Response('{}')],
    [
      'content length',
      () => new Response('{}', { headers: { ...headers, 'content-length': 'no' } }),
    ],
    ['missing body', () => new Response(null, { headers })],
    ['exceeded', () => new Response('12345', { headers })],
    ['empty', () => new Response('', { headers })],
    [
      'length mismatch',
      () => new Response('{}', { headers: { ...headers, 'content-length': '3' } }),
    ],
  ] as const)(
    'preserves the %s integrity failure from a throwing callback',
    async (message, response) => {
      await expect(read(response())).rejects.toMatchObject({ code: 'RESPONSE_INVALID', message });
    },
  );

  it('classifies actual stream failures as transport failures and retains the private cause', async () => {
    const cause = new Error('private transport details');
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw cause;
      },
    });
    await expect(read(new Response(body, { headers }))).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
      message: 'read failed',
      cause,
    });
  });

  it.each(['before', 'during'] as const)(
    'cancels %s reading without waiting on stream cancellation',
    async (when) => {
      const controller = new AbortController();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            return new Promise(() => undefined);
          },
        }),
        { headers },
      );
      if (when === 'before') controller.abort(new Error('private cancellation details'));
      const pending = read(response, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'WORKFLOW_RUNNER_OPERATION_CANCELLED',
        message: 'Workflow runner operation was cancelled.',
      });
      controller.abort();
      await rejected;
    },
  );

  it('returns exact response bytes at the declared boundary', async () => {
    const response = new Response('{}', { headers: { ...headers, 'content-length': '2' } });
    expect(await read(response)).toEqual(Buffer.from('{}'));
  });
});
