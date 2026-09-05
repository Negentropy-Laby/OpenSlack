import { describe, expect, it } from 'vitest';
import { isWorkflowRunId, isWorkflowRunPathId } from '../internal/workflow-run-identity.js';
import { RunStore } from '../run-store.js';

describe('logical workflow IDs and platform path IDs', () => {
  it.each(['run', 'run:historic', 'run._@-9', 'r'.repeat(256)])(
    'preserves legal wire and POSIX IDs: %s',
    (id) => {
      expect(isWorkflowRunId(id)).toBe(true);
      expect(isWorkflowRunPathId(id, 'linux')).toBe(true);
      expect(isWorkflowRunPathId(id, 'win32')).toBe(!id.includes(':'));
    },
  );
  it.each(['', '_run', '../run', 'run/child', 'run\\child', 'r'.repeat(257), '运行', null])(
    'rejects unsafe logical IDs: %s',
    (id) => {
      expect(isWorkflowRunId(id)).toBe(false);
      expect(isWorkflowRunPathId(id, 'linux')).toBe(false);
      expect(isWorkflowRunPathId(id, 'win32')).toBe(false);
    },
  );
  it('checks directory IDs at the store boundary before any I/O', () => {
    const store = new RunStore({ baseDir: '.', access: 'read-only' });
    expect(() => store.runDir('../outside')).toThrow('identifier');
    if (process.platform === 'win32')
      expect(() => store.runDir('run:stream')).toThrow('identifier');
    else expect(store.runDir('run:historical')).toContain('run:historical');
  });
});
