import { describe, expect, it } from 'vitest';
import {
  testBash,
  testExecutable,
  testProcessEnvironment,
} from '../../../../scripts/testing/process-fixture.mjs';

describe('test process environment', () => {
  it.each([{}, { Path: 'preferred path', PATH: 'duplicate', PathExt: '.BROKEN' }])(
    'normalizes incomplete or ambiguous Windows environment %j',
    (parent) => {
      const env = testProcessEnvironment(parent);
      expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
      expect(Object.keys(env).filter((key) => key.toLowerCase() === 'pathext')).toEqual([
        'PATHEXT',
      ]);
      expect(env.PATHEXT).toContain('.EXE');
      expect(env.PATH).toBe(parent.Path ?? '');
    },
  );
  it('uses the running Node independently of a missing PATH', () => {
    expect(testExecutable('node', testProcessEnvironment({}))).toBeTruthy();
  });
  it('diagnoses an unavailable Bun without searching ambient PATH', () => {
    expect(() => testExecutable('bun', testProcessEnvironment({}))).toThrow(
      'TEST_EXECUTABLE_UNAVAILABLE',
    );
  });
  it('rejects a non-shell executable instead of treating it as Bash', () => {
    expect(() => testBash(testProcessEnvironment(), [process.execPath])).toThrow(
      'TEST_BASH_UNAVAILABLE',
    );
  });
});
