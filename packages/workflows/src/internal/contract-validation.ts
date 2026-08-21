import { types as nodeTypes } from 'node:util';

export type ContractDataRecord = Record<string, unknown>;

export interface ClosedRecordFailures {
  readonly inert: (path: string) => never;
  readonly missing: (path: string, field: string) => never;
  readonly unknown: (path: string, key: PropertyKey) => never;
  readonly dataField: (path: string, key: PropertyKey) => never;
}

export interface ClosedRecordOptions {
  /** Select a deterministic ECMAScript UTF-16 order for string-key diagnostics. */
  readonly keyOrder?: 'reflection' | 'utf16';
  /** Null-prototype objects are inert and accepted by default. */
  readonly allowNullPrototype?: boolean;
}

/** Shared inert-object mechanics; callers retain their frozen error surface. */
export function closedDataRecord(
  value: unknown,
  fields: readonly string[],
  path: string,
  failures: ClosedRecordFailures,
  options: ClosedRecordOptions = {},
): ContractDataRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, ...(options.allowNullPrototype === false ? [] : [null])].includes(
      Object.getPrototypeOf(value) as never,
    )
  ) {
    return failures.inert(path);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) failures.missing(path, field);
  }
  const reflectedKeys = Reflect.ownKeys(value);
  const keys =
    options.keyOrder === 'utf16'
      ? [
          ...reflectedKeys.filter((key): key is string => typeof key === 'string').sort(),
          ...reflectedKeys.filter((key): key is symbol => typeof key === 'symbol'),
        ]
      : reflectedKeys;
  for (const key of keys) {
    if (typeof key !== 'string' || !fields.includes(key)) failures.unknown(path, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      failures.dataField(path, key);
    }
  }
  return value as ContractDataRecord;
}

export function ownDataField(value: ContractDataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

export function canonicalUtcTimestamp(
  value: unknown,
  path: string,
  validateText: (value: unknown, path: string) => string,
  invalid: (path: string) => never,
): string {
  const result = validateText(value, path);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(Date.parse(result)).toISOString() !== result
  ) {
    return invalid(path);
  }
  return result;
}

export function immutableContractValue<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(immutableContractValue);
  else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(immutableContractValue);
  }
  return Object.freeze(value);
}
