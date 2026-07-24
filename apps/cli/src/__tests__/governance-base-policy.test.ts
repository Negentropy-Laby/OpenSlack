import { describe, expect, it } from 'vitest';
import { findNonCanonicalMergedPRs, parseMergedPRAuditEvidence } from '../commands/governance.js';

describe('governance canonical PR base audit', () => {
  it('ignores historical PR #296 and earlier while rejecting later non-main merges', () => {
    const evidence = [
      { number: 295, baseRefName: 'integration/notification-delivery-0.3' },
      { number: 296, baseRefName: 'main' },
      { number: 297, baseRefName: 'main' },
      { number: 298, baseRefName: 'release/0.3' },
    ];

    expect(findNonCanonicalMergedPRs(evidence, 'main', 296)).toEqual([evidence[3]]);
  });

  it('parses baseRefName and fails closed on incomplete metadata', () => {
    expect(
      parseMergedPRAuditEvidence(
        JSON.stringify([
          { number: 297, baseRefName: 'main', mergeCommit: { oid: 'a'.repeat(40) } },
        ]),
      ),
    ).toEqual([{ number: 297, baseRefName: 'main', mergeCommitOid: 'a'.repeat(40) }]);
    expect(() => parseMergedPRAuditEvidence(JSON.stringify([{ number: 298 }]))).toThrow(
      'missing number or baseRefName',
    );
    expect(() =>
      parseMergedPRAuditEvidence(JSON.stringify([{ number: 298, baseRefName: '' }])),
    ).toThrow('missing number or baseRefName');
  });
});
