import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore, MemoryKeychainBackend } from '@openslack/credentials';
import { applyGitHubAppImport, planGitHubAppImport } from '../app-import.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitHub App manual import', () => {
  it('keeps preview read-free and stores only the keychain reference in local config', () => {
    const root = temp();
    const readSource = vi.fn(() =>
      Buffer.from('-----BEGIN PRIVATE KEY-----\ncanary-secret\n-----END PRIVATE KEY-----'),
    );
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    const plan = planGitHubAppImport({
      localStateRoot: root,
      sourcePath: join(root, 'fixture.pem'),
      appId: '123',
      installationId: '456',
      appSlug: 'acme-agent',
      privateKeyRef: 'keychain:openslack/acme-agent',
    });
    expect(readSource).not.toHaveBeenCalled();

    const result = applyGitHubAppImport(plan, { credentialStore: store, readSource });
    const config = readFileSync(result.configPath, 'utf-8');
    expect(config).toContain('keychain:openslack/acme-agent');
    expect(config).not.toContain('canary-secret');
    expect(store.withSecret(result.privateKeyRef, (secret) => secret)).toContain('canary-secret');
  });

  it('reports optional source cleanup failure without exposing secret content', () => {
    const root = temp();
    const plan = planGitHubAppImport({
      localStateRoot: root,
      sourcePath: join(root, 'fixture.pem'),
      appId: '123',
      installationId: '456',
      appSlug: 'acme-agent',
      privateKeyRef: 'keychain:openslack/acme-agent',
      deleteSource: true,
    });
    const result = applyGitHubAppImport(plan, {
      credentialStore: new CredentialStore([new MemoryKeychainBackend()]),
      readSource: () =>
        Buffer.from('-----BEGIN PRIVATE KEY-----\ncanary-secret\n-----END PRIVATE KEY-----'),
      deleteSource: () => {
        throw new Error('delete failed with canary-secret');
      },
    });
    expect(result.sourceDeleted).toBe(false);
    expect(result.warnings.join(' ')).not.toContain('canary-secret');
  });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-app-import-'));
  roots.push(root);
  return root;
}
