import { linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CredentialStoreError,
  parseSecretReference,
  type CredentialStore,
} from '@openslack/credentials';

export interface GitHubAppImportInput {
  localStateRoot: string;
  sourcePath: string;
  appId: string;
  installationId: string;
  appSlug: string;
  privateKeyRef: string;
  deleteSource?: boolean;
}

export interface GitHubAppImportPlan {
  input: GitHubAppImportInput;
  configPath: string;
  summary: string[];
}

export interface GitHubAppImportResult {
  configPath: string;
  privateKeyRef: string;
  sourceDeleted: boolean;
  warnings: string[];
}

export interface GitHubAppImportDependencies {
  credentialStore: CredentialStore;
  readSource?: (path: string) => Buffer;
  deleteSource?: (path: string) => void;
}

export function planGitHubAppImport(input: GitHubAppImportInput): GitHubAppImportPlan {
  validateImportInput(input);
  return {
    input: {
      ...input,
      sourcePath: resolve(input.sourcePath),
      localStateRoot: resolve(input.localStateRoot),
    },
    configPath: join(resolve(input.localStateRoot), 'github-app.json'),
    summary: [
      `Import GitHub App ${input.appSlug} (${input.appId})`,
      `Store private key as ${input.privateKeyRef}`,
      `Write non-secret local config to ${join(resolve(input.localStateRoot), 'github-app.json')}`,
      input.deleteSource
        ? 'Attempt best-effort source deletion after storage'
        : 'Keep the source file',
    ],
  };
}

export function applyGitHubAppImport(
  plan: GitHubAppImportPlan,
  dependencies: GitHubAppImportDependencies,
): GitHubAppImportResult {
  validateImportInput(plan.input);
  const reference = parseSecretReference(plan.input.privateKeyRef);
  if (reference.scheme !== 'keychain') {
    throw new Error('GitHub App private-key import requires a writable keychain: reference.');
  }
  const readSource = dependencies.readSource ?? ((path: string) => readFileSync(path));
  let secret: Buffer;
  try {
    secret = readSource(plan.input.sourcePath);
  } catch {
    throw new Error('GitHub App private-key source could not be read.');
  }
  if (secret.byteLength === 0 || secret.byteLength > 1024 * 1024) {
    secret.fill(0);
    throw new Error('GitHub App private-key source has an invalid size.');
  }
  const value = secret.toString('utf-8');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    secret.fill(0);
    throw new Error('GitHub App private-key source is not a PEM private key.');
  }

  let stored = false;
  try {
    dependencies.credentialStore.putIfAbsent(reference, value);
    stored = true;
    writeConfigAtomic(plan.configPath, {
      schema: 'openslack.github_app_local.v1',
      appId: plan.input.appId,
      installationId: plan.input.installationId,
      appSlug: plan.input.appSlug,
      privateKeyRef: reference.canonical,
    });
  } catch (error) {
    if (stored) {
      try {
        dependencies.credentialStore.delete(reference);
      } catch {
        // The original fixed error remains safe; operator diagnostics must reconcile the backend.
      }
    }
    if (error instanceof CredentialStoreError) {
      throw safeCredentialImportError(error);
    }
    throw new Error('GitHub App import could not be committed to the credential store.');
  } finally {
    secret.fill(0);
  }

  const warnings: string[] = [];
  let sourceDeleted = false;
  if (plan.input.deleteSource) {
    try {
      (dependencies.deleteSource ?? unlinkSync)(plan.input.sourcePath);
      sourceDeleted = true;
    } catch {
      warnings.push(
        'Private-key source deletion failed; remove it manually after verifying the stored reference.',
      );
    }
  }
  return {
    configPath: plan.configPath,
    privateKeyRef: reference.canonical,
    sourceDeleted,
    warnings,
  };
}

function safeCredentialImportError(error: CredentialStoreError): Error {
  switch (error.code) {
    case 'CREDENTIAL_ALREADY_EXISTS':
      return new Error('GitHub App private-key reference already exists; choose a new --key-ref.');
    case 'CREDENTIAL_ATOMIC_OPERATION_UNAVAILABLE':
      return new Error('GitHub App private-key reference is locked; retry the import.');
    case 'CREDENTIAL_TOO_LARGE':
      return new Error('GitHub App private key exceeds the OS keychain item capacity.');
    case 'CREDENTIAL_BACKEND_READ_ONLY':
    case 'CREDENTIAL_BACKEND_UNAVAILABLE':
    case 'CREDENTIAL_UNAVAILABLE':
      return new Error('The OS keychain could not store the GitHub App private key.');
  }
}

function validateImportInput(input: GitHubAppImportInput): void {
  if (!/^\d+$/.test(input.appId) || !/^\d+$/.test(input.installationId)) {
    throw new Error('GitHub App and installation IDs must be decimal identifiers.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(input.appSlug)) {
    throw new Error('GitHub App slug is invalid.');
  }
  const reference = parseSecretReference(input.privateKeyRef);
  if (reference.scheme !== 'keychain') throw new Error('Private key reference must use keychain:.');
}

function writeConfigAtomic(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
