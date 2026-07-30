import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  StrictGraphJsonError,
  canonicalJson,
  parseStrictGraphJson,
} from '../index.js';

function expectCanonicalError(
  run: () => unknown,
  code: CanonicalJsonError['code'],
  path: string,
): void {
  expect(run).toThrowError(
    expect.objectContaining<Partial<CanonicalJsonError>>({
      name: 'CanonicalJsonError',
      code,
      path,
    }),
  );
}

describe('canonical JSON JavaScript-only adversarial inputs', () => {
  it('rejects sparse arrays instead of emitting invalid elisions', () => {
    const sparse = new Array(2);
    sparse[1] = 'present';
    expectCanonicalError(() => canonicalJson(sparse), 'CANONICAL_JSON_SPARSE_ARRAY', '$[0]');
  });

  it('exposes stable codes for undefined, non-finite, forbidden, and unsupported inputs', () => {
    expectCanonicalError(
      () => canonicalJson({ value: undefined }),
      'CANONICAL_JSON_UNDEFINED',
      '$.value',
    );
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectCanonicalError(() => canonicalJson(value), 'CANONICAL_JSON_NON_FINITE_NUMBER', '$');
    }
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      const value = Object.create(null) as Record<string, unknown>;
      value[key] = 'blocked';
      expectCanonicalError(() => canonicalJson(value), 'CANONICAL_JSON_FORBIDDEN_KEY', `$.${key}`);
    }
    for (const value of [undefined, 1n, Symbol('blocked'), () => undefined]) {
      expectCanonicalError(() => canonicalJson(value), 'CANONICAL_JSON_UNSUPPORTED_TYPE', '$');
    }
  });
});

describe('strict graph JSON surrogate behavior', () => {
  it('accepts a paired surrogate and rejects lone escaped surrogates at the string offset', () => {
    expect(parseStrictGraphJson(Buffer.from('{"value":"\\ud83d\\ude00"}', 'utf8'))).toEqual({
      value: '😀',
    });
    for (const source of ['{"value":"\\ud800"}', '{"value":"\\udc00"}']) {
      expect(() => parseStrictGraphJson(Buffer.from(source, 'utf8'))).toThrowError(
        expect.objectContaining<Partial<StrictGraphJsonError>>({
          name: 'StrictGraphJsonError',
          code: 'GRAPH_JSON_SYNTAX_INVALID',
          offset: 9,
        }),
      );
    }
  });
});
