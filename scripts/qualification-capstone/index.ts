import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  QUALIFICATION_PROFILES,
  createQualificationPlan,
  recordQualificationStep,
  verifyQualification,
  type QualificationProfile,
  type QualificationStatus,
  type QualificationStep,
} from './lib.js';

const root = resolve(import.meta.dirname, '..', '..');
const command = process.argv[2];

if (command === 'plan') {
  process.stdout.write(
    `${JSON.stringify(createQualificationPlan({ workspaceRoot: root, testedCommit: option('--tested-commit') ?? gitHead(), ...(option('--correlation-id') ? { correlationId: option('--correlation-id') } : {}) }), null, 2)}\n`,
  );
} else if (command === 'record') {
  process.stdout.write(
    `${JSON.stringify(
      recordQualificationStep({
        workspaceRoot: root,
        correlationId: required('--correlation-id'),
        testedCommit: required('--tested-commit'),
        step: required('--step') as QualificationStep,
        status: required('--status') as QualificationStatus,
        environment: required('--environment'),
        evidenceRefs: repeated('--evidence-ref'),
        artifactPaths: repeated('--artifact'),
      }),
      null,
      2,
    )}\n`,
  );
} else if (command === 'verify') {
  const result = verifyQualification({
    workspaceRoot: root,
    correlationId: required('--correlation-id'),
    testedCommit: required('--tested-commit'),
    profiles: repeated('--profile') as QualificationProfile[],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
} else {
  throw new Error(
    `Usage: bun run qualification:capstone -- <plan|record|verify> ...\nProfiles: ${Object.keys(QUALIFICATION_PROFILES).join(', ')}`,
  );
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required option ${name}.`);
  return value;
}
function repeated(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1)
    if (process.argv[index] === name && process.argv[index + 1])
      values.push(process.argv[index + 1]!);
  return values;
}
function gitHead(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('Unable to resolve tested commit.');
  return result.stdout.trim();
}
