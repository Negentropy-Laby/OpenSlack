const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const CANONICAL_JSON_ERROR_CODES = Object.freeze([
  'CANONICAL_JSON_NON_FINITE_NUMBER',
  'CANONICAL_JSON_UNSUPPORTED_TYPE',
  'CANONICAL_JSON_FORBIDDEN_KEY',
  'CANONICAL_JSON_UNDEFINED',
  'CANONICAL_JSON_SPARSE_ARRAY',
] as const);

export type CanonicalJsonErrorCode = (typeof CANONICAL_JSON_ERROR_CODES)[number];

export class CanonicalJsonError extends TypeError {
  readonly code: CanonicalJsonErrorCode;
  readonly path: string;

  constructor(code: CanonicalJsonErrorCode, path: string, message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
    this.code = code;
    this.path = path;
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function canonicalJson(value: unknown): string {
  return encode(value, '$');

  function encode(item: unknown, path: string): string {
    if (typeof item === 'string' && hasUnpairedSurrogate(item)) {
      throw new CanonicalJsonError(
        'CANONICAL_JSON_UNSUPPORTED_TYPE',
        path,
        'Canonical JSON rejects unpaired Unicode surrogates.',
      );
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new CanonicalJsonError(
          'CANONICAL_JSON_NON_FINITE_NUMBER',
          path,
          'Canonical JSON rejects non-finite numbers.',
        );
      }
      return JSON.stringify(item);
    }
    if (!item || typeof item !== 'object') {
      throw new CanonicalJsonError(
        'CANONICAL_JSON_UNSUPPORTED_TYPE',
        path,
        `Canonical JSON rejects ${typeof item}.`,
      );
    }
    if (Array.isArray(item)) return encodeArray(item, path);
    return encodeObject(item as Record<string, unknown>, path);
  }

  function encodeArray(array: unknown[], path: string): string {
    for (let index = 0; index < array.length; index += 1) {
      if (!Object.hasOwn(array, index)) {
        throw new CanonicalJsonError(
          'CANONICAL_JSON_SPARSE_ARRAY',
          `${path}[${index}]`,
          'Canonical JSON rejects sparse arrays.',
        );
      }
    }
    return `[${array.map((value, index) => encode(value, `${path}[${index}]`)).join(',')}]`;
  }

  function encodeObject(object: Record<string, unknown>, path: string): string {
    const members = Object.keys(object)
      .sort(compare)
      .map((key) => {
        if (hasUnpairedSurrogate(key)) {
          throw new CanonicalJsonError(
            'CANONICAL_JSON_UNSUPPORTED_TYPE',
            path,
            'Canonical JSON rejects unpaired Unicode surrogate keys.',
          );
        }
        if (FORBIDDEN_KEYS.has(key)) {
          throw new CanonicalJsonError(
            'CANONICAL_JSON_FORBIDDEN_KEY',
            `${path}.${key}`,
            `Canonical JSON rejects key ${key}.`,
          );
        }
        if (object[key] === undefined) {
          throw new CanonicalJsonError(
            'CANONICAL_JSON_UNDEFINED',
            `${path}.${key}`,
            'Canonical JSON rejects undefined.',
          );
        }
        return `${JSON.stringify(key)}:${encode(object[key], `${path}.${key}`)}`;
      });
    return `{${members.join(',')}}`;
  }
}
