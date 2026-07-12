import { describe, it, expect } from 'vitest';
import { filterValidApprovals, isBotUser } from '../approvals.js';

describe('isBotUser', () => {
  it('detects [bot] suffix', () => {
    expect(isBotUser('dependabot[bot]')).toBe(true);
    expect(isBotUser('renovate[bot]')).toBe(true);
  });

  it('detects known bot names', () => {
    expect(isBotUser('github-actions')).toBe(true);
    expect(isBotUser('openslack-bot')).toBe(true);
    expect(isBotUser('dependabot')).toBe(true);
    expect(isBotUser('renovate')).toBe(true);
  });

  it('returns false for human users', () => {
    expect(isBotUser('wsman')).toBe(false);
    expect(isBotUser('alice')).toBe(false);
  });
});

describe('filterValidApprovals', () => {
  it('includes APPROVED reviews from other humans', () => {
    const reviews = [
      { user: 'wsman', state: 'APPROVED', commitOid: 'old-head' },
      { user: 'alice', state: 'APPROVED', commitOid: 'current-head' },
    ];
    expect(filterValidApprovals(reviews, 'bob')).toEqual(['wsman', 'alice']);
    expect(filterValidApprovals(reviews, 'bob', 'current-head')).toEqual(['alice']);
  });

  it('excludes the author', () => {
    const reviews = [{ user: 'wsman', state: 'APPROVED' }];
    expect(filterValidApprovals(reviews, 'wsman')).toEqual([]);
    expect(filterValidApprovals(reviews, 'WSMAN')).toEqual([]);
  });

  it('excludes non-APPROVED states', () => {
    const reviews = [
      { user: 'alice', state: 'CHANGES_REQUESTED' },
      { user: 'bob', state: 'COMMENTED' },
    ];
    expect(filterValidApprovals(reviews, 'wsman')).toEqual([]);
  });

  it('excludes bot approvals', () => {
    const reviews = [
      { user: 'dependabot[bot]', state: 'APPROVED' },
      { user: 'github-actions', state: 'APPROVED' },
      { user: 'alice', state: 'APPROVED' },
    ];
    expect(filterValidApprovals(reviews, 'wsman')).toEqual(['alice']);
  });
});
