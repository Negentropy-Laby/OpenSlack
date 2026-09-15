import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Windows can retain executable handles after the child has exited. Use the
// same bounded filesystem retry policy for every disposable release directory.
export function removeReleaseTemporaryDirectory(directory: string): void {
  const maxRetries = process.platform === 'win32' ? 10 : 0;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt >= maxRetries ||
        !['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].includes(code ?? '')
      ) {
        throw error;
      }
      // Bun 1.3.11 on Windows ignores rmSync's maxRetries/retryDelay options.
      // Bound retries here so release builds get the same behavior as Node.
      Atomics.wait(waitBuffer, 0, 0, 100);
    }
  }
}

export function withReleaseTemporaryDirectory<T>(
  prefix: string,
  operation: (directory: string) => T,
): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  let failed = false;
  let operationError: unknown;
  try {
    return operation(directory);
  } catch (error) {
    failed = true;
    operationError = error;
    throw error;
  } finally {
    try {
      removeReleaseTemporaryDirectory(directory);
    } catch (cleanupError) {
      if (failed) {
        throw new AggregateError(
          [operationError, cleanupError],
          'Release verification and temporary directory cleanup failed.',
          { cause: operationError },
        );
      }
      throw cleanupError;
    }
  }
}
