import { types as nodeTypes } from 'node:util';

export interface CanonicalJsonOptions {
  readonly allowNullPrototype?: boolean;
  /** Maximum container nesting depth. The root value is depth zero. */
  readonly maxDepth?: number;
}

export class CanonicalJsonError extends TypeError {
  constructor(message = 'Value is not canonical JSON data.') {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/** Encode inert JSON data with lexicographically sorted object keys. */
export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  if (
    options.maxDepth !== undefined &&
    (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0)
  ) {
    throw new CanonicalJsonError('Canonical JSON maximum depth is invalid.');
  }
  return encode(value, options, new WeakSet<object>(), 0);
}

/** Validate and clone inert JSON data without retaining caller-owned objects. */
export function canonicalJsonRoundTrip<T>(value: T, options: CanonicalJsonOptions = {}): T {
  return JSON.parse(canonicalJson(value, options)) as T;
}

function encode(
  value: unknown,
  options: CanonicalJsonOptions,
  ancestors: WeakSet<object>,
  depth: number,
): string {
  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    throw new CanonicalJsonError('Canonical JSON depth exceeded.');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError();
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || nodeTypes.isProxy(value)) throw new CanonicalJsonError();
  if (ancestors.has(value)) throw new CanonicalJsonError('Value contains a circular reference.');

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    !isPlainObjectPrototype(prototype, options.allowNullPrototype === true)
  ) {
    throw new CanonicalJsonError();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        keys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)),
        )
      ) {
        throw new CanonicalJsonError();
      }
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new CanonicalJsonError();
        }
        encoded.push(encode(descriptor.value, options, ancestors, depth + 1));
      }
      return `[${encoded.join(',')}]`;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) throw new CanonicalJsonError();
    const record = value as Record<string, unknown>;
    return `{${(keys as string[])
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new CanonicalJsonError();
        }
        return `${JSON.stringify(key)}:${encode(descriptor.value, options, ancestors, depth + 1)}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

const nativeObjectSource = Function.prototype.toString.call(Object);

function isPlainObjectPrototype(prototype: object | null, allowNullPrototype: boolean): boolean {
  if (prototype === null) return allowNullPrototype;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  return (
    typeof constructor === 'function' &&
    Function.prototype.toString.call(constructor) === nativeObjectSource &&
    constructor.prototype === prototype
  );
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length && String(index) === key;
}
