export const DEFAULT_PLUGIN_OPERATION_TIMEOUT_MS = 5_000;
export const MAX_PLUGIN_OPERATION_TIMEOUT_MS = 30_000;

export class PluginOperationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super('Plugin operation exceeded the host-owned deadline.');
    this.name = 'PluginOperationTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function normalizePluginOperationTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_PLUGIN_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return 1;
  }
  return Math.min(value as number, MAX_PLUGIN_OPERATION_TIMEOUT_MS);
}

export async function runPluginOperationWithDeadline<T>(
  operation: () => T | PromiseLike<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PluginOperationTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
