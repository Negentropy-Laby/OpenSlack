export type SecretReference = EnvSecretReference | KeychainSecretReference;

export interface EnvSecretReference {
  scheme: 'env';
  canonical: `env:${string}`;
  name: string;
}

export interface KeychainSecretReference {
  scheme: 'keychain';
  canonical: `keychain:${string}/${string}`;
  service: string;
  account: string;
}

export class SecretReferenceError extends Error {
  readonly code = 'SECRET_REFERENCE_INVALID';
  constructor(message = 'Secret reference is invalid.') {
    super(message);
    this.name = 'SecretReferenceError';
  }
}

export function parseSecretReference(value: string): SecretReference {
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SecretReferenceError();
  }
  if (value.startsWith('env:')) {
    const name = value.slice(4);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new SecretReferenceError();
    return { scheme: 'env', canonical: `env:${name}`, name };
  }
  if (value.startsWith('keychain:')) {
    const path = value.slice('keychain:'.length);
    const separator = path.indexOf('/');
    const service = path.slice(0, separator);
    const account = path.slice(separator + 1);
    if (
      separator <= 0 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service) ||
      !/^[A-Za-z0-9][A-Za-z0-9@._-]{0,127}$/.test(account)
    ) {
      throw new SecretReferenceError();
    }
    return { scheme: 'keychain', canonical: `keychain:${service}/${account}`, service, account };
  }
  throw new SecretReferenceError('Secret reference must use env: or keychain:.');
}
