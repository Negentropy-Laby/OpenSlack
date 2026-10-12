import { runCleanupQualificationFixtures as main } from '@openslack/pr/cleanup-administration-internal';

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error.code ?? 'FIXTURE_FAILED'}: preserve the batch and intent journal; no automatic retry or deletion.\n`,
  );
  process.exitCode = 2;
}
