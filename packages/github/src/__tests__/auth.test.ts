import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('node:https', () => ({ request: requestMock }));

import { clearTokenCache, getAppInstallationToken } from '../auth.js';
import { boundedJsonPost } from '../bounded-json-post.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TOKEN_ENV_KEYS = [
  'OPENSLACK_GITHUB_APP_ID',
  'OPENSLACK_GITHUB_APP_INSTALLATION_ID',
  'OPENSLACK_GITHUB_APP_PRIVATE_KEY',
] as const;
const originalEnv = new Map<string, string | undefined>();
let consoleError: ReturnType<typeof vi.spyOn>;

interface MockResponseOptions {
  statusCode?: number;
  chunks?: Array<string | Buffer>;
  networkError?: Error;
  responseError?: Error;
  neverRespond?: boolean;
}

function installResponse(options: MockResponseOptions = {}): { destroy: ReturnType<typeof vi.fn> } {
  const destroy = vi.fn();
  requestMock.mockImplementation(
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

function loggedErrors(): string {
  return JSON.stringify(consoleError.mock.calls);
}

beforeEach(() => {
  for (const key of TOKEN_ENV_KEYS) originalEnv.set(key, process.env[key]);
  process.env.OPENSLACK_GITHUB_APP_ID = '123';
  process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID = '456';
  process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY = PRIVATE_KEY;
  requestMock.mockReset();
  clearTokenCache();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  consoleError.mockRestore();
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

  it('accepts a bounded, successful token response', async () => {
    installResponse({
      chunks: [
        JSON.stringify({
          token: 'installation-token',
          expires_at: '2030-01-01T00:00:00.000Z',
        }),
      ],
    });

    await expect(getAppInstallationToken()).resolves.toEqual({
      token: 'installation-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
      tokenType: 'installation',
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not log an HTTP error response body', async () => {
    const canary = 'http-response-secret-canary';
    const { destroy } = installResponse({
      statusCode: 403,
      chunks: [JSON.stringify({ message: canary })],
    });

    await expect(getAppInstallationToken()).resolves.toBeNull();
    expect(destroy).toHaveBeenCalledOnce();
    expect(loggedErrors()).toContain('APP_TOKEN_HTTP_ERROR');
    expect(loggedErrors()).not.toContain(canary);
  });

  it('does not log invalid JSON or a missing-token response', async () => {
    const invalidJsonCanary = 'invalid-json-secret-canary';
    installResponse({ chunks: [`not-json-${invalidJsonCanary}`] });

    await expect(getAppInstallationToken()).resolves.toBeNull();
    expect(loggedErrors()).toContain('APP_TOKEN_INVALID_JSON');
    expect(loggedErrors()).not.toContain(invalidJsonCanary);

    consoleError.mockClear();
    installResponse({ chunks: [JSON.stringify({ repository_selection: 'missing-token-canary' })] });
    await expect(getAppInstallationToken()).resolves.toBeNull();
    expect(loggedErrors()).toContain('APP_TOKEN_INVALID_RESPONSE');
    expect(loggedErrors()).not.toContain('missing-token-canary');
  });

  it('bounds the response body without logging its contents', async () => {
    const canary = 'oversized-response-secret-canary';
    installResponse({ chunks: ['x'.repeat(64 * 1024), canary] });

    await expect(getAppInstallationToken()).resolves.toBeNull();
    expect(loggedErrors()).toContain('APP_TOKEN_RESPONSE_TOO_LARGE');
    expect(loggedErrors()).not.toContain(canary);
  });

  it('returns a fixed timeout error without exposing transport details', async () => {
    vi.useFakeTimers();
    const { destroy } = installResponse({ neverRespond: true });
    const pending = getAppInstallationToken();

    await vi.advanceTimersByTimeAsync(10_001);

    await expect(pending).resolves.toBeNull();
    expect(destroy).toHaveBeenCalledOnce();
    expect(loggedErrors()).toContain('APP_TOKEN_TIMEOUT');
  });

  it('does not log network error messages', async () => {
    const canary = 'network-error-secret-canary';
    installResponse({ networkError: new Error(canary) });

    await expect(getAppInstallationToken()).resolves.toBeNull();
    expect(loggedErrors()).toContain('APP_TOKEN_NETWORK_ERROR');
    expect(loggedErrors()).not.toContain(canary);
  });

  it('maps response-stream failures to the same fixed network error', async () => {
    const canary = 'response-stream-error-secret-canary';
    installResponse({ responseError: new Error(canary) });

    await expect(getAppInstallationToken()).resolves.toBeNull();
    expect(loggedErrors()).toContain('APP_TOKEN_NETWORK_ERROR');
    expect(loggedErrors()).not.toContain(canary);
  });
});
