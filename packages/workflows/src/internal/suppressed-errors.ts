export interface ErrorWithSuppressed extends Error {
  readonly suppressedErrors?: readonly unknown[];
}

/** Throw the primary condition without allowing later cleanup failures to replace it. */
export function throwWithSuppressed(primary: unknown, suppressed: readonly unknown[]): never {
  const meaningful = suppressed.filter((error) => error !== undefined);
  if (primary instanceof Error) {
    if (meaningful.length === 0) throw primary;
    const descriptor = Object.getOwnPropertyDescriptor(primary, 'suppressedErrors');
    const existing =
      descriptor && Object.hasOwn(descriptor, 'value') && Array.isArray(descriptor.value)
        ? descriptor.value
        : [];
    if (
      Object.isExtensible(primary) &&
      (descriptor === undefined || descriptor.configurable === true)
    ) {
      Object.defineProperty(primary, 'suppressedErrors', {
        value: Object.freeze([...existing, ...meaningful]),
        configurable: true,
        enumerable: false,
      });
      throw primary;
    }
    throw aggregate(primary, [...existing, ...meaningful]);
  }
  throw aggregate(primary, meaningful);
}

function aggregate(primary: unknown, suppressed: readonly unknown[]): AggregateError {
  const error = new AggregateError([primary, ...suppressed], 'Workflow operation failed.', {
    cause: primary,
  });
  Object.defineProperty(error, 'suppressedErrors', {
    value: Object.freeze([...suppressed]),
    configurable: false,
    enumerable: false,
  });
  return error;
}

export async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
