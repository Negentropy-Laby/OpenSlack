import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Remove owned qualification state, tolerating briefly retained Windows handles. */
export async function removeTemporaryDirectory(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== 'win32' ||
        attempt === 10 ||
        !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')
      ) {
        throw error;
      }
      // Bun does not consistently honor fs.rm's maxRetries option on Windows.
      // Keep retries explicit and bounded; persistent cleanup failures still fail CI.
      await delay(100 * (attempt + 1));
    }
  }
}
