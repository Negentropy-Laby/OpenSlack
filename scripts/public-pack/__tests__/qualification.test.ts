import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_PACKAGES, sha256File } from '../lib.js';
import { createQualificationManifest, verifyQualificationManifest } from '../qualification.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openslack-public-qualification-'));
  roots.push(root);
  const tarballs = join(root, 'tarballs');
  mkdirSync(tarballs);
  const artifacts = PUBLIC_PACKAGES.map((definition) => {
    const tarball = `openslack-${definition.name.replace('@openslack/', '')}-0.2.0.tgz`;
    const path = join(tarballs, tarball);
    writeFileSync(path, `${definition.name}\n`);
    return {
      name: definition.name,
      version: '0.2.0',
      tarball: `ignored/current/${tarball}`,
      tarballSha256: sha256File(path),
      manifestSha256: '1'.repeat(64),
      files: [],
    };
  });
  const report = join(root, 'report.json');
  writeFileSync(
    report,
    `${JSON.stringify({ schema: 'openslack.public_pack_verification.v1', version: '0.2.0', platform: 'test', artifacts })}\n`,
  );
  const manifestPath = join(root, 'manifest.json');
  createQualificationManifest({
    artifactReportPath: report,
    testedCommit: 'a'.repeat(40),
    outputPath: manifestPath,
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signaturePath = join(root, 'manifest.sig');
  const publicKeyPath = join(root, 'manifest.pub.pem');
  writeFileSync(signaturePath, sign(null, readFileSync(manifestPath), privateKey));
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  return { root, tarballs, manifestPath, signaturePath, publicKeyPath, privateKey };
}

describe('public package qualification set', () => {
  it('verifies an externally signed exact tarball set', () => {
    const value = fixture();
    expect(
      verifyQualificationManifest({ ...value, artifactRoot: value.tarballs }).testedCommit,
    ).toBe('a'.repeat(40));
  });

  it('rejects the wrong signature', () => {
    const value = fixture();
    writeFileSync(value.signaturePath, Buffer.alloc(64));
    expect(() => verifyQualificationManifest({ ...value, artifactRoot: value.tarballs })).toThrow(
      /signature is invalid/,
    );
  });

  it('rejects a private key supplied through the public-key input', () => {
    const value = fixture();
    writeFileSync(value.publicKeyPath, value.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(() => verifyQualificationManifest({ ...value, artifactRoot: value.tarballs })).toThrow(
      /only an Ed25519 public key/,
    );
  });

  it('rejects tarball drift and tested-commit drift', () => {
    const value = fixture();
    writeFileSync(join(value.tarballs, 'openslack-plugin-api-0.2.0.tgz'), 'changed\n');
    expect(() => verifyQualificationManifest({ ...value, artifactRoot: value.tarballs })).toThrow(
      /hash mismatch/,
    );
    const commitDrift = fixture();
    expect(() =>
      verifyQualificationManifest({
        ...commitDrift,
        artifactRoot: commitDrift.tarballs,
        expectedCommit: 'b'.repeat(40),
      }),
    ).toThrow(/tested commit/);
  });
});
