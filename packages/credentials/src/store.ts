import { parseSecretReference, type SecretReference } from './reference.js';

export interface CredentialBackendStatus {
  scheme: SecretReference['scheme'];
  available: boolean;
  writable: boolean;
  detail: string;
}

export interface CredentialBackend {
  readonly scheme: SecretReference['scheme'];
  status(): CredentialBackendStatus;
  withSecret<T>(reference: SecretReference, consumer: (secret: string) => T): T;
  put?(reference: SecretReference, secret: string): void;
  delete?(reference: SecretReference): void;
}

export class CredentialStoreError extends Error {
  constructor(
    readonly code:
      | 'CREDENTIAL_UNAVAILABLE'
      | 'CREDENTIAL_BACKEND_UNAVAILABLE'
      | 'CREDENTIAL_BACKEND_READ_ONLY',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}

export class CredentialStore {
  private readonly backends = new Map<SecretReference['scheme'], CredentialBackend>();

  constructor(backends: CredentialBackend[]) {
    for (const backend of backends) {
      if (this.backends.has(backend.scheme)) {
        throw new Error(`Duplicate credential backend: ${backend.scheme}`);
      }
      this.backends.set(backend.scheme, backend);
    }
  }

  withSecret<T>(value: string | SecretReference, consumer: (secret: string) => T): T {
    const reference = typeof value === 'string' ? parseSecretReference(value) : value;
    return this.backend(reference).withSecret(reference, consumer);
  }

  put(value: string | SecretReference, secret: string): void {
    const reference = typeof value === 'string' ? parseSecretReference(value) : value;
    const backend = this.backend(reference);
    if (!backend.put) {
      throw new CredentialStoreError(
        'CREDENTIAL_BACKEND_READ_ONLY',
        'Credential backend is read-only.',
      );
    }
    backend.put(reference, secret);
  }

  delete(value: string | SecretReference): void {
    const reference = typeof value === 'string' ? parseSecretReference(value) : value;
    const backend = this.backend(reference);
    if (!backend.delete) {
      throw new CredentialStoreError(
        'CREDENTIAL_BACKEND_READ_ONLY',
        'Credential backend is read-only.',
      );
    }
    backend.delete(reference);
  }

  status(): CredentialBackendStatus[] {
    return [...this.backends.values()].map((backend) => backend.status());
  }

  private backend(reference: SecretReference): CredentialBackend {
    const backend = this.backends.get(reference.scheme);
    if (!backend || !backend.status().available) {
      throw new CredentialStoreError(
        'CREDENTIAL_BACKEND_UNAVAILABLE',
        `Credential backend ${reference.scheme} is unavailable.`,
      );
    }
    return backend;
  }
}
