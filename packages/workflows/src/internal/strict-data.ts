import { closedDataRecord as contractRecord } from './contract-validation.js';

export function closedDataRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  const shape = (): never => {
    throw new TypeError(`${label} has unexpected or missing fields.`);
  };
  return contractRecord(
    value,
    fields,
    label,
    {
      inert: () => {
        throw new TypeError(`${label} must be an object.`);
      },
      missing: shape,
      unknown: shape,
      dataField: shape,
    },
    { allowNullPrototype: false, keyOrder: 'utf16' },
  );
}

export function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value as number;
}

export function finiteNumber(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${label} must be a finite number greater than or equal to ${minimum}.`);
  }
  return value;
}

export function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}
