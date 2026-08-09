import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  PUBLIC_PACKAGES,
  PUBLIC_VERSION,
  assertExpectedTarballFiles,
  sha256Canonical,
  sha256File,
  writeJson,
  type CanonicalFileEntry,
} from './lib.js';

export interface QualificationPackage {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly tarballSha256: string;
  readonly manifestSha256: string;
}

export interface PublicQualificationManifest {
  readonly schema: 'openslack.public_package_qualification_set.v1';
  readonly testedCommit: string;
  readonly version: typeof PUBLIC_VERSION;
  readonly packages: readonly QualificationPackage[];
}

const COMMIT = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const EXPECTED_NAMES = PUBLIC_PACKAGES.map((item) => item.name).sort();
const EXPECTED_NAME_SET = new Set<string>(EXPECTED_NAMES);

export function createQualificationManifest(options: {
  readonly artifactReportPath: string;
  readonly testedCommit: string;
  readonly outputPath?: string;
}): PublicQualificationManifest {
  if (!COMMIT.test(options.testedCommit)) throw new Error('Tested commit must be a full SHA-1.');
  const report = exactRecord(readJsonBounded(options.artifactReportPath), [
    'schema',
    'version',
    'platform',
    'reproducibleCanonicalManifests',
    'cleanConsumer',
    'artifacts',
  ]);
  if (
    report.schema !== 'openslack.public_pack_verification.v1' ||
    report.version !== PUBLIC_VERSION ||
    typeof report.platform !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(report.platform) ||
    report.reproducibleCanonicalManifests !== true ||
    !report.cleanConsumer ||
    typeof report.cleanConsumer !== 'object' ||
    Array.isArray(report.cleanConsumer) ||
    !Array.isArray(report.artifacts)
  ) {
    throw new Error('Qualification requires a complete PASS report from bun run public:verify.');
  }
  const cleanConsumer = exactRecord(report.cleanConsumer, [
    'installedTarballs',
    'esmImports',
    'declarations',
    'typescriptConsumer',
    'isolatedPluginHosts',
  ]);
  const installedTarballs = Array.isArray(cleanConsumer.installedTarballs)
    ? cleanConsumer.installedTarballs
    : [];
  if (
    cleanConsumer.esmImports !== 'PASS' ||
    cleanConsumer.declarations !== 'PASS' ||
    cleanConsumer.typescriptConsumer !== 'PASS' ||
    cleanConsumer.isolatedPluginHosts !== 'PASS' ||
    installedTarballs.length !== EXPECTED_NAMES.length ||
    !installedTarballs.every((name) => typeof name === 'string') ||
    JSON.stringify([...installedTarballs].sort()) !== JSON.stringify(EXPECTED_NAMES)
  ) {
    throw new Error('Qualification requires a complete PASS report from bun run public:verify.');
  }
  const packages = report.artifacts
    .map((value) => parseArtifact(value, true))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (
    packages.length !== EXPECTED_NAMES.length ||
    JSON.stringify(packages.map((item) => item.name)) !== JSON.stringify(EXPECTED_NAMES)
  ) {
    throw new Error('Public pack artifact set is incomplete or contains duplicates.');
  }
  const manifest: PublicQualificationManifest = {
    schema: 'openslack.public_package_qualification_set.v1',
    testedCommit: options.testedCommit,
    version: PUBLIC_VERSION,
    packages,
  };
  if (options.outputPath) writeJson(options.outputPath, manifest);
  return manifest;
}

export function verifyQualificationManifest(options: {
  readonly manifestPath: string;
  readonly signaturePath: string;
  readonly publicKeyPath: string;
  readonly artifactRoot: string;
  readonly expectedCommit?: string;
}): PublicQualificationManifest {
  const manifestBytes = readBoundedRegular(options.manifestPath, 1024 * 1024);
  const manifest = parseManifest(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
  );
  if (options.expectedCommit && manifest.testedCommit !== options.expectedCommit) {
    throw new Error('Qualification manifest tested commit does not match.');
  }
  const signature = readBoundedRegular(options.signaturePath, 16 * 1024);
  const publicKeyBytes = readBoundedRegular(options.publicKeyPath, 64 * 1024);
  const publicKeyText = publicKeyBytes.toString('utf8');
  if (
    !publicKeyText.includes('-----BEGIN PUBLIC KEY-----') ||
    publicKeyText.includes('PRIVATE KEY')
  ) {
    throw new Error('Qualification key input must contain only an Ed25519 public key.');
  }
  const key = createPublicKey(publicKeyBytes);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Qualification key must be Ed25519.');
  if (!verifySignature(null, manifestBytes, key, signature)) {
    throw new Error('Qualification manifest signature is invalid.');
  }
  for (const item of manifest.packages) {
    const tarball = resolve(options.artifactRoot, item.tarball);
    if (basename(tarball) !== item.tarball || sha256File(tarball) !== item.tarballSha256) {
      throw new Error(`Qualification tarball hash mismatch for ${item.name}.`);
    }
  }
  return manifest;
}

function parseArtifact(value: unknown, includeFiles: boolean): QualificationPackage {
  const item = exactRecord(value, [
    'name',
    'version',
    'tarball',
    'tarballSha256',
    'manifestSha256',
    ...(includeFiles ? ['files'] : []),
  ]);
  const tarball = typeof item.tarball === 'string' ? basename(item.tarball) : '';
  const expectedTarball =
    typeof item.name === 'string'
      ? `openslack-${item.name.replace('@openslack/', '')}-${PUBLIC_VERSION}.tgz`
      : '';
  if (
    typeof item.name !== 'string' ||
    !EXPECTED_NAME_SET.has(item.name) ||
    item.version !== PUBLIC_VERSION ||
    tarball !== expectedTarball ||
    typeof item.tarballSha256 !== 'string' ||
    !HASH.test(item.tarballSha256) ||
    typeof item.manifestSha256 !== 'string' ||
    !HASH.test(item.manifestSha256)
  ) {
    throw new Error('Public pack artifact identity is invalid.');
  }
  if (includeFiles) {
    const files = parseCanonicalFiles(item.files);
    if (sha256Canonical(files) !== item.manifestSha256) {
      throw new Error(`Canonical package manifest hash mismatch for ${item.name}.`);
    }
  }
  return {
    name: item.name,
    version: PUBLIC_VERSION,
    tarball,
    tarballSha256: item.tarballSha256,
    manifestSha256: item.manifestSha256,
  };
}

function parseManifest(value: unknown): PublicQualificationManifest {
  const manifest = exactRecord(value, ['schema', 'testedCommit', 'version', 'packages']);
  if (
    manifest.schema !== 'openslack.public_package_qualification_set.v1' ||
    typeof manifest.testedCommit !== 'string' ||
    !COMMIT.test(manifest.testedCommit) ||
    manifest.version !== PUBLIC_VERSION ||
    !Array.isArray(manifest.packages)
  ) {
    throw new Error('Qualification manifest identity is invalid.');
  }
  const packages = manifest.packages.map((value) => parseArtifact(value, false));
  if (
    packages.length !== EXPECTED_NAMES.length ||
    JSON.stringify(packages.map((item) => item.name)) !== JSON.stringify(EXPECTED_NAMES)
  ) {
    throw new Error('Qualification package order or set is invalid.');
  }
  return {
    schema: 'openslack.public_package_qualification_set.v1',
    testedCommit: manifest.testedCommit,
    version: PUBLIC_VERSION,
    packages,
  };
}

function parseCanonicalFiles(value: unknown): readonly CanonicalFileEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Canonical package manifest must contain files.');
  }
  const files = value.map((raw) => {
    const file = exactRecord(raw, ['path', 'mode', 'size', 'sha256']);
    if (
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      file.path.length > 240 ||
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      file.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      (file.mode !== '0644' && file.mode !== '0755') ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 0 ||
      typeof file.sha256 !== 'string' ||
      !HASH.test(file.sha256)
    ) {
      throw new Error('Canonical package manifest file is invalid.');
    }
    return {
      path: file.path,
      mode: file.mode,
      size: Number(file.size),
      sha256: file.sha256,
    } satisfies CanonicalFileEntry;
  });
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.path.localeCompare(files[index]!.path, 'en') >= 0) {
      throw new Error('Canonical package manifest files must be unique and ordered.');
    }
  }
  assertExpectedTarballFiles(files);
  return files;
}

function readJsonBounded(path: string): unknown {
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(readBoundedRegular(path, 4 * 1024 * 1024)),
  );
}

function readBoundedRegular(path: string, limit: number): Buffer {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > limit) {
    throw new Error('Qualification input must be a bounded regular file.');
  }
  return readFileSync(absolute);
}

function exactRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Qualification manifest field must be an object.');
  }
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!allowed.includes(field)) throw new Error(`Unexpected qualification field: ${field}.`);
  }
  return record;
}
