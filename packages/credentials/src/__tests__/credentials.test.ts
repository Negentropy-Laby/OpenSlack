import { describe, expect, it } from 'vitest';
import {
  CredentialStore,
  CredentialStoreError,
  EnvironmentCredentialBackend,
  MemoryKeychainBackend,
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
});
