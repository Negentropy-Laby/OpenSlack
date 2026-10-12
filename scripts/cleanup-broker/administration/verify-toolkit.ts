/** Bundle as verify-toolkit.mjs; no checkout, Git executable, credentials or network are required. */
import { verifyCleanupAdminToolkit } from '@openslack/pr';

function main(args: readonly string[]): void {
  const options = new Map<string, string>();
  const allowed = new Set(['--package', '--candidate', '--manifest-sha256']);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!,
      value = args[index + 1];
    if (!allowed.has(name) || options.has(name) || !value || value.startsWith('--')) {
      process.stderr.write(
        'ADMIN_TOOLKIT_INPUT_INVALID: use --package <absolute-dir> --candidate <head> --manifest-sha256 <external-SHA256SUMS-digest>.\n',
      );
      process.exitCode = 2;
      return;
    }
    options.set(name, value);
  }
  if (options.size !== allowed.size) {
    process.stderr.write('ADMIN_TOOLKIT_INPUT_INVALID: all three package bindings are required.\n');
    process.exitCode = 2;
    return;
  }
  const result = verifyCleanupAdminToolkit({
    packageDirectory: options.get('--package')!,
    candidateHead: options.get('--candidate')!,
    manifestSHA256: options.get('--manifest-sha256')!,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.valid) process.exitCode = 2;
}
main(process.argv.slice(2));
