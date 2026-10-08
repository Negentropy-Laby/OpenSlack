import {
  CleanupHandoffError,
  prepareCleanupHandoffDraft,
  readCleanupHandoffInputFile,
} from '../../packages/pr/src/cleanup-handoff.js';
import type { PrepareCleanupHandoffDraftInput } from '../../packages/pr/src/cleanup-handoff.js';

// Explicit offline inputs only; never discovers credentials or writes an active installation.
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--input' || !args[1])
    throw new CleanupHandoffError('HANDOFF_INPUT_INVALID');
  const input = readCleanupHandoffInputFile(args[1]) as PrepareCleanupHandoffDraftInput;
  if (input.now !== undefined) throw new CleanupHandoffError('HANDOFF_INPUT_INVALID');
  process.stdout.write(JSON.stringify(prepareCleanupHandoffDraft(input), null, 2) + '\n');
} catch (error) {
  process.stderr.write(
    (error instanceof CleanupHandoffError
      ? error.message
      : 'HANDOFF_INPUT_INVALID: review the explicit non-secret input file.') + '\n',
  );
  process.exitCode = 2;
}
