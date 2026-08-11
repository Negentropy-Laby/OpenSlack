import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_ARGUMENTS_SCHEMA,
  WorkflowArgumentsError,
  decodeWorkflowArguments,
  encodeWorkflowArguments,
  validateWorkflowArgumentsEnvelope,
} from '../internal/workflow-arguments.js';

describe('workflow arguments v1 encoding', () => {
  it('round-trips every supported value without tag collisions or sparse-array loss', () => {
    const sparse = new Array(4);
    sparse[0] = undefined;
    sparse[2] = 9n;
    sparse[3] = new Date('2026-08-11T00:00:00.000Z');
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.schema = WORKFLOW_ARGUMENTS_SCHEMA;
    nullPrototype.t = 'array';
    nullPrototype.v = undefined;
    const prototypeKey = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const input = {
      nil: null,
      bool: true,
      text: 'value',
      finite: -0,
      bigint: 12345678901234567890n,
      absent: undefined,
      date: new Date('2026-08-11T01:02:03.004Z'),
      sparse,
      collision: { schema: 'not-an-envelope', t: 'number', v: 42 },
      prototypeKey,
      nullPrototype,
    };

    const encoded = encodeWorkflowArguments(input);
    expect(encoded.envelope.schema).toBe(WORKFLOW_ARGUMENTS_SCHEMA);
    expect(encoded.canonical).toBe(
      encodeWorkflowArguments(decodeWorkflowArguments(encoded.envelope)).canonical,
    );

    const decoded = decodeWorkflowArguments(encoded.envelope);
    expect(decoded.nil).toBeNull();
    expect(decoded.finite).toBe(-0);
    expect(decoded.bigint).toBe(12345678901234567890n);
    expect(Object.hasOwn(decoded, 'absent')).toBe(true);
    expect(decoded.absent).toBeUndefined();
    expect(decoded.date).toEqual(new Date('2026-08-11T01:02:03.004Z'));
    const decodedSparse = decoded.sparse as unknown[];
    expect(Object.hasOwn(decodedSparse, 0)).toBe(true);
    expect(Object.hasOwn(decodedSparse, 1)).toBe(false);
    expect(decodedSparse[2]).toBe(9n);
    expect(decodedSparse[3]).toEqual(new Date('2026-08-11T00:00:00.000Z'));
    expect(decoded.collision).toEqual(input.collision);
    expect(Object.hasOwn(decoded.prototypeKey as object, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(decoded.prototypeKey)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(decoded.nullPrototype)).toBeNull();
    expect(decoded.nullPrototype).toMatchObject({
      schema: WORKFLOW_ARGUMENTS_SCHEMA,
      t: 'array',
      v: undefined,
    });
  });

  it('accepts cross-realm arrays and plain objects while decoding into the local realm', () => {
    const crossRealm = runInNewContext('({ nested: [{ value: 3 }] })') as Record<string, unknown>;
    const decoded = decodeWorkflowArguments(encodeWorkflowArguments(crossRealm).envelope);
    expect(decoded).toEqual({ nested: [{ value: 3 }] });
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Array.isArray(decoded.nested)).toBe(true);
  });

  it.each([
    ['NaN', { value: Number.NaN }],
    ['Infinity', { value: Number.POSITIVE_INFINITY }],
    ['Map', { value: new Map() }],
    ['Set', { value: new Set() }],
    ['RegExp', { value: /x/u }],
    ['function', { value: () => undefined }],
    ['symbol', { value: Symbol('x') }],
    ['class instance', { value: new (class Example {})() }],
  ])('rejects unsupported %s values', (_label, input) => {
    expect(() => encodeWorkflowArguments(input)).toThrow(WorkflowArgumentsError);
  });

  it('rejects objects with a spoofed custom Object prototype', () => {
    const prototype = Object.create(null) as Record<string, unknown>;
    prototype.constructor = Object;
    const value = Object.create(prototype) as Record<string, unknown>;
    value.safe = true;

    expect(() => encodeWorkflowArguments({ value })).toThrow('non-plain object');
  });

  it('rejects accessors, symbol keys, cycles, invalid Dates, and array custom fields', () => {
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
    const symbolKey = { ok: true } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('hidden')] = 1;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const invalidDate = new Date(Number.NaN);
    const array = [1] as unknown[] & { extra?: string };
    array.extra = 'nope';

    for (const value of [accessor, symbolKey, cycle, { invalidDate }, { array }]) {
      expect(() => encodeWorkflowArguments(value as Record<string, unknown>)).toThrow(
        WorkflowArgumentsError,
      );
    }
  });

  it('enforces the shared byte, depth, node, and key bounds', () => {
    expect(() => encodeWorkflowArguments({ value: 'x'.repeat(256 * 1024) })).toThrow('256 KiB');
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 17; index += 1) deep = { deep };
    expect(() => encodeWorkflowArguments(deep)).toThrow('maximum depth');
    expect(() => encodeWorkflowArguments({ values: new Array(4097) })).toThrow(/4096/u);
    expect(() => encodeWorkflowArguments({ ['x'.repeat(257)]: true })).toThrow('256 bytes');
  });

  it('strictly validates canonical envelopes', () => {
    const encoded = encodeWorkflowArguments({ a: 1, b: 2 }).envelope;
    expect(validateWorkflowArgumentsEnvelope(encoded)).toEqual(encoded);
    expect(() =>
      validateWorkflowArgumentsEnvelope({
        ...encoded,
        root: {
          t: 'object',
          p: 'object',
          v: [
            ['b', { t: 'number', v: 2 }],
            ['a', { t: 'number', v: 1 }],
          ],
        },
      }),
    ).toThrow('not canonical');
    expect(() => validateWorkflowArgumentsEnvelope({ ...encoded, unexpected: true })).toThrow(
      'unexpected',
    );
  });
});
