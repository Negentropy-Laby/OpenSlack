import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  LIVE_CAPSTONE_STEPS,
  createLiveCapstonePlan,
  recordLiveCapstoneStep,
  verifyLiveCapstone,
  type LiveCapstonePlatform,
  type LiveCapstoneStep,
  type LiveCapstoneStepStatus,
} from './lib.js';

const root = resolve(import.meta.dirname, '..', '..');
const command = process.argv[2];

if (command === 'plan') {
  const plan = createLiveCapstonePlan({
    workspaceRoot: root,
    testedCommit: option('--tested-commit') ?? gitHead(),
    ...(option('--correlation-id') === undefined
      ? {}
      : { correlationId: option('--correlation-id') }),
    ...(option('--credential-ref') === undefined
      ? {}
      : { credentialReference: option('--credential-ref') }),
    ...(option('--signed-artifact') === undefined
      ? {}
      : { signedArtifactPath: option('--signed-artifact') }),
    ...(option('--public-key') === undefined ? {} : { publicKeyPath: option('--public-key') }),
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} else if (command === 'record') {
  const run = recordLiveCapstoneStep({
    workspaceRoot: root,
    correlationId: required('--correlation-id'),
    testedCommit: required('--tested-commit'),
    platform: required('--platform') as LiveCapstonePlatform,
    step: required('--step') as LiveCapstoneStep,
    status: required('--status') as LiveCapstoneStepStatus,
    evidenceRefs: repeated('--evidence-ref'),
    artifactPaths: repeated('--artifact'),
  });
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
} else if (command === 'verify') {
  const verification = verifyLiveCapstone({
    workspaceRoot: root,
    correlationId: required('--correlation-id'),
    testedCommit: required('--tested-commit'),
  });
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  if (!verification.valid) process.exitCode = 1;
} else {
  throw new Error(
    [
      'Usage:',
      '  bun run live:capstone -- plan [--tested-commit <sha>] [--correlation-id <id>]',
      '  bun run live:capstone -- record --correlation-id <id> --tested-commit <sha>',
      '    --platform windows-x64|linux-x64 --step <step> --status PASS|FAIL',
      '  bun run live:capstone -- verify --correlation-id <id> --tested-commit <sha>',
      `Steps: ${LIVE_CAPSTONE_STEPS.join(', ')}`,
    ].join('\n'),
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
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  }
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
