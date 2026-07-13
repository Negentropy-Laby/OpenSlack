import { readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createDefaultCredentialStore,
  CredentialStoreError,
  parseSecretReference,
  type CredentialStore,
} from '@openslack/credentials';

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

export type AgentRuntimeCredentialImportErrorCode =
  | 'CREDENTIAL_IMPORT_INVALID'
  | 'CREDENTIAL_IMPORT_SOURCE_READ_FAILED'
  | 'CREDENTIAL_IMPORT_SOURCE_INVALID'
  | 'CREDENTIAL_IMPORT_BACKEND_UNAVAILABLE'
  | 'CREDENTIAL_IMPORT_ALREADY_EXISTS'
  | 'CREDENTIAL_IMPORT_STORE_FAILED';

export class AgentRuntimeCredentialImportError extends Error {
  constructor(
    readonly code: AgentRuntimeCredentialImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeCredentialImportError';
  }
}

export interface AgentRuntimeCredentialImportInput {
  sourcePath: string;
  credentialRef: string;
  deleteSource?: boolean;
}

export interface AgentRuntimeCredentialImportPlan {
  mode: 'dry-run';
  sourcePath: string;
  credentialRef: `keychain:${string}/${string}`;
  deleteSource: boolean;
  secretRead: false;
  summary: string[];
}

export interface AgentRuntimeCredentialImportResult {
  status: 'PASS';
  mode: 'write';
  credentialRef: `keychain:${string}/${string}`;
  sourceDeleted: boolean;
  warnings: string[];
}

export interface AgentRuntimeCredentialImportDependencies {
  credentialStore?: CredentialStore;
  readSourceFile?: (path: string) => Buffer;
  deleteSourceFile?: (path: string) => void;
}

/**
 * Builds a read-free import preview. Neither the source file nor the keychain
 * backend is touched until applyAgentRuntimeCredentialImport is called.
 */
export function planAgentRuntimeCredentialImport(
  input: AgentRuntimeCredentialImportInput,
): AgentRuntimeCredentialImportPlan {
  const sourcePath = resolve(readRequiredString(input.sourcePath));
  let reference;
  try {
    reference = parseSecretReference(readRequiredString(input.credentialRef));
  } catch {
    throw new AgentRuntimeCredentialImportError(
      'CREDENTIAL_IMPORT_INVALID',
      'Credential import requires a valid keychain:SERVICE/ACCOUNT reference.',
    );
  }
  if (reference.scheme !== 'keychain') {
    throw new AgentRuntimeCredentialImportError(
      'CREDENTIAL_IMPORT_INVALID',
      'Credential import requires a keychain:SERVICE/ACCOUNT reference.',
    );
  }
  return {
    mode: 'dry-run',
    sourcePath,
    credentialRef: reference.canonical,
    deleteSource: input.deleteSource === true,
    secretRead: false,
    summary: [
      `Import a credential into ${reference.canonical}.`,
      'Store the credential with an atomic create-only native keychain write.',
      input.deleteSource
        ? 'Attempt to delete the source file after the keychain write succeeds.'
        : 'Keep the source file.',
    ],
  };
}

export function applyAgentRuntimeCredentialImport(
  plan: AgentRuntimeCredentialImportPlan,
  dependencies: AgentRuntimeCredentialImportDependencies = {},
): AgentRuntimeCredentialImportResult {
  const validated = planAgentRuntimeCredentialImport({
    sourcePath: plan.sourcePath,
    credentialRef: plan.credentialRef,
    deleteSource: plan.deleteSource,
  });
  const readSourceFile = dependencies.readSourceFile ?? readFileSync;
  const credentialStore = dependencies.credentialStore ?? createDefaultCredentialStore();
  let source: Buffer;
  try {
    source = readSourceFile(validated.sourcePath);
  } catch {
    throw new AgentRuntimeCredentialImportError(
      'CREDENTIAL_IMPORT_SOURCE_READ_FAILED',
      'Credential source file could not be read safely.',
    );
  }

  try {
    const secret = decodeCredentialSource(source);
    try {
      credentialStore.putIfAbsent(validated.credentialRef, secret);
    } catch (error) {
      throw normalizeCredentialStoreError(error);
    }
  } finally {
    source.fill(0);
  }

  const warnings: string[] = [];
  let sourceDeleted = false;
  if (validated.deleteSource) {
    try {
      (dependencies.deleteSourceFile ?? unlinkSync)(validated.sourcePath);
      sourceDeleted = true;
    } catch {
      warnings.push(
        'The credential is stored, but the source file could not be deleted. Remove it manually.',
      );
    }
  }
  return {
    status: 'PASS',
    mode: 'write',
    credentialRef: validated.credentialRef,
    sourceDeleted,
    warnings,
  };
}

function decodeCredentialSource(source: Buffer): string {
  if (source.byteLength === 0 || source.byteLength > MAX_CREDENTIAL_FILE_BYTES) {
    throw new AgentRuntimeCredentialImportError(
      'CREDENTIAL_IMPORT_SOURCE_INVALID',
      'Credential source must contain between 1 byte and 64 KiB.',
    );
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw new AgentRuntimeCredentialImportError(
      'CREDENTIAL_IMPORT_SOURCE_INVALID',
      'Credential source must contain valid UTF-8 text.',
    );
  }
  // Secret files commonly end with one editor-added newline. Remove only that
  // terminator; other leading/trailing bytes remain part of the credential.
  const secret = decoded.replace(/\r?\n$/, '');
  if (secret.length === 0 || secret.includes('\u0000')) {
    throw new AgentRuntimeCredentialImportError(
      'CREDENTIAL_IMPORT_SOURCE_INVALID',
      'Credential source does not contain a usable value.',
    );
  }
  // The mutable source buffer is zeroed by the caller. JavaScript strings are
  // immutable and cannot be explicitly erased, so this value stays local to
  // the narrow keychain write boundary and is never returned or persisted.
  return secret;
}

function normalizeCredentialStoreError(error: unknown): AgentRuntimeCredentialImportError {
  if (error instanceof CredentialStoreError) {
    if (error.code === 'CREDENTIAL_ALREADY_EXISTS') {
      return new AgentRuntimeCredentialImportError(
        'CREDENTIAL_IMPORT_ALREADY_EXISTS',
        'Credential reference already exists; no value was replaced.',
      );
    }
    if (
      error.code === 'CREDENTIAL_BACKEND_UNAVAILABLE' ||
      error.code === 'CREDENTIAL_BACKEND_READ_ONLY' ||
      error.code === 'CREDENTIAL_ATOMIC_OPERATION_UNAVAILABLE'
    ) {
      return new AgentRuntimeCredentialImportError(
        'CREDENTIAL_IMPORT_BACKEND_UNAVAILABLE',
        'Native keychain storage is unavailable or does not support atomic writes.',
      );
    }
  }
  return new AgentRuntimeCredentialImportError(
    'CREDENTIAL_IMPORT_STORE_FAILED',
    'Credential could not be committed to the native keychain safely.',
  );
}

function readRequiredString(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentRuntimeCredentialImportError(
      'CREDENTIAL_IMPORT_INVALID',
      'Credential import source and reference are required.',
    );
  }
  return value.trim();
}
