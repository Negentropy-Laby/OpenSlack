import { describe, expect, it } from 'vitest';
import type { WorkflowMeta } from '../types.js';
import { hashWorkflowSource, resolveWorkflowIdentityHash } from '../internal/workflow-identity.js';

const meta: WorkflowMeta = {
  name: 'identity-test',
  version: '1.0.0',
  description: 'Workflow identity test.',
  phases: [{ title: 'Run', detail: 'Run phase' }],
};

describe('workflow executable identity', () => {
  it('hashes exact file bytes without a text decoding round trip', () => {
    const bytes = Uint8Array.from([0x66, 0x6f, 0x80, 0x6f]);

    expect(hashWorkflowSource(bytes)).not.toBe(hashWorkflowSource(Buffer.from(bytes).toString()));
  });

  it('uses all exact source bytes for ambient and file-loaded workflows', () => {
    const first = 'export const value = 1;\n';
    const second = 'export const value = 1;\r\n';
    expect(resolveWorkflowIdentityHash({ meta, sourceBody: first })).toBe(
      hashWorkflowSource(first),
    );
    expect(resolveWorkflowIdentityHash({ meta, sourceBody: first })).not.toBe(
      resolveWorkflowIdentityHash({ meta, sourceBody: second }),
    );
  });

  it('binds programmatic identities to executable source even when version is unchanged', () => {
    const first = resolveWorkflowIdentityHash({
      meta,
      run: async () => ({ status: 'completed', value: 1 }),
    });
    const second = resolveWorkflowIdentityHash({
      meta,
      run: async () => ({ status: 'completed', value: 2 }),
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
  });

  it.each(['0123456789abcdef', 'identity-test:1.0.0', 'A'.repeat(64)])(
    'rejects weak or non-canonical supplied identity %s',
    (hash) => {
      expect(() => resolveWorkflowIdentityHash({ meta, hash })).toThrow('full lowercase SHA-256');
    },
  );

  it('rejects metadata-only programmatic workflows', () => {
    expect(() => resolveWorkflowIdentityHash({ meta })).toThrow('cannot be derived');
  });
});
