/** Offline preparation only. This entry never installs, activates or authorizes a target. */
import {
  CleanupAdminToolkitError,
  prepareCleanupAdminToolkit,
  readCleanupAdminToolkitPreparationInput,
} from '../../../packages/pr/src/cleanup-admin-toolkit.js';

function main(args: readonly string[]): void {
  if (args.length !== 2 || args[0] !== '--input' || !args[1]) {
    process.stderr.write('ADMIN_TOOLKIT_INPUT_INVALID: use --input <absolute-recipe.json>.\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = prepareCleanupAdminToolkit(readCleanupAdminToolkitPreparationInput(args[1]));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof CleanupAdminToolkitError
      ? error.message : 'ADMIN_TOOLKIT_IO_FAILED: stop; preserve existing files.') + '\n');
    process.exitCode = 2;
  }
}
main(process.argv.slice(2));
