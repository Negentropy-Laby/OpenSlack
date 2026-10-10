import { onCleanupRecordPlatform } from './helpers/cleanup-record-platform.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEANUP_OPERATION_RECORD_DIRECTORY,
  CLEANUP_OPERATION_RECORD_SCHEMA,
  CleanupOperationRecordError,
  cleanupOperationRecordPath,
  readCleanupOperationRecord,
  saveCleanupOperationRecord,
  type CleanupOperationQueryRecord,
  type CleanupOperationRequest,
} from '../cleanup-operation-record.js';
import { cleanupBrokerExecutionDigest } from '../internal/cleanup-broker-digest.js';
import { snapshotAllowingOutbox } from './helpers/cleanup-record-snapshot.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-record-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function request(overrides: Partial<CleanupOperationRequest> = {}): CleanupOperationRequest {
  return {
    schema: 'openslack.cleanup_request.v1',
    mode: 'execute',
    agentId: 'openslack-agent-operator',
    principalId: 'agent.test',
    runtimeUid: '44180',
    runId: 'run-0001',
    repo: 'Negentropy-Laby/OpenSlack',
    remote: 'origin',
    prNumber: 418,
    permitId: 'PERMIT-0001',
    operationId: 'OP-0001',
    ...overrides,
  };
}

function record(overrides: Partial<CleanupOperationRequest> = {}): CleanupOperationQueryRecord {
  const value = request(overrides);
  return {
    schema: CLEANUP_OPERATION_RECORD_SCHEMA,
    createdAt: '2026-09-21T00:00:00.000Z',
    request: value,
    requestDigest: cleanupBrokerExecutionDigest(value),
  };
}

describe('cleanup operation query record', () => {
  it(
    'publishes a record under the authorized outbox subdirectory and reads it back',
    onCleanupRecordPlatform(() => {
      const root = temporaryRoot();
      const saved = saveCleanupOperationRecord(record(), {
        rootDir: root,
        snapshot: snapshotAllowingOutbox(),
      });

      expect(saved.status).toBe('published');
      expect(saved.path).toBe(join(root, CLEANUP_OPERATION_RECORD_DIRECTORY, 'OP-0001.json'));
      const loaded = readCleanupOperationRecord(saved.path);
      expect(loaded.schema).toBe(CLEANUP_OPERATION_RECORD_SCHEMA);
      expect(loaded.request.operationId).toBe('OP-0001');
      expect(loaded.requestDigest).toBe(cleanupBrokerExecutionDigest(loaded.request));
    }),
  );

  it(
    'reuses an identical record for the same operation and binding',
    onCleanupRecordPlatform(() => {
      const root = temporaryRoot();
      const first = saveCleanupOperationRecord(record(), {
        rootDir: root,
        snapshot: snapshotAllowingOutbox(),
      });
      const second = saveCleanupOperationRecord(record(), {
        rootDir: root,
        snapshot: snapshotAllowingOutbox(),
      });

      expect(first.status).toBe('published');
      expect(second.status).toBe('reused');
      expect(second.path).toBe(first.path);
    }),
  );

  it(
    'refuses a different binding for an already-published operation',
    onCleanupRecordPlatform(() => {
      const root = temporaryRoot();
      saveCleanupOperationRecord(record(), { rootDir: root, snapshot: snapshotAllowingOutbox() });

      // Same operation, different permit: a different durable binding.
      expect(() =>
        saveCleanupOperationRecord(record({ permitId: 'PERMIT-0002' }), {
          rootDir: root,
          snapshot: snapshotAllowingOutbox(),
        }),
      ).toThrowError(expect.objectContaining({ code: 'BINDING_CONFLICT' }) as unknown as Error);
    }),
  );

  it('rejects a digest that does not match the request it carries', () => {
    const root = temporaryRoot();
    const value = record();
    expect(() =>
      saveCleanupOperationRecord(
        { ...value, requestDigest: 'f'.repeat(64) },
        { rootDir: root, snapshot: snapshotAllowingOutbox() },
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RECORD' }) as unknown as Error);
  });

  it(
    'rejects unknown and missing keys',
    onCleanupRecordPlatform(() => {
      const root = temporaryRoot();
      const saved = saveCleanupOperationRecord(record(), {
        rootDir: root,
        snapshot: snapshotAllowingOutbox(),
      });
      const parsed = JSON.parse(readFileSync(saved.path, 'utf8')) as Record<string, unknown>;

      const withUnknown = { ...parsed, extra: 1 };
      writeFileSync(saved.path, `${JSON.stringify(withUnknown)}\n`);
      expect(() => readCleanupOperationRecord(saved.path)).toThrowError(
        expect.objectContaining({ code: 'INVALID_RECORD' }) as unknown as Error,
      );

      // Missing key, built explicitly so the test does not rely on rest-omit.
      const withoutDigest = {
        schema: parsed.schema,
        createdAt: parsed.createdAt,
        request: parsed.request,
      };
      writeFileSync(saved.path, `${JSON.stringify(withoutDigest)}\n`);
      expect(() => readCleanupOperationRecord(saved.path)).toThrowError(
        expect.objectContaining({ code: 'INVALID_RECORD' }) as unknown as Error,
      );
    }),
  );

  it(
    'rejects duplicate keys before last-key-wins can apply',
    onCleanupRecordPlatform(() => {
      const root = temporaryRoot();
      const saved = saveCleanupOperationRecord(record(), {
        rootDir: root,
        snapshot: snapshotAllowingOutbox(),
      });
      const text = readFileSync(saved.path, 'utf8');
      const digestValue = JSON.stringify(record().requestDigest);
      const duplicated = text.replace(
        `"requestDigest":${digestValue}`,
        `"requestDigest":${digestValue},"requestDigest":${digestValue}`,
      );
      expect(duplicated).not.toBe(text);
      writeFileSync(saved.path, duplicated);

      expect(() => readCleanupOperationRecord(saved.path)).toThrowError(
        expect.objectContaining({ code: 'INVALID_RECORD' }) as unknown as Error,
      );
    }),
  );

  it('rejects a non-execute request', () => {
    const root = temporaryRoot();
    const value = request({ mode: 'preview' });
    // The mode check runs before the digest comparison, so a placeholder digest
    // still isolates this rejection to the mode rule.
    expect(() =>
      saveCleanupOperationRecord(
        { ...record(), request: value, requestDigest: 'a'.repeat(64) },
        { rootDir: root, snapshot: snapshotAllowingOutbox() },
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RECORD' }) as unknown as Error);
  });

  it('rejects a request without an operation ID', () => {
    const root = temporaryRoot();
    const value = { ...request() } as Partial<CleanupOperationRequest>;
    delete value.operationId;
    expect(() =>
      saveCleanupOperationRecord(
        {
          ...record(),
          request: value as CleanupOperationRequest,
          requestDigest: 'a'.repeat(64),
        },
        { rootDir: root, snapshot: snapshotAllowingOutbox() },
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RECORD' }) as unknown as Error);
  });

  it('rejects a traversal operation ID', () => {
    expect(() => cleanupOperationRecordPath('/tmp/root', '../../etc/passwd')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATH' }) as unknown as Error,
    );
  });

  it('rejects sensitive paths', () => {
    expect(() => readCleanupOperationRecord('/tmp/root/secrets/record.json')).toThrowError(
      expect.objectContaining({ code: 'SENSITIVE_PATH' }) as unknown as Error,
    );
    expect(() => readCleanupOperationRecord('/tmp/root/private.pem')).toThrowError(
      expect.objectContaining({ code: 'SENSITIVE_PATH' }) as unknown as Error,
    );
  });

  it(
    'rejects a symlink to a record',
    onCleanupRecordPlatform(() => {
      const root = temporaryRoot();
      const saved = saveCleanupOperationRecord(record(), {
        rootDir: root,
        snapshot: snapshotAllowingOutbox(),
      });
      const link = join(root, 'link.json');
      symlinkSync(saved.path, link);

      expect(() => readCleanupOperationRecord(link)).toThrowError(
        expect.objectContaining({ code: 'SYMLINK_REJECTED' }) as unknown as Error,
      );
    }),
  );

  it(
    'rejects an oversized record',
    onCleanupRecordPlatform(() => {
      const root = temporaryRoot();
      const dir = join(root, CLEANUP_OPERATION_RECORD_DIRECTORY);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'OP-BIG.json');
      writeFileSync(
        path,
        `{"schema":"${CLEANUP_OPERATION_RECORD_SCHEMA}","pad":"${'x'.repeat(20000)}"}`,
      );

      expect(() => readCleanupOperationRecord(path)).toThrowError(
        expect.objectContaining({ code: 'INVALID_RECORD' }) as unknown as Error,
      );
    }),
  );

  it('exposes a typed error class for callers', () => {
    expect(() => cleanupOperationRecordPath('/tmp/root', 'bad id')).toThrowError(
      CleanupOperationRecordError,
    );
  });
});
