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
  getSecret?(): Array<number> | Uint8Array | null;
  setSecret?(value: Uint8Array): void;
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
      const entry = this.entry(parsed.service, parsed.account);
      if (this.platform === 'win32' && entry.getSecret && entry.setSecret) {
        const rawSecret = entry.getSecret();
        if (rawSecret === null) return null;
        const encoded = Buffer.from(rawSecret);
        try {
          if (
            encoded
              .subarray(0, WINDOWS_UTF8_SECRET_PREFIX.length)
              .equals(WINDOWS_UTF8_SECRET_PREFIX)
          ) {
            return encoded.subarray(WINDOWS_UTF8_SECRET_PREFIX.length).toString('utf-8');
          }
        } finally {
          encoded.fill(0);
          rawSecret.fill(0);
        }
        // Entries created before the UTF-8 envelope used setPassword(), which
        // stores UTF-16 bytes on Windows. Keep those references readable.
      }
      return entry.getPassword();
    } catch {
      throw backendUnavailable();
    }
  }

  private write(reference: SecretReference, secret: string): void {
    const parsed = requireKeychainReference(reference);
    try {
      const entry = this.entry(parsed.service, parsed.account);
      if (this.platform === 'win32' && entry.getSecret && entry.setSecret) {
        const byteLength = WINDOWS_UTF8_SECRET_PREFIX.length + Buffer.byteLength(secret, 'utf-8');
        if (byteLength > WINDOWS_CREDENTIAL_BLOB_MAX_BYTES) {
          throw new CredentialStoreError(
            'CREDENTIAL_TOO_LARGE',
            'Credential exceeds the Windows Credential Manager capacity.',
          );
        }
        const encoded = Buffer.allocUnsafe(byteLength);
        WINDOWS_UTF8_SECRET_PREFIX.copy(encoded);
        encoded.write(secret, WINDOWS_UTF8_SECRET_PREFIX.length, 'utf-8');
        try {
          entry.setSecret(encoded);
        } finally {
          encoded.fill(0);
        }
        return;
      }
      entry.setPassword(secret);
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
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

// CredWriteW limits a generic credential blob to 5 * 512 bytes. setPassword()
// encodes strings as UTF-16 and halves the usable capacity, so Windows entries
// written by OpenSlack use setSecret() with an explicit UTF-8 envelope.
const WINDOWS_CREDENTIAL_BLOB_MAX_BYTES = 5 * 512;
const WINDOWS_UTF8_SECRET_PREFIX = Buffer.from('openslack.credential.utf8.v1\0', 'utf-8');

function loadNativeEntryFactory(): NativeKeychainBackendOptions['entryFactory'] {
  try {
    const require = createRequire(import.meta.url);
    const keyring = require('@napi-rs/keyring') as { Entry: typeof KeyringEntry };
    return (service, account) => new keyring.Entry(service, account);
  } catch {
    return undefined;
  }
}
