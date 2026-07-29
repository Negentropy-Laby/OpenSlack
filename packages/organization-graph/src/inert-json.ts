import { types as nodeTypes } from 'node:util';
import { GraphContractError } from './errors.js';

export interface InertGraphJsonLimits {
  readonly sourceBytes: number;
  readonly sourceJsonNodes: number;
  readonly sourceObjectProperties: number;
  readonly sourceArrayItems: number;
}

function fail(
  code: ConstructorParameters<typeof GraphContractError>[0],
  path: string,
  message: string,
): never {
  throw new GraphContractError(code, path, message);
}

/**
 * Measures inert JSON without invoking accessors, proxy traps, or caller code.
 *
 * Direct package callers receive the same bounded traversal guarantees as the
 * strict byte parser used by file/stdin importers.
 */
export function inertGraphJsonBytes(value: unknown, limits: InertGraphJsonLimits): number {
  const ancestors = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  visit(value, '$', 0);
  return bytes;

  function charge(amount: number, path: string): void {
    bytes += amount;
    if (bytes > limits.sourceBytes) {
      fail('GRAPH_BOUND_EXCEEDED', path, `source exceeds ${limits.sourceBytes} JSON bytes.`);
    }
  }

  function visit(candidate: unknown, path: string, depth: number): void {
    nodes += 1;
    if (nodes > limits.sourceJsonNodes) {
      fail('GRAPH_BOUND_EXCEEDED', path, `source exceeds ${limits.sourceJsonNodes} JSON nodes.`);
    }
    if (depth > 32) fail('GRAPH_BOUND_EXCEEDED', path, 'exceeds source nesting depth 32.');
    if (candidate === null || typeof candidate === 'boolean') {
      charge(candidate === null ? 4 : candidate ? 4 : 5, path);
      return;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        fail('GRAPH_SCHEMA_INVALID', path, 'must contain only finite JSON numbers.');
      }
      charge(Buffer.byteLength(JSON.stringify(candidate), 'utf8'), path);
      return;
    }
    if (typeof candidate === 'string') {
      charge(Buffer.byteLength(JSON.stringify(candidate), 'utf8'), path);
      return;
    }
    if (typeof candidate !== 'object') {
      return fail('GRAPH_SCHEMA_INVALID', path, 'must contain only inert JSON data.');
    }
    if (nodeTypes.isProxy(candidate)) {
      return fail('GRAPH_PROPERTY_UNSAFE', path, 'must not contain proxy objects.');
    }
    if (ancestors.has(candidate)) {
      return fail('GRAPH_SCHEMA_INVALID', path, 'must not contain cyclic references.');
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          fail('GRAPH_SCHEMA_INVALID', path, 'array prototype must be Array.prototype.');
        }
        if (candidate.length > limits.sourceArrayItems) {
          fail('GRAPH_BOUND_EXCEEDED', path, `array exceeds ${limits.sourceArrayItems} items.`);
        }
        const keys = Reflect.ownKeys(candidate);
        if (keys.length > limits.sourceArrayItems + 1) {
          fail('GRAPH_BOUND_EXCEEDED', path, 'array has too many own properties.');
        }
        for (const key of keys) {
          if (typeof key === 'symbol') {
            fail('GRAPH_SCHEMA_INVALID', path, 'must not contain symbol properties.');
          }
          if (key === 'length') continue;
          if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= candidate.length) {
            fail('GRAPH_SCHEMA_INVALID', `${path}.${key}`, 'is not a canonical array index.');
          }
        }
        charge(2 + Math.max(0, candidate.length - 1), path);
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (
            descriptor === undefined ||
            !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true
          ) {
            fail(
              'GRAPH_SCHEMA_INVALID',
              `${path}[${index}]`,
              'must be a dense enumerable data property.',
            );
          }
          visit(descriptor.value, `${path}[${index}]`, depth + 1);
        }
        return;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        fail('GRAPH_SCHEMA_INVALID', path, 'object prototype must be Object.prototype or null.');
      }
      const keys = Reflect.ownKeys(candidate);
      if (keys.length > limits.sourceObjectProperties) {
        fail(
          'GRAPH_BOUND_EXCEEDED',
          path,
          `object exceeds ${limits.sourceObjectProperties} properties.`,
        );
      }
      charge(2 + Math.max(0, keys.length - 1), path);
      for (const key of keys) {
        if (typeof key === 'symbol') {
          fail('GRAPH_SCHEMA_INVALID', path, 'must not contain symbol properties.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (
          descriptor === undefined ||
          !Object.hasOwn(descriptor, 'value') ||
          descriptor.enumerable !== true
        ) {
          fail(
            'GRAPH_SCHEMA_INVALID',
            `${path}.${key}`,
            'must be an enumerable inert data property.',
          );
        }
        charge(1 + Buffer.byteLength(JSON.stringify(key), 'utf8'), `${path}.${key}`);
        visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    } finally {
      ancestors.delete(candidate);
    }
  }
}
