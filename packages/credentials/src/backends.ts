import type { SecretReference } from './reference.js';
import type { CredentialBackend, CredentialBackendStatus } from './store.js';
import { CredentialStoreError } from './store.js';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Entry as KeyringEntry } from '@napi-rs/keyring';

export interface NativeKeychainEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deleteCredential(): boolean;
}

export interface NativeKeychainBackendOptions {
  entryFactory?: (service: string, account: string) => NativeKeychainEntry;
  lockRoot?: string;
  platform?: NodeJS.Platform;
}

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

export class NativeKeychainBackend implements CredentialBackend {
  readonly scheme = 'keychain' as const;
  private readonly entryFactory: NativeKeychainBackendOptions['entryFactory'];
  private readonly lockRoot: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: NativeKeychainBackendOptions = {}) {
    this.entryFactory = options.entryFactory ?? loadNativeEntryFactory();
    this.lockRoot = options.lockRoot ?? join(tmpdir(), 'openslack-keychain-locks');
    this.platform = options.platform ?? process.platform;
  }

  status(): CredentialBackendStatus {
    return {
      scheme: 'keychain',
      available: this.entryFactory !== undefined,
      writable: this.entryFactory !== undefined,
      detail:
        this.entryFactory === undefined
          ? `native OS keyring binding unavailable (${this.platform})`
          : `native OS keyring (${this.platform})`,
    };
  }

  withSecret<T>(reference: SecretReference, consumer: (secret: string) => T): T {
    const value = this.read(reference);
    if (value === null) {
      throw new CredentialStoreError(
        'CREDENTIAL_UNAVAILABLE',
        'Referenced credential is unavailable.',
      );
    }
    return consumer(value);
  }

  has(reference: SecretReference): boolean {
    return this.read(reference) !== null;
  }

  put(reference: SecretReference, secret: string): void {
    this.withReferenceLock(reference, () => this.write(reference, secret));
  }

  putIfAbsent(reference: SecretReference, secret: string): boolean {
    return this.withReferenceLock(reference, () => {
      if (this.read(reference) !== null) return false;
      this.write(reference, secret);
      return true;
    });
  }

  delete(reference: SecretReference): void {
    this.withReferenceLock(reference, () => {
      const parsed = requireKeychainReference(reference);
      try {
        this.entry(parsed.service, parsed.account).deleteCredential();
      } catch {
        throw backendUnavailable();
      }
    });
  }

  private read(reference: SecretReference): string | null {
    const parsed = requireKeychainReference(reference);
    try {
      return this.entry(parsed.service, parsed.account).getPassword();
    } catch {
      throw backendUnavailable();
    }
  }

  private write(reference: SecretReference, secret: string): void {
    const parsed = requireKeychainReference(reference);
    try {
      this.entry(parsed.service, parsed.account).setPassword(secret);
    } catch {
      throw backendUnavailable();
    }
  }

  private withReferenceLock<T>(reference: SecretReference, operation: () => T): T {
    const parsed = requireKeychainReference(reference);
    mkdirSync(this.lockRoot, { recursive: true });
    const lockId = createHash('sha256').update(parsed.canonical).digest('hex');
    const lockPath = join(this.lockRoot, lockId);
    try {
      mkdirSync(lockPath);
    } catch {
      throw new CredentialStoreError(
        'CREDENTIAL_ATOMIC_OPERATION_UNAVAILABLE',
        'Credential reference is locked by another OpenSlack process; retry the operation.',
      );
    }
    try {
      return operation();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  private entry(service: string, account: string): NativeKeychainEntry {
    if (!this.entryFactory) throw backendUnavailable();
    return this.entryFactory(service, account);
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

function requireKeychainReference(reference: SecretReference) {
  if (reference.scheme !== 'keychain') throw new Error('Keychain backend received another scheme.');
  return reference;
}

function backendUnavailable(): CredentialStoreError {
  return new CredentialStoreError(
    'CREDENTIAL_BACKEND_UNAVAILABLE',
    'Native OS keyring operation failed safely.',
  );
}

function loadNativeEntryFactory(): NativeKeychainBackendOptions['entryFactory'] {
  try {
    const require = createRequire(import.meta.url);
    const keyring = require('@napi-rs/keyring') as { Entry: typeof KeyringEntry };
    return (service, account) => new keyring.Entry(service, account);
  } catch {
    return undefined;
  }
}
