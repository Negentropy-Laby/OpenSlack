import { describe, expect, it } from 'vitest';
import {
  parseStrictJsonBytes,
  resolveStrictJsonLimits,
  StrictJsonError,
  STRICT_JSON_MAX_DEPTH,
  STRICT_JSON_MAX_NODES,
  STRICT_JSON_MAX_STRING_LENGTH,
} from '../strict-json.js';

function bytes(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function expectStrictError(input: Buffer, code: StrictJsonError['code']): void {
  try {
    parseStrictJsonBytes(input);
    throw new Error('Expected strict JSON parsing to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(StrictJsonError);
    expect((error as StrictJsonError).code).toBe(code);
    expect(Number.isSafeInteger((error as StrictJsonError).offset)).toBe(true);
  }
}

describe('parseStrictJsonBytes', () => {
  it('parses the complete JSON grammar into prototype-safe objects', () => {
    const value = parseStrictJsonBytes(
      bytes(
        ' {"text":"line\\n\\u0061","number":-1.25e+2,"yes":true,"no":false,"nil":null,"list":[1,2]} \n',
      ),
    ) as Record<string, unknown>;

    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value).toEqual({
      text: 'line\na',
      number: -125,
      yes: true,
      no: false,
      nil: null,
      list: [1, 2],
    });
    expect(Object.getOwnPropertyDescriptor(value, 'text')).toMatchObject({
      enumerable: true,
      configurable: false,
      writable: false,
    });
    expect(Reflect.set(value, 'text', 'mutated')).toBe(false);
    expect(value.text).toBe('line\na');
  });

  it.each([
    '{"same":1,"same":2}',
    '{"same":1,"\\u0073ame":2}',
    '{"\\u005f\\u005fproto__":1,"__proto__":2}',
    '{"outer":{"id":1,"\\u0069d":2}}',
  ])('rejects decoded-equivalent duplicate keys: %s', (input) => {
    expectStrictError(bytes(input), 'STRICT_JSON_DUPLICATE_KEY');
  });

  it('stores dangerous keys as inert own data rather than mutating prototypes', () => {
    const value = parseStrictJsonBytes(bytes('{"__proto__":{"polluted":true}}')) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects a UTF-8 BOM and malformed UTF-8 before syntax parsing', () => {
    expectStrictError(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('{"ok":true}')]),
      'STRICT_JSON_BOM_FORBIDDEN',
    );
    expectStrictError(
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]),
      'STRICT_JSON_UTF8_INVALID',
    );
  });

  it.each([
    '',
    '{',
    '{"a":1,}',
    '[1,]',
    '{/*comment*/"a":1}',
    '{"a":1}//comment',
    '{"a":01}',
    '{"a":1.}',
    '{"a":NaN}',
    '{"a":"\\x41"}',
    '{"a":"\u0001"}',
    'true false',
  ])('rejects non-JSON syntax without fallback parsing: %j', (input) => {
    expectStrictError(bytes(input), 'STRICT_JSON_SYNTAX_INVALID');
  });

  it('rejects numbers that overflow the finite JavaScript number domain', () => {
    expectStrictError(bytes('1e9999'), 'STRICT_JSON_NUMBER_NON_FINITE');
  });

  it('enforces depth, node, and decoded-string limits', () => {
    expect(() => parseStrictJsonBytes(bytes('{"a":{"b":1}}'), { maxDepth: 2 })).toThrowError(
      expect.objectContaining({ code: 'STRICT_JSON_DEPTH_EXCEEDED' }),
    );
    expect(() => parseStrictJsonBytes(bytes('[1,2,3]'), { maxNodes: 3 })).toThrowError(
      expect.objectContaining({ code: 'STRICT_JSON_NODE_LIMIT_EXCEEDED' }),
    );
    expect(() => parseStrictJsonBytes(bytes('"abc"'), { maxStringLength: 2 })).toThrowError(
      expect.objectContaining({ code: 'STRICT_JSON_STRING_LIMIT_EXCEEDED' }),
    );
    expect(() => parseStrictJsonBytes(bytes('"\\u0061bc"'), { maxStringLength: 2 })).toThrowError(
      expect.objectContaining({ code: 'STRICT_JSON_STRING_LIMIT_EXCEEDED' }),
    );
  });

  it('never lets caller-supplied limits raise built-in ceilings', () => {
    expect(
      resolveStrictJsonLimits({
        maxDepth: Number.MAX_SAFE_INTEGER,
        maxNodes: Number.MAX_SAFE_INTEGER,
        maxStringLength: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({
      maxDepth: STRICT_JSON_MAX_DEPTH,
      maxNodes: STRICT_JSON_MAX_NODES,
      maxStringLength: STRICT_JSON_MAX_STRING_LENGTH,
    });
    expect(
      resolveStrictJsonLimits({ maxDepth: 0, maxNodes: Number.NaN, maxStringLength: -1 }),
    ).toEqual({
      maxDepth: 1,
      maxNodes: 1,
      maxStringLength: 1,
    });
  });
});
