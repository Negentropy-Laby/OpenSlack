import { describe } from 'vitest';

/** Collect the complete inventory; execute descriptor I/O only on its qualified OS. */
export const declareLinuxCleanupTests =
  process.platform === 'linux' || process.env.OPENSLACK_TEST_INVENTORY === 'collect';

/** Do not register an empty suite on a host that cannot execute its descriptor I/O. */
export function describeLinuxCleanup(name: string, run: () => void): void {
  if (declareLinuxCleanupTests) describe(name, run);
}
