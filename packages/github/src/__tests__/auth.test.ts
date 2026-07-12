import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('node:https', () => ({ request: requestMock }));

import { clearTokenCache, getAppInstallationToken, requireAppInstallationToken } from '../auth.js';
import { boundedJsonPost } from '../bounded-json-post.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TOKEN_ENV_KEYS = [
  'OPENSLACK_GITHUB_APP_ID',
  'OPENSLACK_GITHUB_APP_INSTALLATION_ID',
  'OPENSLACK_GITHUB_APP_PRIVATE_KEY',
] as const;
const originalEnv = new Map<string, string | undefined>();

interface MockResponseOptions {
  statusCode?: number;
  chunks?: Array<string | Buffer>;
  networkError?: Error;
  responseError?: Error;
  neverRespond?: boolean;
}

function installResponse(options: MockResponseOptions = {}): { destroy: ReturnType<typeof vi.fn> } {
  const destroy = vi.fn();
  requestMock.mockImplementationOnce(
    (
      _requestOptions: unknown,
      callback: (response: EventEmitter & { statusCode?: number }) => void,
    ) => {
      const request = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        destroy,
        end: vi.fn(() => {
          if (options.neverRespond) return;
          if (options.networkError) {
            queueMicrotask(() => request.emit('error', options.networkError));
            return;
          }

          const response = Object.assign(new EventEmitter(), {
            statusCode: options.statusCode ?? 201,
            resume: vi.fn(),
          });
          callback(response);
          queueMicrotask(() => {
            if (options.responseError) {
              response.emit('error', options.responseError);
              return;
            }
            for (const chunk of options.chunks ?? []) response.emit('data', chunk);
            response.emit('end');
          });
        }),
      });
      return request;
    },
  );
  return { destroy };
}

beforeEach(() => {
  for (const key of TOKEN_ENV_KEYS) originalEnv.set(key, process.env[key]);
  process.env.OPENSLACK_GITHUB_APP_ID = '123';
  process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID = '456';
  process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY = PRIVATE_KEY;
  requestMock.mockReset();
  clearTokenCache();
});

afterEach(() => {
  vi.useRealTimers();
  clearTokenCache();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('GitHub App installation token response handling', () => {
  it('counts raw response bytes exactly across a split UTF-8 sequence', async () => {
    const payload = Buffer.from(JSON.stringify({ value: 'split-😀-sequence' }));
    const emojiStart = payload.indexOf(Buffer.from('😀'));
    const chunks = [payload.subarray(0, emojiStart + 1), payload.subarray(emojiStart + 1)];
    installResponse({ chunks });

    await expect(
      boundedJsonPost({
        url: 'https://api.github.com/test',
        body: '{}',
        maxResponseBytes: payload.byteLength,
      }),
    ).resolves.toEqual({ value: 'split-😀-sequence' });

    installResponse({ chunks });
    await expect(
      boundedJsonPost({
        url: 'https://api.github.com/test',
        body: '{}',
        maxResponseBytes: payload.byteLength - 1,
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('returns a typed, installation-bound token without logging it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    installResponse({
      chunks: [JSON.stringify(tokenResponse('installation-token'))],
    });

    await expect(requireAppInstallationToken()).resolves.toEqual({
      token: 'installation-token',
      expiresAt: expect.any(String),
      tokenType: 'installation',
      appId: '123',
      installationId: '456',
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it.each([
    {
      name: 'HTTP rejection',
      options: { statusCode: 403, chunks: ['http-response-secret-canary'] },
      code: 'APP_TOKEN_REQUEST_FAILED',
    },
    {
      name: 'invalid JSON',
      options: { chunks: ['invalid-json-secret-canary'] },
      code: 'APP_TOKEN_INVALID',
    },
    {
      name: 'network failure',
      options: { networkError: new Error('network-error-secret-canary') },
      code: 'APP_TOKEN_REQUEST_FAILED',
    },
    {
      name: 'response stream failure',
      options: { responseError: new Error('response-stream-error-secret-canary') },
      code: 'APP_TOKEN_REQUEST_FAILED',
    },
  ])('maps $name to a fixed non-secret error', async ({ options, code }) => {
    installResponse(options);
    const result = requireAppInstallationToken().catch((error: unknown) => error);
    const error = await result;

    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toMatch(/secret-canary/);
  });

  it('bounds the response body and keeps the compatibility API fail-closed', async () => {
    installResponse({ chunks: ['x'.repeat(64 * 1024), 'oversized-response-secret-canary'] });
    await expect(getAppInstallationToken()).resolves.toBeNull();
  });

  it('returns a fixed timeout without exposing transport details', async () => {
    vi.useFakeTimers();
    const { destroy } = installResponse({ neverRespond: true });
    const pending = requireAppInstallationToken().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_001);

    await expect(pending).resolves.toMatchObject({ code: 'APP_TOKEN_REQUEST_FAILED' });
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('GitHub App installation token cache', () => {
  it('does not let an invalidated in-flight request overwrite a newer token', async () => {
    const first = deferred<TokenResponse>();
    const second = deferred<TokenResponse>();
    installDeferredResponse(first.promise);
    installDeferredResponse(second.promise);

    const staleRequest = requireAppInstallationToken();
    clearTokenCache();
    const currentRequest = requireAppInstallationToken();
    second.resolve(tokenResponse('current-token'));
    expect((await currentRequest).token).toBe('current-token');
    first.resolve(tokenResponse('stale-token'));
    expect((await staleRequest).token).toBe('stale-token');

    expect((await requireAppInstallationToken()).token).toBe('current-token');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});

interface TokenResponse {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
}

function tokenResponse(token: string): TokenResponse {
  return {
    token,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    permissions: { contents: 'write', pull_requests: 'write' },
  };
}

function installDeferredResponse(response: Promise<TokenResponse>): void {
  requestMock.mockImplementationOnce(
    (_options: unknown, callback: (response: EventEmitter & { statusCode: number }) => void) => {
      const request = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        destroy: vi.fn(),
        end: vi.fn(() => {
          void response.then((payload) => {
            const incoming = Object.assign(new EventEmitter(), { statusCode: 201 });
            callback(incoming);
            incoming.emit('data', Buffer.from(JSON.stringify(payload)));
            incoming.emit('end');
          });
        }),
      });
      return request;
    },
  );
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
