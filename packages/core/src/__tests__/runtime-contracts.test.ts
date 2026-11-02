import { describe, expect, it } from 'vitest';
import { CONFIRMATION_CAPABILITY_PATTERN, readExecutionEligibilityRestriction, nativePathSpellingEqual,
  resolvedPathsEqual, HARNESS_CONFIRMATION_PENDING_LIMIT, RUN_UNAVAILABLE_REASONS } from '../runtime-contracts.js';

describe('shared runtime syntax without authority', () => {
  it('retains the explicit confirmation grammar and independent capacity', () => {
    expect(HARNESS_CONFIRMATION_PENDING_LIMIT).toBe(128);
    for (const length of [31, 32, 128, 129]) expect(CONFIRMATION_CAPABILITY_PATTERN.test('a'.repeat(length))).toBe(length >= 32 && length <= 128);
    expect(CONFIRMATION_CAPABILITY_PATTERN.test('a'.repeat(32) + ':')).toBe(false);
    expect(Object.isFrozen(RUN_UNAVAILABLE_REASONS)).toBe(true);
  });
  it('samples an explicit clock boundary without renewing a restriction', () => {
    const input = { mode: 'required', expiresAt: 100 };
    expect(readExecutionEligibilityRestriction(input, 99)).toEqual(input);
    for (const now of [100, 101, NaN, Infinity]) expect(() => readExecutionEligibilityRestriction(input, now)).toThrow();
    expect(input).toEqual({ mode: 'required', expiresAt: 100 });
    expect(() => readExecutionEligibilityRestriction({ ...input, extra: true }, 99)).toThrow();
    expect(() => readExecutionEligibilityRestriction({ mode: 'not_applicable', expiresAt: 100 }, 99)).toThrow();
  });
  it('does not replace lexical alias checks with resolved equality', () => {
    expect(nativePathSpellingEqual('C:\\work\\x\\..\\y', 'c:\\work\\y', 'win32')).toBe(false);
    expect(resolvedPathsEqual('C:\\work\\x\\..\\y', 'c:\\work\\y', 'win32')).toBe(true);
    expect(nativePathSpellingEqual('/Work', '/work', 'linux')).toBe(false);
    expect(resolvedPathsEqual('/work/x/../y', '/work/y', 'linux')).toBe(true);
  });
});
