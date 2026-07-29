import { parseArgs } from 'node:util';
import { QualificationError } from './common.js';
import {
  prepareQoderDesktopQualification,
  QODER_DESKTOP_VERIFICATION_SCHEMA,
  verifyQoderDesktopQualification,
} from './qoder-desktop.js';

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      format: { type: 'string', default: 'plain' },
      receipt: { type: 'string' },
    },
  });
  const [command] = parsed.positionals;
  if (parsed.positionals.length !== 1 || !['prepare', 'verify'].includes(command ?? '')) {
    throw new QualificationError(
      'QODER_QUALIFICATION_ARGUMENT_INVALID',
      'Expected prepare or verify.',
    );
  }
  if (!['plain', 'json'].includes(parsed.values.format ?? '')) {
    throw new QualificationError(
      'QODER_QUALIFICATION_ARGUMENT_INVALID',
      'Format must be plain or json.',
    );
  }
  if (command === 'prepare') {
    if (parsed.values.receipt !== undefined) {
      throw new QualificationError(
        'QODER_QUALIFICATION_ARGUMENT_INVALID',
        'prepare does not accept --receipt.',
      );
    }
    const result = await prepareQoderDesktopQualification();
    if (parsed.values.format === 'json') {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `Qualification: ${result.qualificationId}`,
          `Candidate: ${result.candidateCommit}`,
          `Qoder build: ${result.qoderBuild}`,
          `Connector config: ${result.connectorConfigPath}`,
          `Call plan: ${result.callPlanPath}`,
          `Receipt: ${result.receiptPath}`,
          `Stale graph instance: ${result.staleInstanceId}`,
          `Missing graph instance: ${result.missingInstanceId}`,
          '',
        ].join('\n'),
      );
    }
    return;
  }
  if (typeof parsed.values.receipt !== 'string') {
    throw new QualificationError(
      'QODER_QUALIFICATION_ARGUMENT_INVALID',
      'verify requires --receipt.',
    );
  }
  const result = verifyQoderDesktopQualification(parsed.values.receipt);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const code =
    error instanceof QualificationError ? error.code : 'QODER_DESKTOP_QUALIFICATION_FAILED';
  process.stderr.write(
    `${JSON.stringify({
      schema: QODER_DESKTOP_VERIFICATION_SCHEMA,
      status: 'blocked',
      code,
    })}\n`,
  );
  process.exitCode = 1;
}
