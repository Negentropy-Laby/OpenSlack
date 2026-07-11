export { parseSecretReference, SecretReferenceError } from './reference.js';
export type { EnvSecretReference, KeychainSecretReference, SecretReference } from './reference.js';
export { CredentialStore, CredentialStoreError } from './store.js';
export type { CredentialBackend, CredentialBackendStatus } from './store.js';
export {
  EnvironmentCredentialBackend,
  MemoryKeychainBackend,
  UnavailableKeychainBackend,
} from './backends.js';

import { EnvironmentCredentialBackend, UnavailableKeychainBackend } from './backends.js';
import { CredentialStore } from './store.js';

export function createDefaultCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
): CredentialStore {
  return new CredentialStore([
    new EnvironmentCredentialBackend(env),
    new UnavailableKeychainBackend(),
  ]);
}
