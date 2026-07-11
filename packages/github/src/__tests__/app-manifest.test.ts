import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialStore,
  MemoryKeychainBackend,
  UnavailableKeychainBackend,
} from '@openslack/credentials';
import {
  completeGitHubAppManifest,
  createGitHubAppManifestSession,
  exchangeGitHubAppManifestCode,
  type GitHubAppManifestInput,
} from '../app-manifest.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitHub App Manifest session', () => {
  it('uses a 256-bit state and rejects mismatch, expiry, and replay', () => {
    const session = createGitHubAppManifestSession(input(), {
      now: 1_000,
      ttlMs: 2_000,
      randomState: () => Buffer.alloc(32, 7),
    });
    expect(Buffer.from(session.state, 'base64url')).toHaveLength(32);
    expect(() => session.consume('wrong', 1_500)).toThrow(/state is invalid/);
    session.consume(session.state, 2_000);
    expect(() => session.consume(session.state, 2_001)).toThrow(/already been consumed/);

    const expired = createGitHubAppManifestSession(input(), { now: 1_000, ttlMs: 10 });
    expect(() => expired.consume(expired.state, 1_011)).toThrow(/expired/);
  });

  it('only accepts a loopback callback and emits the required write permissions', () => {
    expect(() =>
      createGitHubAppManifestSession({ ...input(), callbackUrl: 'http://0.0.0.0:8200/callback' }),
    ).toThrow(/loopback/);
    const session = createGitHubAppManifestSession(input());
    expect(session.manifest.default_permissions).toEqual({
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
    });
    expect(() =>
      createGitHubAppManifestSession({
        ...input(),
        homepageUrl: 'https://user:password@example.com/#fragment',
      }),
    ).toThrow(/credential-free HTTPS/);
  });
});

describe('GitHub App Manifest conversion', () => {
  it('stores secrets in distinct keychain refs and writes references only', async () => {
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    const result = await completeGitHubAppManifest(input(), 'a'.repeat(40), {
      credentialStore: store,
      exchangeCode: async () => conversion(),
    });
    const config = readFileSync(result.configPath, 'utf-8');
    expect(config).toContain('keychain:openslack/app-private-key');
    expect(config).not.toContain('canary-webhook-secret');
    expect(config).not.toContain('canary-client-secret');
    expect(store.withSecret(result.privateKeyRef, (secret) => secret)).toContain('PRIVATE KEY');
  });

  it('rolls back already stored secrets when the transaction fails', async () => {
    const backend = new MemoryKeychainBackend();
    const store = new CredentialStore([backend]);
    const put = vi.spyOn(store, 'putIfAbsent');
    put.mockImplementationOnce((ref, secret) => backend.putIfAbsent(ref as never, secret));
    put.mockImplementationOnce(() => {
      throw new Error('write failed with canary-webhook');
    });
    await expect(
      completeGitHubAppManifest(input(), 'b'.repeat(40), {
        credentialStore: store,
        exchangeCode: async () => conversion(),
      }),
    ).rejects.toThrow('could not be committed safely');
    expect(() =>
      store.withSecret('keychain:openslack/app-private-key', (secret) => secret),
    ).toThrow(/unavailable/);
  });

  it('writes a reference-only reconcile receipt when rollback deletion fails', async () => {
    const manifestInput = input();
    const backend = new MemoryKeychainBackend();
    const store = new CredentialStore([backend]);
    vi.spyOn(store, 'putIfAbsent')
      .mockImplementationOnce((ref, secret) => backend.putIfAbsent(ref as never, secret))
      .mockImplementationOnce(() => {
        throw new Error('commit failed with canary-secret');
      });
    vi.spyOn(store, 'delete').mockImplementation(() => {
      throw new Error('delete failed with canary-secret');
    });
    await expect(
      completeGitHubAppManifest(manifestInput, 'g'.repeat(40), {
        credentialStore: store,
        exchangeCode: async () => conversion(),
      }),
    ).rejects.toThrow(/reconciliation is required/);
    const receipts = readdirSync(join(manifestInput.localStateRoot, 'reconcile'));
    expect(receipts).toHaveLength(1);
    const receipt = readFileSync(
      join(manifestInput.localStateRoot, 'reconcile', receipts[0]!),
      'utf-8',
    );
    expect(receipt).toContain('keychain:openslack/app-private-key');
    expect(receipt).not.toContain('canary-secret');
  });

  it('refuses to overwrite an existing credential reference', async () => {
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    store.put('keychain:openslack/app-private-key', 'existing-private-key');
    await expect(
      completeGitHubAppManifest(input(), 'd'.repeat(40), {
        credentialStore: store,
        exchangeCode: async () => conversion(),
      }),
    ).rejects.toThrow(/reference already exists/);
    expect(store.withSecret('keychain:openslack/app-private-key', (secret) => secret)).toBe(
      'existing-private-key',
    );
  });

  it('fails preflight before exchange when the keychain is unavailable', async () => {
    const exchangeCode = vi.fn();
    await expect(
      completeGitHubAppManifest(input(), 'e'.repeat(40), {
        credentialStore: new CredentialStore([new UnavailableKeychainBackend()]),
        exchangeCode,
      }),
    ).rejects.toThrow(/available writable keychain/);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('redacts an exchange implementation error before it crosses the package boundary', async () => {
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    const failure = completeGitHubAppManifest(input(), 'h'.repeat(40), {
      credentialStore: store,
      exchangeCode: async () => {
        throw new Error('network failed with canary-secret');
      },
    });
    const message = await failure.then(
      () => 'unexpected success',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(message).toBe('GitHub App Manifest exchange failed safely.');
    expect(message).not.toContain('canary-secret');
  });

  it('rejects malformed key material before writing any credential', async () => {
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    await expect(
      completeGitHubAppManifest(input(), 'f'.repeat(40), {
        credentialStore: store,
        exchangeCode: async () => ({
          ...conversion(),
          pem: '-----BEGIN PRIVATE KEY-----\ninvalid',
        }),
      }),
    ).rejects.toThrow(/invalid private key/);
    expect(store.has('keychain:openslack/app-private-key')).toBe(false);
  });

  it('bounds the conversion response before parsing it', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('x'.repeat(33), { status: 200, headers: { 'content-length': '33' } }),
    );
    await expect(
      exchangeGitHubAppManifestCode('c'.repeat(40), { fetchImpl, maxResponseBytes: 32 }),
    ).rejects.toThrow(/size limit/);
  });
});

function input(): GitHubAppManifestInput {
  const root = mkdtempSync(join(tmpdir(), 'openslack-app-manifest-'));
  roots.push(root);
  return {
    localStateRoot: root,
    callbackUrl: 'http://127.0.0.1:8200/callback',
    appName: 'OpenSlack Agent Operator',
    organization: 'Negentropy-Laby',
    privateKeyRef: 'keychain:openslack/app-private-key',
    webhookSecretRef: 'keychain:openslack/app-webhook-secret',
    clientSecretRef: 'keychain:openslack/app-client-secret',
  };
}

function conversion() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  return {
    id: 123,
    slug: 'openslack-agent-operator',
    client_id: 'Iv1.example',
    client_secret: 'canary-client-secret',
    webhook_secret: 'canary-webhook-secret',
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
