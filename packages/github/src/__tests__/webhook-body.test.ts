import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readWebhookBody, WebhookBodyReadError } from '../webhook-body.js';

describe('readWebhookBody', () => {
  it('preserves the exact bounded bytes', async () => {
    const request = makeRequest();
    const expected = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]);
    const resultPromise = readWebhookBody(request, { maxBytes: 32, timeoutMs: 100 });

    request.end(expected);

    await expect(resultPromise).resolves.toEqual(expected);
  });

  it('rejects a declared body larger than the limit', async () => {
    const request = makeRequest({ 'content-length': '65' });

    await expect(readWebhookBody(request, { maxBytes: 64, timeoutMs: 100 })).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
      statusCode: 413,
    });
    expect(request.isPaused()).toBe(true);
  });

  it('counts streamed bytes when Content-Length is absent', async () => {
    const request = makeRequest();
    const resultPromise = readWebhookBody(request, { maxBytes: 4, timeoutMs: 100 });

    request.end(Buffer.from('12345'));

    await expect(resultPromise).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
      statusCode: 413,
    });
  });

  it('rejects invalid Content-Length deterministically', async () => {
    const request = makeRequest({ 'content-length': '-1' });

    await expect(readWebhookBody(request)).rejects.toMatchObject({
      code: 'INVALID_CONTENT_LENGTH',
      statusCode: 400,
    });
  });

  it('times out a body that never completes', async () => {
    const request = makeRequest();

    await expect(readWebhookBody(request, { maxBytes: 64, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'BODY_READ_TIMEOUT',
      statusCode: 408,
    });
  });

  it('rejects invalid limits before attaching stream listeners', () => {
    const request = makeRequest();

    expect(() => readWebhookBody(request, { maxBytes: 0 })).toThrow(TypeError);
    expect(request.listenerCount('data')).toBe(0);
  });

  it('uses a stable public error type', () => {
    const error = new WebhookBodyReadError('BODY_READ_FAILED', 400, 'failed');

    expect(error.name).toBe('WebhookBodyReadError');
    expect(error.code).toBe('BODY_READ_FAILED');
  });
});

function makeRequest(headers: Record<string, string> = {}): IncomingMessage & PassThrough {
  const stream = new PassThrough() as IncomingMessage & PassThrough;
  Object.defineProperty(stream, 'headers', { value: headers, configurable: true });
  return stream;
}
