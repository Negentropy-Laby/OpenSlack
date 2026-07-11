import { createServer, request } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore, MemoryKeychainBackend } from '@openslack/credentials';
import { assertLoopbackHost, isExpectedHost, startAuthServer } from './server.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitHub App Manifest callback server', () => {
  it('rejects non-loopback bind hosts', () => {
    expect(() => assertLoopbackHost('0.0.0.0')).toThrow(/127\.0\.0\.1/);
    expect(() => assertLoopbackHost('localhost')).toThrow(/127\.0\.0\.1/);
    expect(() => assertLoopbackHost('127.0.0.1')).not.toThrow();
    expect(isExpectedHost('evil.example:8200', '127.0.0.1', 8200)).toBe(false);
    expect(isExpectedHost('127.0.0.1:8200', '127.0.0.1', 8200)).toBe(true);
  });

  it('does not accept an access_token query as a credential', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-auth-callback-'));
    roots.push(root);
    const port = await freePort();
    const exchangeCode = vi.fn();
    const completion = startAuthServer({
      host: '127.0.0.1',
      port,
      timeoutMs: 250,
      workspaceRoot: root,
      credentialStore: new CredentialStore([new MemoryKeychainBackend()]),
      exchangeCode,
    });
    const page = await fetchWhenReady(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    const rebound = await requestWithHost(port, 'evil.example:8200');
    expect(rebound.status).toBe(421);
    expect(rebound.body).not.toContain('state=');
    const state = /state=([^&"]+)/.exec(html)?.[1];
    expect(state).toBeTruthy();
    const response = await fetch(
      `http://127.0.0.1:${port}/callback?state=${state}&access_token=canary-token`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('canary-token');
    expect(exchangeCode).not.toHaveBeenCalled();

    const responseWithCode = await fetch(
      `http://127.0.0.1:${port}/callback?state=${state}&code=${'a'.repeat(40)}&access_token=second-canary-token`,
    );
    expect(responseWithCode.status).toBe(400);
    expect(await responseWithCode.text()).not.toContain('second-canary-token');
    expect(exchangeCode).not.toHaveBeenCalled();
    await expect(completion).resolves.toEqual({ status: 'timed_out' });
  });

  it('does not consume state for a missing code and does not timeout while processing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-auth-callback-processing-'));
    roots.push(root);
    const port = await freePort();
    let release!: (value: unknown) => void;
    const exchangeCode = vi.fn(
      async () => await new Promise<unknown>((resolve) => (release = resolve)),
    );
    const completion = startAuthServer({
      port,
      timeoutMs: 100,
      workspaceRoot: root,
      credentialStore: new CredentialStore([new MemoryKeychainBackend()]),
      exchangeCode,
    });
    const page = await fetchWhenReady(`http://127.0.0.1:${port}/`);
    const state = /state=([^&"]+)/.exec(await page.text())?.[1];
    expect(state).toBeTruthy();
    const missing = await fetch(`http://127.0.0.1:${port}/callback?state=${state}`);
    expect(missing.status).toBe(400);
    const callback = fetch(
      `http://127.0.0.1:${port}/callback?state=${state}&code=${'a'.repeat(40)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pending = await Promise.race([
      completion.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 10)),
    ]);
    expect(pending).toBe(true);
    release(validConversion());
    expect((await callback).status).toBe(200);
    await expect(completion).resolves.toMatchObject({ status: 'completed', appId: '123' });
  });
});

function validConversion() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  return {
    id: 123,
    slug: 'openslack-agent-operator',
    client_id: 'Iv1.example',
    client_secret: 'client-secret-value',
    webhook_secret: 'webhook-secret-value',
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function requestWithHost(
  port: number,
  host: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const outgoing = request(
      { hostname: '127.0.0.1', port, path: '/', headers: { Host: host } },
      (response) => {
        let body = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function fetchWhenReady(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Callback test server did not start.');
}
