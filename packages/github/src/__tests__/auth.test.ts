import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore, MemoryKeychainBackend } from '@openslack/credentials';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('node:https', () => ({ request: requestMock }));

import { clearTokenCache, getAppInstallationToken, requireAppInstallationToken } from '../auth.js';
import { boundedJsonPost } from '../bounded-json-post.js';
import { getClient } from '../client.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TOKEN_ENV_KEYS = [
  'OPENSLACK_GITHUB_APP_ID',
  'OPENSLACK_GITHUB_APP_INSTALLATION_ID',
  'OPENSLACK_GITHUB_APP_PRIVATE_KEY',
] as const;
const originalEnv = new Map<string, string | undefined>();
const roots: string[] = [];

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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

  it('loads ordinary-workspace App metadata and resolves only its keychain reference', async () => {
    for (const key of TOKEN_ENV_KEYS) delete process.env[key];
    const root = createWorkspace();
    const nested = join(root, 'project', 'nested');
    mkdirSync(nested, { recursive: true });
    const backend = new MemoryKeychainBackend();
    const store = new CredentialStore([backend]);
    store.putIfAbsent('keychain:openslack/test-app', PRIVATE_KEY);
    installResponse({ chunks: [JSON.stringify(tokenResponse('local-installation-token'))] });

    const client = await getClient({
      cwd: nested,
      repoFullName: 'acme/project',
      auth: 'app',
      credentialStore: store,
    });

    expect(client).toMatchObject({
      authMode: 'github_app_installation',
      appSlug: 'local-app',
      isDryRun: false,
    });
    await expect(
      getClient({
        cwd: nested,
        repoFullName: 'acme/project',
        auth: 'app',
        credentialStore: store,
      }),
    ).resolves.toMatchObject({ tokenExpiresAt: client.tokenExpiresAt });
    expect(JSON.stringify(requestMock.mock.calls)).not.toContain(PRIVATE_KEY);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('redacts credential backend failures and never mixes partial environment config', async () => {
    const root = createWorkspace();
    const withSecret = vi.fn(() => {
      throw new Error('backend failed with private-key-canary');
    });
    process.env.OPENSLACK_GITHUB_APP_ID = '123';
    delete process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID;
    delete process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY;

    const partial = requireAppInstallationToken({
      localStateRoot: join(root, '.openslack.local'),
      credentialStore: { withSecret },
    });
    await expect(partial).rejects.toMatchObject({ code: 'APP_CONFIG_INVALID' });
    expect(withSecret).not.toHaveBeenCalled();

    delete process.env.OPENSLACK_GITHUB_APP_ID;
    const unavailable = requireAppInstallationToken({
      localStateRoot: join(root, '.openslack.local'),
      credentialStore: { withSecret },
    });
    await expect(unavailable).rejects.toMatchObject({
      code: 'APP_CONFIG_MISSING',
      message: 'GitHub App private-key credential is unavailable.',
    });
    await unavailable.catch((error: unknown) => {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(
        'private-key-canary',
      );
    });
  });
});

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-app-auth-'));
  roots.push(root);
  const localStateRoot = join(root, '.openslack.local');
  mkdirSync(localStateRoot, { recursive: true });
  writeFileSync(
    join(root, 'openslack.yaml'),
    'schema: openslack.workspace.v1\ncanonical_remote:\n  provider: github\n  owner: acme\n  repo: project\n  default_branch: main\n',
  );
  writeFileSync(
    join(localStateRoot, 'github-app.json'),
    `${JSON.stringify(
      {
        schema: 'openslack.github_app_local.v1',
        appId: '123',
        installationId: '456',
        appSlug: 'local-app',
        privateKeyRef: 'keychain:openslack/test-app',
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

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
