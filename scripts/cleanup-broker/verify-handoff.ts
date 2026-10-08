import { verifyCleanupHandoffPackage } from '../../packages/pr/src/cleanup-handoff.js';

// This entry is bundled with its offline package implementation and YAML parser.
// It has no checkout, node_modules, Git, auth or network dependency at verification time.
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index],
    value = args[index + 1];
  if (
    !name ||
    !['--package', '--candidate', '--manifest-sha256'].includes(name) ||
    !value ||
    options.has(name)
  ) {
    process.stderr.write(
      'HANDOFF_INPUT_INVALID: use --package <directory> --candidate <full SHA> --manifest-sha256 <reviewed SHA256>.\n',
    );
    process.exitCode = 2;
    break;
  }
  options.set(name, value);
}
if (!process.exitCode) {
  const result = verifyCleanupHandoffPackage({
    packageDirectory: options.get('--package') ?? '',
    candidateHead: options.get('--candidate') ?? '',
    manifestSHA256: options.get('--manifest-sha256') ?? '',
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.valid) process.exitCode = 2;
}
