import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CredentialStore,
  MemoryKeychainBackend,
  NativeKeychainBackend,
  UnavailableKeychainBackend,
} from '@openslack/credentials';
import { applyAgentRuntimeCredentialImport, planAgentRuntimeCredentialImport } from '../index.js';
import type { AgentRuntimeCredentialImportError } from '../index.js';

const CREDENTIAL_REF = 'keychain:openslack/openai-compatible-test';

describe('agent-runtime credential import', () => {
  it('builds a read-free preview without touching the source or keychain', () => {
    const plan = planAgentRuntimeCredentialImport({
      sourcePath: './credential.txt',
      credentialRef: CREDENTIAL_REF,
      deleteSource: true,
    });

    expect(plan).toMatchObject({
      mode: 'dry-run',
      credentialRef: CREDENTIAL_REF,
      deleteSource: true,
      secretRead: false,
    });
    expect(JSON.stringify(plan)).not.toContain('credential-canary');
  });

  it('stores a source credential atomically and zeroes the mutable buffer', () => {
    const backend = new MemoryKeychainBackend();
    const store = new CredentialStore([backend]);
    const source = Buffer.from('credential-canary\n', 'utf-8');
    const plan = planAgentRuntimeCredentialImport({
      sourcePath: './credential.txt',
      credentialRef: CREDENTIAL_REF,
    });

    const result = applyAgentRuntimeCredentialImport(plan, {
      credentialStore: store,
      readSourceFile: () => source,
    });

    expect(result).toEqual({
      status: 'PASS',
      mode: 'write',
      credentialRef: CREDENTIAL_REF,
      sourceDeleted: false,
      warnings: [],
    });
    expect(source.every((byte) => byte === 0)).toBe(true);
    expect(store.withSecret(CREDENTIAL_REF, (secret) => secret)).toBe('credential-canary');
    expect(JSON.stringify(result)).not.toContain('credential-canary');
  });

  it('recovers the imported reference through a restarted credential store', () => {
    const backend = new MemoryKeychainBackend();
    const firstProcess = new CredentialStore([backend]);
    const plan = planAgentRuntimeCredentialImport({
      sourcePath: './credential.txt',
      credentialRef: CREDENTIAL_REF,
    });
    applyAgentRuntimeCredentialImport(plan, {
      credentialStore: firstProcess,
      readSourceFile: () => Buffer.from('restart-canary'),
    });

    const restartedProcess = new CredentialStore([backend]);
    expect(restartedProcess.withSecret(CREDENTIAL_REF, (secret) => secret.length)).toBe(14);
  });

  it('fails closed without replacing an existing credential', () => {
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    store.putIfAbsent(CREDENTIAL_REF, 'existing-value');
    const source = Buffer.from('replacement-canary');
    const plan = planAgentRuntimeCredentialImport({
      sourcePath: './credential.txt',
      credentialRef: CREDENTIAL_REF,
    });

    expect(() =>
      applyAgentRuntimeCredentialImport(plan, {
        credentialStore: store,
        readSourceFile: () => source,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentRuntimeCredentialImportError>>({
        code: 'CREDENTIAL_IMPORT_ALREADY_EXISTS',
      }),
    );
    expect(store.withSecret(CREDENTIAL_REF, (secret) => secret)).toBe('existing-value');
    expect(source.every((byte) => byte === 0)).toBe(true);
  });

  it('fails closed when the native keychain backend is unavailable', () => {
    const plan = planAgentRuntimeCredentialImport({
      sourcePath: './credential.txt',
      credentialRef: CREDENTIAL_REF,
    });
    const source = Buffer.from('backend-error-canary');

    let failure: unknown;
    try {
      applyAgentRuntimeCredentialImport(plan, {
        credentialStore: new CredentialStore([new UnavailableKeychainBackend()]),
        readSourceFile: () => source,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'CREDENTIAL_IMPORT_BACKEND_UNAVAILABLE' });
    expect(JSON.stringify(failure)).not.toContain('backend-error-canary');
    expect(source.every((byte) => byte === 0)).toBe(true);
  });

  it('redacts native write failures and corrupt Windows keychain envelopes', () => {
    for (const backend of [
      new NativeKeychainBackend({
        platform: 'win32',
        entryFactory: () => ({
          getPassword: () => null,
          setPassword: () => undefined,
          getSecret: () => null,
          setSecret: () => {
            throw new Error('native-write-canary');
          },
          deleteCredential: () => false,
        }),
      }),
      new NativeKeychainBackend({
        platform: 'win32',
        entryFactory: () => ({
          getPassword: () => 'garbled',
          setPassword: () => undefined,
          getSecret: () => Buffer.from('corrupt-envelope-canary'),
          setSecret: () => undefined,
          deleteCredential: () => false,
        }),
      }),
    ]) {
      const plan = planAgentRuntimeCredentialImport({
        sourcePath: './credential.txt',
        credentialRef: CREDENTIAL_REF,
      });
      let failure: unknown;
      try {
        applyAgentRuntimeCredentialImport(plan, {
          credentialStore: new CredentialStore([backend]),
          readSourceFile: () => Buffer.from('source-secret-canary'),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'CREDENTIAL_IMPORT_BACKEND_UNAVAILABLE' });
      const serialized = JSON.stringify(failure);
      expect(serialized).not.toContain('native-write-canary');
      expect(serialized).not.toContain('corrupt-envelope-canary');
      expect(serialized).not.toContain('source-secret-canary');
    }
  });

  it('reports best-effort source deletion failures without undoing the stored value', () => {
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    const plan = planAgentRuntimeCredentialImport({
      sourcePath: './credential.txt',
      credentialRef: CREDENTIAL_REF,
      deleteSource: true,
    });

    const result = applyAgentRuntimeCredentialImport(plan, {
      credentialStore: store,
      readSourceFile: () => Buffer.from('delete-warning-canary'),
      deleteSourceFile: () => {
        throw new Error('delete failed with delete-warning-canary');
      },
    });

    expect(result.sourceDeleted).toBe(false);
    expect(result.warnings).toEqual([
      'The credential is stored, but the source file could not be deleted. Remove it manually.',
    ]);
    expect(JSON.stringify(result)).not.toContain('delete-warning-canary');
    expect(store.has(CREDENTIAL_REF)).toBe(true);
  });

  it('deletes the source only after a successful keychain write', () => {
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    const deleteSourceFile = vi.fn();
    const plan = planAgentRuntimeCredentialImport({
      sourcePath: './credential.txt',
      credentialRef: CREDENTIAL_REF,
      deleteSource: true,
    });

    const result = applyAgentRuntimeCredentialImport(plan, {
      credentialStore: store,
      readSourceFile: () => Buffer.from('delete-success-canary'),
      deleteSourceFile,
    });
    expect(result.sourceDeleted).toBe(true);
    expect(deleteSourceFile).toHaveBeenCalledOnce();
  });

  it('rejects env destinations and malformed or unusable source files', () => {
    expect(() =>
      planAgentRuntimeCredentialImport({
        sourcePath: './credential.txt',
        credentialRef: 'env:OPENSLACK_LLM_API_KEY',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentRuntimeCredentialImportError>>({
        code: 'CREDENTIAL_IMPORT_INVALID',
      }),
    );

    const plan = planAgentRuntimeCredentialImport({
      sourcePath: './credential.txt',
      credentialRef: CREDENTIAL_REF,
    });
    for (const source of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('\u0000')]) {
      expect(() =>
        applyAgentRuntimeCredentialImport(plan, {
          credentialStore: new CredentialStore([new MemoryKeychainBackend()]),
          readSourceFile: () => source,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<AgentRuntimeCredentialImportError>>({
          code: 'CREDENTIAL_IMPORT_SOURCE_INVALID',
        }),
      );
      expect(source.every((byte) => byte === 0)).toBe(true);
    }
  });

  it('rejects oversized and non-regular sources before allocating their contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-credential-import-'));
    const oversized = join(root, 'oversized.txt');
    writeFileSync(oversized, Buffer.alloc(64 * 1024 + 1, 0x61));
    const store = new CredentialStore([new MemoryKeychainBackend()]);
    try {
      for (const sourcePath of [oversized, root]) {
        const plan = planAgentRuntimeCredentialImport({
          sourcePath,
          credentialRef: CREDENTIAL_REF,
        });
        expect(() =>
          applyAgentRuntimeCredentialImport(plan, { credentialStore: store }),
        ).toThrowError(
          expect.objectContaining<Partial<AgentRuntimeCredentialImportError>>({
            code: 'CREDENTIAL_IMPORT_SOURCE_INVALID',
          }),
        );
      }
      expect(store.has(CREDENTIAL_REF)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
