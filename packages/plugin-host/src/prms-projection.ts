import { types as utilTypes } from 'node:util';

export type PrmsProjectionPrimitive = null | boolean | number | string;
export type PrmsProjectionValue =
  | PrmsProjectionPrimitive
  | readonly PrmsProjectionValue[]
  | Readonly<{ [key: string]: PrmsProjectionValue }>;

export interface PrmsProjectionLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxObjectProperties: number;
  readonly maxKeyLength: number;
  readonly maxStringLength: number;
  readonly maxTotalStringLength: number;
}

export const DEFAULT_PRMS_PROJECTION_LIMITS: Readonly<PrmsProjectionLimits> = Object.freeze({
  maxDepth: 32,
  maxNodes: 10_000,
  maxArrayLength: 1_000,
  maxObjectProperties: 1_000,
  maxKeyLength: 128,
  maxStringLength: 65_536,
  maxTotalStringLength: 1_048_576,
});

export const PRMS_PROJECTION_ERROR_CODES = Object.freeze([
  'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
  'PLUGIN_HOST_PRMS_PROJECTION_LIMIT_EXCEEDED',
] as const);

export type PrmsProjectionErrorCode = (typeof PRMS_PROJECTION_ERROR_CODES)[number];

export class PrmsProjectionError extends Error {
  readonly code: PrmsProjectionErrorCode;
  readonly path: string;

  constructor(code: PrmsProjectionErrorCode, path: string, message: string) {
    super(message);
    this.name = 'PrmsProjectionError';
    this.code = code;
    this.path = path;
  }
}

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

interface ProjectionState {
  readonly limits: PrmsProjectionLimits;
  readonly active: WeakSet<object>;
  nodes: number;
  totalStringLength: number;
}

function fail(code: PrmsProjectionErrorCode, path: string, message: string): never {
  throw new PrmsProjectionError(code, path, message);
}

function pointer(parent: string, segment: string | number): string {
  const escaped = String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
  return `${parent}/${escaped}`;
}

function boundedPositiveInteger(
  value: number | undefined,
  ceiling: number,
  name: keyof PrmsProjectionLimits,
): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
      `/limits/${name}`,
      'PRMS projection limits may only lower the host-owned positive ceiling.',
    );
  }
  return value;
}

export function resolvePrmsProjectionLimits(
  limits: Partial<PrmsProjectionLimits> = {},
): Readonly<PrmsProjectionLimits> {
  return Object.freeze({
    maxDepth: boundedPositiveInteger(
      limits.maxDepth,
      DEFAULT_PRMS_PROJECTION_LIMITS.maxDepth,
      'maxDepth',
    ),
    maxNodes: boundedPositiveInteger(
      limits.maxNodes,
      DEFAULT_PRMS_PROJECTION_LIMITS.maxNodes,
      'maxNodes',
    ),
    maxArrayLength: boundedPositiveInteger(
      limits.maxArrayLength,
      DEFAULT_PRMS_PROJECTION_LIMITS.maxArrayLength,
      'maxArrayLength',
    ),
    maxObjectProperties: boundedPositiveInteger(
      limits.maxObjectProperties,
      DEFAULT_PRMS_PROJECTION_LIMITS.maxObjectProperties,
      'maxObjectProperties',
    ),
    maxKeyLength: boundedPositiveInteger(
      limits.maxKeyLength,
      DEFAULT_PRMS_PROJECTION_LIMITS.maxKeyLength,
      'maxKeyLength',
    ),
    maxStringLength: boundedPositiveInteger(
      limits.maxStringLength,
      DEFAULT_PRMS_PROJECTION_LIMITS.maxStringLength,
      'maxStringLength',
    ),
    maxTotalStringLength: boundedPositiveInteger(
      limits.maxTotalStringLength,
      DEFAULT_PRMS_PROJECTION_LIMITS.maxTotalStringLength,
      'maxTotalStringLength',
    ),
  });
}

function countNode(state: ProjectionState, path: string, depth: number): void {
  if (depth > state.limits.maxDepth) {
    fail(
      'PLUGIN_HOST_PRMS_PROJECTION_LIMIT_EXCEEDED',
      path,
      'PRMS report nesting exceeds the host-owned depth limit.',
    );
  }
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    fail(
      'PLUGIN_HOST_PRMS_PROJECTION_LIMIT_EXCEEDED',
      path,
      'PRMS report exceeds the host-owned node limit.',
    );
  }
}

function projectString(value: string, state: ProjectionState, path: string): string {
  if (value.length > state.limits.maxStringLength) {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_LIMIT_EXCEEDED',
      path,
      'PRMS report string exceeds the host-owned per-string limit.',
    );
  }
  state.totalStringLength += value.length;
  if (state.totalStringLength > state.limits.maxTotalStringLength) {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_LIMIT_EXCEEDED',
      path,
      'PRMS report strings exceed the host-owned aggregate limit.',
    );
  }
  return value;
}

function ownDescriptors(value: object, path: string): PropertyDescriptorMap {
  try {
    if (utilTypes.isProxy(value)) {
      return fail(
        'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
        path,
        'Proxy objects are forbidden in a PRMS evaluator projection.',
      );
    }
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
      path,
      'PRMS report object could not be inspected without executing code.',
    );
  }
}

function dataDescriptor(
  descriptors: PropertyDescriptorMap,
  key: string,
  path: string,
  enumerable = true,
): PropertyDescriptor & { value: unknown } {
  const descriptor = descriptors[key];
  if (!descriptor || descriptor.enumerable !== enumerable || !Object.hasOwn(descriptor, 'value')) {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
      path,
      'PRMS report fields must be own data properties with the expected enumerability.',
    );
  }
  return descriptor as PropertyDescriptor & { value: unknown };
}

function projectArray(
  value: readonly unknown[],
  descriptors: PropertyDescriptorMap,
  state: ProjectionState,
  path: string,
  depth: number,
): readonly PrmsProjectionValue[] {
  const lengthDescriptor = dataDescriptor(descriptors, 'length', pointer(path, 'length'), false);
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || (length as number) < 0 || length !== value.length) {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
      pointer(path, 'length'),
      'PRMS report array length is invalid.',
    );
  }
  if (value.length > state.limits.maxArrayLength) {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_LIMIT_EXCEEDED',
      path,
      'PRMS report array exceeds the host-owned length limit.',
    );
  }

  const allowedKeys = new Set<string>(['length']);
  const output: PrmsProjectionValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    const descriptor = dataDescriptor(descriptors, key, pointer(path, index));
    output.push(projectValue(descriptor.value, state, pointer(path, index), depth + 1));
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      return fail(
        'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
        path,
        'PRMS report arrays cannot contain named, sparse, or symbol fields.',
      );
    }
  }
  return Object.freeze(output);
}

function projectRecord(
  value: object,
  descriptors: PropertyDescriptorMap,
  state: ProjectionState,
  path: string,
  depth: number,
): Readonly<{ [key: string]: PrmsProjectionValue }> {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
      path,
      'PRMS report prototype could not be inspected safely.',
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
      path,
      'PRMS report values must be plain data objects.',
    );
  }

  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > state.limits.maxObjectProperties) {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_LIMIT_EXCEEDED',
      path,
      'PRMS report object exceeds the host-owned property limit.',
    );
  }
  const stringKeys: string[] = [];
  for (const key of keys) {
    if (typeof key === 'string' && key.length > state.limits.maxKeyLength) {
      return fail(
        'PLUGIN_HOST_PRMS_PROJECTION_LIMIT_EXCEEDED',
        pointer(path, key),
        'PRMS report key exceeds the host-owned length limit.',
      );
    }
    if (typeof key !== 'string' || key.length === 0 || DANGEROUS_KEYS.has(key.toLowerCase())) {
      return fail(
        'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
        typeof key === 'string' ? pointer(path, key) : path,
        'PRMS report contains a forbidden, symbol, or empty key.',
      );
    }
    stringKeys.push(key);
  }

  const output: Record<string, PrmsProjectionValue> = Object.create(null) as Record<
    string,
    PrmsProjectionValue
  >;
  for (const key of stringKeys.sort()) {
    const descriptor = dataDescriptor(descriptors, key, pointer(path, key));
    Object.defineProperty(output, key, {
      value: projectValue(descriptor.value, state, pointer(path, key), depth + 1),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(output);
}

function projectValue(
  value: unknown,
  state: ProjectionState,
  path: string,
  depth: number,
): PrmsProjectionValue {
  countNode(state, path, depth);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return projectString(value, state, path);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return fail(
        'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
        path,
        'PRMS report numbers must be finite.',
      );
    }
    return value;
  }
  if (typeof value !== 'object') {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
      path,
      'PRMS report contains a non-JSON runtime value.',
    );
  }
  if (utilTypes.isProxy(value)) {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
      path,
      'Proxy objects are forbidden in a PRMS evaluator projection.',
    );
  }
  if (state.active.has(value)) {
    return fail(
      'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
      path,
      'Cyclic PRMS report data is forbidden.',
    );
  }

  state.active.add(value);
  try {
    const descriptors = ownDescriptors(value, path);
    if (Array.isArray(value)) {
      let prototype: object | null;
      try {
        prototype = Object.getPrototypeOf(value) as object | null;
      } catch {
        return fail(
          'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
          path,
          'PRMS report array prototype could not be inspected safely.',
        );
      }
      if (prototype !== Array.prototype) {
        return fail(
          'PLUGIN_HOST_PRMS_PROJECTION_INVALID',
          path,
          'PRMS report arrays must use the intrinsic array prototype.',
        );
      }
      return projectArray(value, descriptors, state, path, depth);
    }
    return projectRecord(value, descriptors, state, path, depth);
  } finally {
    state.active.delete(value);
  }
}

/**
 * Rebuilds one evaluator-local, deeply frozen JSON-data projection. Calling this
 * for each evaluator prevents a reviewed bundled extension from mutating the
 * caller's PRMS report or another evaluator's view of it.
 */
export function projectPrmsReportForEvaluator(
  report: unknown,
  limits: Partial<PrmsProjectionLimits> = {},
): PrmsProjectionValue {
  return projectValue(
    report,
    {
      limits: resolvePrmsProjectionLimits(limits),
      active: new WeakSet<object>(),
      nodes: 0,
      totalStringLength: 0,
    },
    '',
    1,
  );
}
