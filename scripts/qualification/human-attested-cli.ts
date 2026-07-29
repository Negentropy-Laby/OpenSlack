import { parseArgs } from 'node:util';
import { QualificationError } from './common.js';
import {
  HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL,
  HUMAN_ATTESTED_QUALIFICATION_SCHEMA,
  runProductionHumanAttestedQualification,
} from './human-attested.js';

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    strict: true,
    options: {
      'human-principal': { type: 'string' },
      confirm: { type: 'boolean', default: false },
    },
  });
  if (
    parsed.values['human-principal'] !== HUMAN_ATTESTED_QUALIFICATION_PRINCIPAL ||
    parsed.values.confirm !== true
  ) {
    throw new QualificationError(
      'HUMAN_QUALIFICATION_ARGUMENT_INVALID',
      'Qualification requires --human-principal human:founder and --confirm.',
    );
  }
  const receipt = await runProductionHumanAttestedQualification({
    humanPrincipal: parsed.values['human-principal'],
    confirmed: true,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const code =
    error instanceof QualificationError ? error.code : 'HUMAN_ATTESTED_QUALIFICATION_FAILED';
  process.stderr.write(
    `${JSON.stringify({
      schema: HUMAN_ATTESTED_QUALIFICATION_SCHEMA,
      status: 'blocked',
      code,
    })}\n`,
  );
  process.exitCode = 1;
}
