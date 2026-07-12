export { parseSecretReference, SecretReferenceError } from './reference.js';
export type { EnvSecretReference, KeychainSecretReference, SecretReference } from './reference.js';
export { CredentialStore, CredentialStoreError } from './store.js';
export type { CredentialBackend, CredentialBackendStatus } from './store.js';
export {
  EnvironmentCredentialBackend,
  MemoryKeychainBackend,
  NativeKeychainBackend,
  UnavailableKeychainBackend,
} from './backends.js';
export type { NativeKeychainBackendOptions, NativeKeychainEntry } from './backends.js';

import { EnvironmentCredentialBackend, NativeKeychainBackend } from './backends.js';
import { CredentialStore } from './store.js';

export function createDefaultCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
): CredentialStore {
  return new CredentialStore([new EnvironmentCredentialBackend(env), new NativeKeychainBackend()]);
}
