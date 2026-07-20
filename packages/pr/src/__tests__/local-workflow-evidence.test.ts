import { describe, expect, it } from 'vitest';
import { parseGitLsTree } from '../local-workflow-evidence.js';

describe('parseGitLsTree', () => {
  it('preserves Git mode, type, blob identity, and paths with spaces', () => {
    const output = Buffer.from(
      '100644 blob abc123\ttemplates/workflows/feature one.yaml\0' +
        '100755 blob def456\t.openslack/workflows/run.js\0',
      'utf8',
    );

    expect(parseGitLsTree(output)).toEqual([
      {
        mode: '100644',
        type: 'blob',
        sha: 'abc123',
        path: 'templates/workflows/feature one.yaml',
      },
      {
        mode: '100755',
        type: 'blob',
        sha: 'def456',
        path: '.openslack/workflows/run.js',
      },
    ]);
  });

  it('fails closed on malformed Git output', () => {
    expect(() => parseGitLsTree('not-a-tree-record\0')).toThrow(/Malformed git ls-tree/);
  });
});
