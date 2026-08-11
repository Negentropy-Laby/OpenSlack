export interface ErrorWithSuppressed extends Error {
  readonly suppressedErrors?: readonly unknown[];
}

/** Throw the primary condition without allowing later cleanup failures to replace it. */
export function throwWithSuppressed(primary: unknown, suppressed: readonly unknown[]): never {
  const meaningful = suppressed.filter((error) => error !== undefined);
  if (primary instanceof Error) {
    if (meaningful.length > 0) {
      const existing = (primary as ErrorWithSuppressed).suppressedErrors ?? [];
      Object.defineProperty(primary, 'suppressedErrors', {
        value: Object.freeze([...existing, ...meaningful]),
        configurable: true,
        enumerable: false,
      });
    }
    throw primary;
  }
  throw new AggregateError([primary, ...meaningful], 'Workflow operation failed.');
}

export async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
