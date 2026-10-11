import {
  prepareCleanupEvidenceDraft,
  readCleanupEvidenceDraftInput,
} from '../../../packages/pr/src/cleanup-admin-evidence.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--input' || !args[1] || args[1].startsWith('--')) {
  process.stderr.write(
    'EVIDENCE_INPUT_INVALID: usage: prepare-evidence.mjs --input <strict JSON recipe>\n',
  );
  process.exitCode = 2;
} else {
  try {
    const result = prepareCleanupEvidenceDraft(readCleanupEvidenceDraftInput(args[1]));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.published && result.blockingIssues.length === 0 ? 0 : 2;
  } catch {
    process.stderr.write(
      'EVIDENCE_INPUT_INVALID: stop; preserve the original recipe and source evidence.\n',
    );
    process.exitCode = 2;
  }
}
