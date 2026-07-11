import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CredentialStore,
  CredentialStoreError,
  EnvironmentCredentialBackend,
  MemoryKeychainBackend,
  NativeKeychainBackend,
  parseSecretReference,
} from '../index.js';

describe('credential references and store', () => {
  it('parses only canonical env and keychain references', () => {
    expect(parseSecretReference('env:OPENSLACK_TOKEN')).toMatchObject({
      scheme: 'env',
      name: 'OPENSLACK_TOKEN',
    });
    expect(parseSecretReference('keychain:openslack/github-app')).toMatchObject({
      scheme: 'keychain',
      service: 'openslack',
      account: 'github-app',
    });
    for (const invalid of [
      'raw-secret',
      'file:secret.pem',
      'env:lowercase',
      'keychain:../secret',
    ]) {
      expect(() => parseSecretReference(invalid)).toThrow();
    }
  });

  it('resolves environment secrets only inside the consumer callback', () => {
    const store = new CredentialStore([
      new EnvironmentCredentialBackend({ OPENSLACK_TOKEN: 'canary-secret' }),
    ]);
    expect(store.withSecret('env:OPENSLACK_TOKEN', (secret) => secret.length)).toBe(13);
    expect(() => store.withSecret('env:MISSING_TOKEN', () => undefined)).toThrowError(
      expect.objectContaining<Partial<CredentialStoreError>>({ code: 'CREDENTIAL_UNAVAILABLE' }),
    );
  });

  it('supports injected keychain roundtrip and deletion without a file fallback', () => {
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    store.put('keychain:openslack/github-app', 'canary-private-key');
    expect(store.withSecret('keychain:openslack/github-app', (secret) => secret.length)).toBe(18);
    store.delete('keychain:openslack/github-app');
    expect(() => store.withSecret('keychain:openslack/github-app', () => undefined)).toThrowError(
      expect.objectContaining<Partial<CredentialStoreError>>({ code: 'CREDENTIAL_UNAVAILABLE' }),
    );
  });

  it('supports atomic create-only writes without replacing existing values', () => {
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    store.putIfAbsent('keychain:openslack/app', 'first');
    expect(() => store.putIfAbsent('keychain:openslack/app', 'second')).toThrowError(
      expect.objectContaining<Partial<CredentialStoreError>>({ code: 'CREDENTIAL_ALREADY_EXISTS' }),
    );
    expect(store.withSecret('keychain:openslack/app', (secret) => secret)).toBe('first');
  });

  it('uses an injected native keyring entry with a cross-process create-only lock', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'openslack-native-keyring-test-'));
    const values = new Map<string, string>();
    const backend = new NativeKeychainBackend({
      lockRoot,
      platform: 'win32',
      entryFactory: (service, account) => {
        const key = `${service}/${account}`;
        return {
          getPassword: () => values.get(key) ?? null,
          setPassword: (value) => {
            values.set(key, value);
          },
          deleteCredential: () => values.delete(key),
        };
      },
    });
    const store = new CredentialStore([backend]);
    try {
      expect(backend.status()).toMatchObject({ available: true, writable: true });
      store.putIfAbsent('keychain:openslack/native-test', 'canary-secret');
      expect(() => store.putIfAbsent('keychain:openslack/native-test', 'replacement')).toThrowError(
        expect.objectContaining<Partial<CredentialStoreError>>({
          code: 'CREDENTIAL_ALREADY_EXISTS',
        }),
      );
      expect(store.withSecret('keychain:openslack/native-test', (secret) => secret)).toBe(
        'canary-secret',
      );
      expect(JSON.stringify(readdirSync(lockRoot))).not.toContain('canary-secret');
      store.delete('keychain:openslack/native-test');
      expect(store.has('keychain:openslack/native-test')).toBe(false);
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  it('redacts native keyring operation failures', () => {
    const backend = new NativeKeychainBackend({
      entryFactory: () => ({
        getPassword: () => {
          throw new Error('native failed with canary-secret');
        },
        setPassword: () => undefined,
        deleteCredential: () => false,
      }),
    });
    const store = new CredentialStore([backend]);
    let message = '';
    try {
      store.has('keychain:openslack/native-test');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Native OS keyring operation failed safely.');
    expect(message).not.toContain('canary-secret');
  });

  it('pins prebuilt Windows and Linux native keyring artifact families', () => {
    const require = createRequire(import.meta.url);
    const manifest = require('@napi-rs/keyring/package.json') as {
      optionalDependencies?: Record<string, string>;
    };
    expect(manifest.optionalDependencies).toMatchObject({
      '@napi-rs/keyring-win32-x64-msvc': '1.3.0',
      '@napi-rs/keyring-linux-x64-gnu': '1.3.0',
      '@napi-rs/keyring-linux-x64-musl': '1.3.0',
    });
    expect(new NativeKeychainBackend().status()).toMatchObject({
      available: true,
      writable: true,
    });
  });
});
