import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { testTemporaryDirectory } from '../../../../../scripts/testing/process-fixture.mjs';
import {
  buildCleanupOperationRecord,
  saveCleanupOperationRecord,
} from '../../cleanup-operation-record.js';
import { snapshotAllowingOutbox } from './cleanup-record-snapshot.js';

/** Same collected cases, with the platform's actual contract: Linux IO or pre-write refusal. */
export function onCleanupRecordPlatform<A extends unknown[]>(
  run: (...args: A) => void | Promise<void>,
): (...args: A) => void | Promise<void> {
  return (...args) => {
    if (process.platform === 'linux') return run(...args);
    const root = testTemporaryDirectory('cleanup-platform-refusal-');
    try {
      const record = buildCleanupOperationRecord({
        schema: 'openslack.cleanup_request.v1',
        mode: 'execute',
        agentId: 'worker',
        principalId: 'principal:worker',
        runtimeUid: 'worker',
        runId: 'run-1',
        repo: 'owner/repo',
        remote: 'origin',
        prNumber: 1,
        permitId: 'permit-1',
        operationId: 'op-1',
      });
      expect(() =>
        saveCleanupOperationRecord(record, { rootDir: root, snapshot: snapshotAllowingOutbox() }),
      ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' }));
      expect(existsSync(join(root, '.openslack'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
