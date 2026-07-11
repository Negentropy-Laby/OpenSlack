import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CredentialStore,
  EnvironmentCredentialBackend,
  MemoryKeychainBackend,
  NativeKeychainBackend,
  parseSecretReference,
  type CredentialStoreError,
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

  it('stores large Windows strings as UTF-8 secret bytes and keeps legacy entries readable', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'openslack-native-keyring-utf8-test-'));
    const passwordValues = new Map<string, string>();
    const secretValues = new Map<string, Uint8Array>();
    const backend = new NativeKeychainBackend({
      lockRoot,
      platform: 'win32',
      entryFactory: (service, account) => {
        const key = `${service}/${account}`;
        return {
          getPassword: () => passwordValues.get(key) ?? null,
          setPassword: (value) => {
            if (value.length > 1_280) throw new Error('UTF-16 credential is too large');
            passwordValues.set(key, value);
          },
          getSecret: () => {
            const value = secretValues.get(key);
            if (value) return Uint8Array.from(value);
            const legacyPassword = passwordValues.get(key);
            return legacyPassword ? Buffer.from(legacyPassword, 'utf16le') : null;
          },
          setSecret: (value) => {
            if (value.byteLength > 2_560) throw new Error('credential blob is too large');
            secretValues.set(key, Uint8Array.from(value));
          },
          deleteCredential: () => {
            const passwordDeleted = passwordValues.delete(key);
            const secretDeleted = secretValues.delete(key);
            return passwordDeleted || secretDeleted;
          },
        };
      },
    });
    const store = new CredentialStore([backend]);
    const privateKeySizedValue = 'p'.repeat(1_700);
    try {
      store.putIfAbsent('keychain:openslack/large-private-key', privateKeySizedValue);
      expect(store.withSecret('keychain:openslack/large-private-key', (secret) => secret)).toBe(
        privateKeySizedValue,
      );
      expect(passwordValues).toHaveLength(0);

      passwordValues.set('openslack/legacy-entry', 'legacy-password');
      expect(store.withSecret('keychain:openslack/legacy-entry', (secret) => secret)).toBe(
        'legacy-password',
      );
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  it('reports Windows secrets that exceed the native credential blob capacity', () => {
    const backend = new NativeKeychainBackend({
      platform: 'win32',
      entryFactory: () => ({
        getPassword: () => null,
        setPassword: () => undefined,
        getSecret: () => null,
        setSecret: () => undefined,
        deleteCredential: () => false,
      }),
    });
    const store = new CredentialStore([backend]);
    expect(() => store.putIfAbsent('keychain:openslack/oversized', 'p'.repeat(2_560))).toThrowError(
      expect.objectContaining<Partial<CredentialStoreError>>({ code: 'CREDENTIAL_TOO_LARGE' }),
    );
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
