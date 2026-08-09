import { resolve } from 'node:path';
import { PUBLIC_VERSION } from './lib.js';
import { createQualificationManifest, verifyQualificationManifest } from './qualification.js';

const root = resolve(import.meta.dirname, '..', '..');
const command = process.argv[2];

if (command === 'manifest') {
  const manifest = createQualificationManifest({
    artifactReportPath:
      option('--artifact-report') ??
      resolve(root, '.openslack.local', 'public-pack', `v${PUBLIC_VERSION}`, 'verification.json'),
    testedCommit: required('--tested-commit'),
    outputPath:
      option('--output') ??
      resolve(root, '.openslack.local', 'public-pack', `v${PUBLIC_VERSION}`, 'qualification.json'),
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} else if (command === 'verify') {
  const manifest = verifyQualificationManifest({
    manifestPath: required('--manifest'),
    signaturePath: required('--signature'),
    publicKeyPath: required('--public-key'),
    artifactRoot: required('--artifact-root'),
    ...(option('--tested-commit') ? { expectedCommit: option('--tested-commit') } : {}),
  });
  process.stdout.write(
    `${JSON.stringify({ valid: true, testedCommit: manifest.testedCommit }, null, 2)}\n`,
  );
} else {
  throw new Error(
    'Usage: bun run public:qualify -- manifest --tested-commit <sha> [--artifact-report <path>] [--output <path>]\n' +
      '       bun run public:qualify -- verify --manifest <path> --signature <path> --public-key <path> --artifact-root <path> [--tested-commit <sha>]',
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
