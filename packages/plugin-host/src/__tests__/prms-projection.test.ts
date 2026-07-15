import { describe, expect, it, vi } from 'vitest';

import { PrmsProjectionError, projectPrmsReportForEvaluator } from '../prms-projection.js';

function projectionCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof PrmsProjectionError ? error.code : undefined;
  }
  return undefined;
}

describe('projectPrmsReportForEvaluator', () => {
  it('creates a fresh deeply frozen snapshot without changing the source report', () => {
    const report = {
      approvalCount: 0,
      mergeable: false,
      reviews: [{ actor: 'human', approved: false }],
    };
    const first = projectPrmsReportForEvaluator(report) as {
      readonly approvalCount: number;
      readonly reviews: readonly [{ readonly approved: boolean }];
    };
    const second = projectPrmsReportForEvaluator(report);

    expect(first).not.toBe(report);
    expect(second).not.toBe(first);
    expect(first.reviews).not.toBe(report.reviews);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.reviews)).toBe(true);
    expect(Object.isFrozen(first.reviews[0])).toBe(true);
    expect(() => {
      (first as { approvalCount: number }).approvalCount = 99;
    }).toThrow(TypeError);
    expect(() => {
      (first.reviews[0] as { approved: boolean }).approved = true;
    }).toThrow(TypeError);
    expect(report).toEqual({
      approvalCount: 0,
      mergeable: false,
      reviews: [{ actor: 'human', approved: false }],
    });
  });

  it('never invokes getters and rejects accessors, custom prototypes, symbols, and proxies', () => {
    const getter = vi.fn(() => 99);
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'approvalCount', { enumerable: true, get: getter });
    expect(projectionCode(() => projectPrmsReportForEvaluator(accessor))).toBe(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
    );
    expect(getter).not.toHaveBeenCalled();

    expect(
      projectionCode(() => projectPrmsReportForEvaluator(Object.create({ mergeable: true }))),
    ).toBe('PLUGIN_HOST_PRMS_PROJECTION_INVALID');

    const symbol = { mergeable: false } as Record<PropertyKey, unknown>;
    symbol[Symbol('approval')] = true;
    expect(projectionCode(() => projectPrmsReportForEvaluator(symbol))).toBe(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
    );

    const ownKeys = vi.fn(() => ['mergeable']);
    const proxy = new Proxy(
      { mergeable: false },
      {
        ownKeys,
      },
    );
    expect(projectionCode(() => projectPrmsReportForEvaluator(proxy))).toBe(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
    );
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it('rejects sparse/accessor arrays, dangerous keys, cycles, and non-JSON values', () => {
    const sparse = new Array(2);
    sparse[1] = 'review';
    expect(projectionCode(() => projectPrmsReportForEvaluator(sparse))).toBe(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
    );

    const arrayGetter = vi.fn(() => 'review');
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, '0', { enumerable: true, get: arrayGetter });
    Object.defineProperty(accessorArray, 'length', { value: 1, writable: true });
    expect(projectionCode(() => projectPrmsReportForEvaluator(accessorArray))).toBe(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
    );
    expect(arrayGetter).not.toHaveBeenCalled();

    const dangerous = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(dangerous, '__proto__', { value: true, enumerable: true });
    expect(projectionCode(() => projectPrmsReportForEvaluator(dangerous))).toBe(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
    );

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(projectionCode(() => projectPrmsReportForEvaluator(cycle))).toBe(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
    );

    for (const value of [undefined, 1n, Symbol('x'), () => undefined, Number.NaN]) {
      expect(projectionCode(() => projectPrmsReportForEvaluator({ value }))).toBe(
        'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
      );
    }
  });

  it('fails closed on depth, node, array, object, key, and string limits', () => {
    const cases: Array<[unknown, Record<string, number>]> = [
      [{ nested: { value: true } }, { maxDepth: 2 }],
      [[1, 2], { maxNodes: 2 }],
      [[1, 2], { maxArrayLength: 1 }],
      [{ a: 1, b: 2 }, { maxObjectProperties: 1 }],
      [{ approvalCount: 0 }, { maxKeyLength: 4 }],
      [{ detail: 'abcd' }, { maxStringLength: 3 }],
      [{ first: 'abc', second: 'def' }, { maxTotalStringLength: 5 }],
    ];
    for (const [value, limits] of cases) {
      expect(projectionCode(() => projectPrmsReportForEvaluator(value, limits))).toBe(
        'PLUGIN_HOST_PRMS_PROJECTION_LIMIT_EXCEEDED',
      );
    }
  });

  it('does not let callers raise host-owned limits', () => {
    expect(
      projectionCode(() =>
        projectPrmsReportForEvaluator({}, { maxNodes: Number.MAX_SAFE_INTEGER }),
      ),
    ).toBe('PLUGIN_HOST_PRMS_PROJECTION_INVALID');
  });
});
