import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProvenanceSignature } from '../signature.js';
import { verifyRelease } from '../verify.js';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('release manifest verification', () => {
  let root: string;
  let manifestPath: string;
  let privateKey: string;
  let publicKey: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openslack-release-verify-'));
    const archive = join(root, 'openslack.zip');
    const sbom = join(root, 'openslack.sbom.cdx.json');
    const provenance = join(root, 'openslack.provenance.intoto.json');
    writeFileSync(archive, 'archive');
    writeFileSync(sbom, '{"bomFormat":"CycloneDX"}');
    const archiveHash = sha256(archive);
    const sbomHash = sha256(sbom);
    writeFileSync(
      provenance,
      JSON.stringify({
        _type: 'https://in-toto.io/Statement/v1',
        predicateType: 'https://slsa.dev/provenance/v1',
        subject: [
          { name: 'openslack.zip', digest: { sha256: archiveHash } },
          { name: 'openslack.sbom.cdx.json', digest: { sha256: sbomHash } },
        ],
        predicate: {
          buildDefinition: {
            externalParameters: {
              version: '0.1.0',
              commit: 'a'.repeat(40),
              channel: 'test',
              target: 'windows-x64',
            },
          },
        },
      }),
    );
    const keys = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
    manifestPath = join(root, 'openslack.release-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 'openslack.release_manifest.v1',
        buildInfoSchema: 'openslack.build_info.v1',
        version: '0.1.0',
        commit: 'a'.repeat(40),
        channel: 'test',
        target: 'windows-x64',
        archive: { file: 'openslack.zip', sha256: archiveHash },
        sbom: { file: 'openslack.sbom.cdx.json', sha256: sbomHash },
        provenance: {
          file: 'openslack.provenance.intoto.json',
          sha256: sha256(provenance),
        },
      }),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('verifies all release subjects and digests', () => {
    expect(verifyRelease(manifestPath)).toContain('UNSIGNED');
  });

  it('keeps legacy unsigned archive-only provenance readable', () => {
    removeSbomSubjectAndRefresh(root, manifestPath);
    expect(verifyRelease(manifestPath)).toContain('UNSIGNED');
  });

  it('requires new structured unsigned provenance to bind the SBOM', () => {
    removeSbomSubjectAndRefresh(root, manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      provenance: Record<string, unknown>;
    };
    manifest.provenance.signature = {
      status: 'unsigned',
      reason: 'operator-signing-not-configured',
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyRelease(manifestPath)).toThrow(
      'Provenance subject does not match the release SBOM',
    );
  });

  it('requires a trusted provenance signature when requested', () => {
    expect(() => verifyRelease(manifestPath, { requireSignature: true })).toThrow(
      'trusted provenance signature is required',
    );
  });

  it('verifies an Ed25519 provenance signature against a trusted fixture key', () => {
    signFixtureProvenance(root, manifestPath, privateKey, publicKey);
    expect(
      verifyRelease(manifestPath, { requireSignature: true, trustedPublicKey: publicKey }),
    ).toContain('SIGNED/TRUSTED');
  });

  it('rejects a signature made by a different release key', () => {
    signFixtureProvenance(root, manifestPath, privateKey, publicKey);
    const other = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(() =>
      verifyRelease(manifestPath, {
        requireSignature: true,
        trustedPublicKey: other.publicKey,
      }),
    ).toThrow('untrusted release key');
  });

  it('rejects a tampered detached provenance signature', () => {
    const signaturePath = signFixtureProvenance(root, manifestPath, privateKey, publicKey);
    const envelope = JSON.parse(readFileSync(signaturePath, 'utf-8')) as {
      signature: string;
    };
    envelope.signature = Buffer.from('tampered-signature').toString('base64');
    writeFileSync(signaturePath, JSON.stringify(envelope));
    refreshSignatureHash(manifestPath, signaturePath);
    expect(() =>
      verifyRelease(manifestPath, { requireSignature: true, trustedPublicKey: publicKey }),
    ).toThrow('signature verification failed');
  });

  it.each(['version', 'commit', 'channel', 'target'] as const)(
    'rejects unsigned manifest %s metadata that differs from signed provenance',
    (field) => {
      signFixtureProvenance(root, manifestPath, privateKey, publicKey);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      manifest[field] = 'tampered';
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() =>
        verifyRelease(manifestPath, { requireSignature: true, trustedPublicKey: publicKey }),
      ).toThrow(`build parameter does not match manifest: ${field}`);
    },
  );

  it('rejects a tampered release component', () => {
    writeFileSync(join(root, 'openslack.sbom.cdx.json'), 'tampered');
    expect(() => verifyRelease(manifestPath)).toThrow('Release checksum mismatch');
  });

  it('rejects path traversal in artifact references', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      archive: { file: string };
    };
    manifest.archive.file = '../openslack.zip';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyRelease(manifestPath)).toThrow('unsafe or invalid artifact reference');
  });

  it('rejects provenance for a different archive digest', () => {
    const provenancePath = join(root, 'openslack.provenance.intoto.json');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf-8')) as {
      subject: Array<{ digest: { sha256: string } }>;
    };
    provenance.subject[0].digest.sha256 = '0'.repeat(64);
    writeFileSync(provenancePath, JSON.stringify(provenance));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      provenance: { sha256: string };
    };
    manifest.provenance.sha256 = sha256(provenancePath);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyRelease(manifestPath)).toThrow(
      'Provenance subject does not match the release archive',
    );
  });
});

function signFixtureProvenance(
  root: string,
  manifestPath: string,
  privateKey: string,
  publicKey: string,
): string {
  const provenancePath = join(root, 'openslack.provenance.intoto.json');
  const signaturePath = `${provenancePath}.sig`;
  const envelope = createProvenanceSignature(readFileSync(provenancePath), privateKey, publicKey);
  writeFileSync(signaturePath, JSON.stringify(envelope));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    provenance: Record<string, unknown>;
  };
  manifest.provenance.signature = {
    status: 'signed',
    file: 'openslack.provenance.intoto.json.sig',
    sha256: sha256(signaturePath),
    algorithm: 'ed25519',
    keyId: envelope.keyId,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return signaturePath;
}

function refreshSignatureHash(manifestPath: string, signaturePath: string): void {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    provenance: { signature: { sha256: string } };
  };
  manifest.provenance.signature.sha256 = sha256(signaturePath);
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

function removeSbomSubjectAndRefresh(root: string, manifestPath: string): void {
  const provenancePath = join(root, 'openslack.provenance.intoto.json');
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf-8')) as {
    subject: Array<{ name: string }>;
  };
  provenance.subject = provenance.subject.filter(
    (subject) => subject.name !== 'openslack.sbom.cdx.json',
  );
  writeFileSync(provenancePath, JSON.stringify(provenance));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    provenance: { sha256: string };
  };
  manifest.provenance.sha256 = sha256(provenancePath);
  writeFileSync(manifestPath, JSON.stringify(manifest));
}
