import { describe, expect, it } from 'vitest';
import {
  compilePathGlob,
  matchesPathGlob,
  pathGlobCovers,
  pathGlobsIntersect,
} from '../path-glob.js';

describe('path glob matcher', () => {
  it('keeps regex metacharacters literal without throwing', () => {
    for (const pattern of ['(', '(a+)+', '[abc].ts', 'file.{js,ts}', 'a|b']) {
      expect(() => matchesPathGlob(pattern, pattern)).not.toThrow();
      expect(matchesPathGlob(pattern, pattern)).toBe(true);
    }
    expect(matchesPathGlob('(a+)+', 'aaaa!')).toBe(false);
    expect(matchesPathGlob('[abc].ts', 'a.ts')).toBe(false);
  });

  it('handles long hostile input without a dynamic regular expression', () => {
    const matches = compilePathGlob('**/safe/*.ts');
    expect(matches(`${'a/'.repeat(10_000)}safe/file.ts`)).toBe(true);
    expect(matches(`${'a'.repeat(20_000)}!`)).toBe(false);
  });

  it('preserves star, globstar, and globstar-directory semantics', () => {
    expect(matchesPathGlob('packages/*/file.ts', 'packages/core/file.ts')).toBe(true);
    expect(matchesPathGlob('packages/*/file.ts', 'packages/core/nested/file.ts')).toBe(false);
    expect(matchesPathGlob('packages/**', 'packages/core/nested/file.ts')).toBe(true);
    expect(matchesPathGlob('**/secret.txt', 'secret.txt')).toBe(true);
    expect(matchesPathGlob('**/secret.txt', 'deep/nested/secret.txt')).toBe(true);
  });

  it('decides glob intersections without interpreting regex metacharacters', () => {
    expect(pathGlobsIntersect('packages/**', 'packages/kernel/src/**')).toBe(true);
    expect(pathGlobsIntersect('packages/core/**', 'packages/kernel/src/**')).toBe(false);
    expect(pathGlobsIntersect('docs/[abc].ts', 'docs/a.ts')).toBe(false);
    expect(pathGlobsIntersect('**', 'secrets/**')).toBe(true);
  });

  it('proves declared scopes are covered by permission globs', () => {
    expect(pathGlobCovers('**', 'packages/core/**')).toBe(true);
    expect(pathGlobCovers('docs/**', 'docs/evidence/**')).toBe(true);
    expect(pathGlobCovers('packages/core/**', 'packages/**')).toBe(false);
    expect(pathGlobCovers('**/*.pem', 'docs/**/*.pem')).toBe(true);
    expect(pathGlobCovers('**/*.pem', 'docs/**')).toBe(false);
  });
});
