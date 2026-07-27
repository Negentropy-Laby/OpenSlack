const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  return encode(value);

  function encode(item: unknown): string {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Canonical JSON rejects non-finite numbers.');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (!item || typeof item !== 'object') {
      throw new TypeError(`Canonical JSON rejects ${typeof item}.`);
    }
    const object = item as Record<string, unknown>;
    const members = Object.keys(object)
      .sort(compare)
      .map((key) => {
        if (FORBIDDEN_KEYS.has(key)) {
          throw new TypeError(`Canonical JSON rejects key ${key}.`);
        }
        if (object[key] === undefined) throw new TypeError('Canonical JSON rejects undefined.');
        return `${JSON.stringify(key)}:${encode(object[key])}`;
      });
    return `{${members.join(',')}}`;
  }
}
