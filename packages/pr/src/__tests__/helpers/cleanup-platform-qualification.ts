/** Collect the complete inventory; execute descriptor I/O only on its qualified OS. */
export const declareLinuxCleanupTests =
  process.platform === 'linux' || process.env.OPENSLACK_TEST_INVENTORY === 'collect';
