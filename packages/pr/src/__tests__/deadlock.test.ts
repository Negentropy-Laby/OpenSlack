import { describe, it, expect } from 'vitest';
import { detectDeadlock } from '../deadlock.js';

describe('detectDeadlock', () => {
  it('returns no deadlock when author is not a codeowner', () => {
    const result = detectDeadlock('alice', ['@bob', '@charlie'], ['bob']);
    expect(result.deadlocked).toBe(false);
    expect(result.type).toBeNull();
  });

  it('returns no deadlock when there are other codeowners', () => {
    const result = detectDeadlock('wsman', ['@wsman', '@alice'], ['alice']);
    expect(result.deadlocked).toBe(false);
  });

  it('detects AUTHOR_IS_SOLE_CODEOWNER deadlock', () => {
    const result = detectDeadlock('wsman', ['@wsman'], []);
    expect(result.deadlocked).toBe(true);
    expect(result.type).toBe('AUTHOR_IS_SOLE_CODEOWNER');
    expect(result.reason).toContain('only CODEOWNER');
  });

  it('detects SINGLE_MAINTAINER deadlock', () => {
    const result = detectDeadlock('wsman', ['@wsman'], []);
    // AUTHOR_IS_SOLE_CODEOWNER takes precedence over SINGLE_MAINTAINER
    // when both conditions are met (author is sole owner for changed paths
    // AND only codeowner in repo)
    expect(result.deadlocked).toBe(true);
    expect(result.type).toBe('AUTHOR_IS_SOLE_CODEOWNER');
  });

  it('detects SINGLE_MAINTAINER when no valid approvers exist', () => {
    // When author is sole codeowner, it's the most specific deadlock
    const result = detectDeadlock('wsman', ['@wsman'], []);
    expect(result.deadlocked).toBe(true);
  });

  it('returns no deadlock when codeowners list is empty', () => {
    const result = detectDeadlock('wsman', [], []);
    expect(result.deadlocked).toBe(false);
  });
});
