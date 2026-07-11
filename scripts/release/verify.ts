import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArg, sha256File } from './lib.js';

export function verifyRelease(manifestInput: string): string {
  const manifestPath = resolve(manifestInput);
  const directory = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    schema: string;
    buildInfoSchema: string;
    archive: { file: string; sha256: string };
    sbom: { file: string; sha256: string };
    provenance: { file: string; sha256: string };
  };
  if (manifest.schema !== 'openslack.release_manifest.v1') {
    throw new Error('Unsupported release manifest schema.');
  }
  if (manifest.buildInfoSchema !== 'openslack.build_info.v1') {
    throw new Error('Unsupported executable build info schema.');
  }
  for (const item of [manifest.archive, manifest.sbom, manifest.provenance]) {
    if (!item || item.file !== basename(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error('Release manifest contains an unsafe or invalid artifact reference.');
    }
    const path = join(directory, item.file);
    if (!existsSync(path) || sha256File(path) !== item.sha256) {
      throw new Error(`Release checksum mismatch: ${item.file}`);
    }
  }

  const provenance = JSON.parse(
    readFileSync(join(directory, manifest.provenance.file), 'utf-8'),
  ) as {
    _type?: string;
    predicateType?: string;
    subject?: Array<{ name?: string; digest?: { sha256?: string } }>;
  };
  const archiveSubject = provenance.subject?.find(
    (subject) => subject.name === manifest.archive.file,
  );
  if (
    provenance._type !== 'https://in-toto.io/Statement/v1' ||
    provenance.predicateType !== 'https://slsa.dev/provenance/v1' ||
    archiveSubject?.digest?.sha256 !== manifest.archive.sha256
  ) {
    throw new Error('Provenance subject does not match the release archive.');
  }

  return `PASS: ${manifest.archive.file}, ${manifest.sbom.file}, and ${manifest.provenance.file} match the release manifest.`;
}

if (import.meta.main) {
  const manifestArg = parseArg('--manifest');
  if (!manifestArg) throw new Error('Usage: bun scripts/release/verify.ts --manifest <path>');
  console.log(verifyRelease(manifestArg));
}
