import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('node:https', () => ({ request: requestMock }));

import { exchangeCodeForToken, parseOAuthCallback } from './server.js';

const EXPECTED_STATE = 'expected-state';

interface MockResponseOptions {
  statusCode?: number;
  chunks?: Array<string | Buffer>;
  networkError?: Error;
  neverRespond?: boolean;
}

function installResponse(options: MockResponseOptions = {}): { destroy: ReturnType<typeof vi.fn> } {
  const destroy = vi.fn();
  requestMock.mockImplementation(
    (
      _requestOptions: unknown,
      callback: (response: EventEmitter & { statusCode?: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        destroy,
        end: vi.fn(() => {
          if (options.neverRespond) return;
          if (options.networkError) {
            queueMicrotask(() => req.emit('error', options.networkError));
            return;
          }

          const response = Object.assign(new EventEmitter(), {
            statusCode: options.statusCode ?? 200,
          });
          callback(response);
          queueMicrotask(() => {
            for (const chunk of options.chunks ?? []) response.emit('data', chunk);
            response.emit('end');
          });
        }),
      });
      return req;
    },
  );
  return { destroy };
}

describe('OAuth callback parsing', () => {
  it('rejects access tokens supplied in the URL without reflecting them', () => {
    const tokenCanary = 'query-token-canary';
    const result = parseOAuthCallback(
      new URL(`http://127.0.0.1/callback?state=${EXPECTED_STATE}&access_token=${tokenCanary}`),
      EXPECTED_STATE,
    );

    expect(result).toEqual({
      accepted: false,
      message: 'OAuth token query parameters are not accepted.',
    });
    expect(JSON.stringify(result)).not.toContain(tokenCanary);
  });

  it('rejects a token query parameter even when an authorization code is present', () => {
    const result = parseOAuthCallback(
      new URL(
        `http://127.0.0.1/callback?state=${EXPECTED_STATE}&code=valid-code&access_token=token-canary`,
      ),
      EXPECTED_STATE,
    );

    expect(result.accepted).toBe(false);
  });

  it('accepts only a valid state and authorization code', () => {
    expect(
      parseOAuthCallback(
        new URL(`http://127.0.0.1/callback?state=${EXPECTED_STATE}&code=valid-code`),
        EXPECTED_STATE,
      ),
    ).toEqual({ accepted: true, code: 'valid-code' });
  });

  it('fails closed for an invalid state or missing authorization code', () => {
    expect(
      parseOAuthCallback(
        new URL('http://127.0.0.1/callback?state=wrong&code=valid-code'),
        EXPECTED_STATE,
      ),
    ).toEqual({ accepted: false, message: 'Invalid OAuth state parameter.' });
    expect(
      parseOAuthCallback(
        new URL(`http://127.0.0.1/callback?state=${EXPECTED_STATE}`),
        EXPECTED_STATE,
      ),
    ).toEqual({ accepted: false, message: 'No authorization code received.' });
  });
});

describe('OAuth token exchange', () => {
  it('accepts a bounded successful response', async () => {
    requestMock.mockReset();
    installResponse({ chunks: [JSON.stringify({ access_token: 'oauth-token' })] });

    await expect(exchangeCodeForToken('authorization-code')).resolves.toEqual({
      ok: true,
      token: 'oauth-token',
    });
  });

  it('rejects non-success responses without returning their contents', async () => {
    requestMock.mockReset();
    const canary = 'oauth-http-response-canary';
    installResponse({
      statusCode: 500,
      chunks: [JSON.stringify({ access_token: canary, message: canary })],
    });

    const result = await exchangeCodeForToken('authorization-code');
    expect(result).toEqual({ ok: false, code: 'OAUTH_TOKEN_HTTP_ERROR' });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('rejects invalid and oversized responses without returning their contents', async () => {
    requestMock.mockReset();
    const invalidCanary = 'oauth-invalid-json-canary';
    installResponse({ chunks: [`not-json-${invalidCanary}`] });
    const invalidResult = await exchangeCodeForToken('authorization-code');
    expect(invalidResult).toEqual({ ok: false, code: 'OAUTH_TOKEN_INVALID_JSON' });
    expect(JSON.stringify(invalidResult)).not.toContain(invalidCanary);

    requestMock.mockReset();
    const oversizedCanary = 'oauth-oversized-response-canary';
    installResponse({ chunks: ['x'.repeat(64 * 1024), oversizedCanary] });
    const oversizedResult = await exchangeCodeForToken('authorization-code');
    expect(oversizedResult).toEqual({ ok: false, code: 'OAUTH_TOKEN_RESPONSE_TOO_LARGE' });
    expect(JSON.stringify(oversizedResult)).not.toContain(oversizedCanary);
  });

  it('returns fixed timeout and network error codes', async () => {
    requestMock.mockReset();
    vi.useFakeTimers();
    const { destroy } = installResponse({ neverRespond: true });
    const pending = exchangeCodeForToken('authorization-code');
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(pending).resolves.toEqual({ ok: false, code: 'OAUTH_TOKEN_TIMEOUT' });
    expect(destroy).toHaveBeenCalledOnce();
    vi.useRealTimers();

    requestMock.mockReset();
    const networkCanary = 'oauth-network-error-canary';
    installResponse({ networkError: new Error(networkCanary) });
    const networkResult = await exchangeCodeForToken('authorization-code');
    expect(networkResult).toEqual({ ok: false, code: 'OAUTH_TOKEN_NETWORK_ERROR' });
    expect(JSON.stringify(networkResult)).not.toContain(networkCanary);
  });
});
