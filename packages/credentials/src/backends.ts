import type { SecretReference } from './reference.js';
import type { CredentialBackend, CredentialBackendStatus } from './store.js';
import { CredentialStoreError } from './store.js';

export class EnvironmentCredentialBackend implements CredentialBackend {
  readonly scheme = 'env' as const;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  status(): CredentialBackendStatus {
    return { scheme: 'env', available: true, writable: false, detail: 'process environment' };
  }
  withSecret<T>(reference: SecretReference, consumer: (secret: string) => T): T {
    if (reference.scheme !== 'env') throw new Error('Environment backend received another scheme.');
    const value = this.env[reference.name];
    if (!value || !value.trim()) {
      throw new CredentialStoreError(
        'CREDENTIAL_UNAVAILABLE',
        'Referenced credential is unavailable.',
      );
    }
    return consumer(value);
  }
  has(reference: SecretReference): boolean {
    if (reference.scheme !== 'env') throw new Error('Environment backend received another scheme.');
    const value = this.env[reference.name];
    return value !== undefined && value.trim().length > 0;
  }
}

export class UnavailableKeychainBackend implements CredentialBackend {
  readonly scheme = 'keychain' as const;
  status(): CredentialBackendStatus {
    return {
      scheme: 'keychain',
      available: false,
      writable: false,
      detail: 'No packaged OS keychain backend is installed.',
    };
  }
  withSecret<T>(_reference: SecretReference, _consumer: (secret: string) => T): T {
    throw new CredentialStoreError(
      'CREDENTIAL_BACKEND_UNAVAILABLE',
      'OS keychain backend is unavailable.',
    );
  }
}

export class MemoryKeychainBackend implements CredentialBackend {
  readonly scheme = 'keychain' as const;
  private readonly values = new Map<string, string>();
  status(): CredentialBackendStatus {
    return {
      scheme: 'keychain',
      available: true,
      writable: true,
      detail: 'in-memory test backend',
    };
  }
  withSecret<T>(reference: SecretReference, consumer: (secret: string) => T): T {
    if (reference.scheme !== 'keychain')
      throw new Error('Keychain backend received another scheme.');
    const value = this.values.get(reference.canonical);
    if (value === undefined) {
      throw new CredentialStoreError(
        'CREDENTIAL_UNAVAILABLE',
        'Referenced credential is unavailable.',
      );
    }
    return consumer(value);
  }
  has(reference: SecretReference): boolean {
    if (reference.scheme !== 'keychain')
      throw new Error('Keychain backend received another scheme.');
    return this.values.has(reference.canonical);
  }
  put(reference: SecretReference, secret: string): void {
    if (reference.scheme !== 'keychain')
      throw new Error('Keychain backend received another scheme.');
    this.values.set(reference.canonical, secret);
  }
  putIfAbsent(reference: SecretReference, secret: string): boolean {
    if (reference.scheme !== 'keychain')
      throw new Error('Keychain backend received another scheme.');
    if (this.values.has(reference.canonical)) return false;
    this.values.set(reference.canonical, secret);
    return true;
  }
  delete(reference: SecretReference): void {
    if (reference.scheme !== 'keychain')
      throw new Error('Keychain backend received another scheme.');
    this.values.delete(reference.canonical);
  }
}
