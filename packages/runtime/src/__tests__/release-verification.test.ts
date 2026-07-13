import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  releaseKeyId,
  renderReleaseVerification,
  verifyReleaseArtifacts,
  type ProvenanceSignatureEnvelope,
} from '../release-verification.js';

interface FixtureManifest {
  schema: string;
  buildInfoSchema: string;
  version: string;
  commit: string;
  channel: string;
  target: string;
  archive: { file: string; sha256: string };
  sbom: { file: string; sha256: string };
  provenance: {
    file: string;
    sha256: string;
    signature: {
      status: string;
      reason?: string;
      file?: string;
      sha256?: string;
      algorithm?: string;
      keyId?: string;
    };
  };
}

describe('self-contained release verification', () => {
  let root: string;
  let manifestPath: string;
  let privateKey: string;
  let publicKey: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openslack-runtime-release-'));
    ({ privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }));
    manifestPath = createFixture(root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns stable trusted verification evidence for a signed release', () => {
    signFixture(root, manifestPath, privateKey, publicKey);
    const result = verifyReleaseArtifacts(manifestPath, {
      requireSignature: true,
      trustedPublicKey: publicKey,
    });
    expect(result).toMatchObject({
      schema: 'openslack.release_verification.v1',
      status: 'verified',
      verified: true,
      version: '0.1.0',
      commit: 'a'.repeat(40),
      channel: 'stable',
      target: 'linux-x64',
      signature: { status: 'signed', trusted: true },
    });
    expect(result.assets.map((asset) => asset.role)).toEqual([
      'archive',
      'sbom',
      'provenance',
      'signature',
    ]);
    expect(result.keyId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unsigned releases and signatures from another trust root', () => {
    expect(() =>
      verifyReleaseArtifacts(manifestPath, {
        requireSignature: true,
        trustedPublicKey: publicKey,
      }),
    ).toThrow('trusted provenance signature is required');

    signFixture(root, manifestPath, privateKey, publicKey);
    const other = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(() =>
      verifyReleaseArtifacts(manifestPath, {
        requireSignature: true,
        trustedPublicKey: other.publicKey,
      }),
    ).toThrow('untrusted release key');
  });

  it.each(['archive', 'sbom', 'provenance'] as const)('rejects a tampered %s asset', (role) => {
    signFixture(root, manifestPath, privateKey, publicKey);
    const manifest = readManifest(manifestPath);
    writeFileSync(join(root, manifest[role].file), 'tampered');
    expect(() =>
      verifyReleaseArtifacts(manifestPath, {
        requireSignature: true,
        trustedPublicKey: publicKey,
      }),
    ).toThrow('Release checksum mismatch');
  });

  it('rejects a tampered detached signature after its manifest hash is refreshed', () => {
    const signaturePath = signFixture(root, manifestPath, privateKey, publicKey);
    const envelope = JSON.parse(readFileSync(signaturePath, 'utf-8')) as {
      signature: string;
    };
    envelope.signature = Buffer.from('tampered-signature').toString('base64');
    writeFileSync(signaturePath, JSON.stringify(envelope));
    const manifest = readManifest(manifestPath);
    manifest.provenance.signature.sha256 = sha256File(signaturePath);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() =>
      verifyReleaseArtifacts(manifestPath, {
        requireSignature: true,
        trustedPublicKey: publicKey,
      }),
    ).toThrow('signature verification failed');
  });

  it.each(['version', 'commit', 'channel', 'target'] as const)(
    'rejects manifest %s metadata that differs from signed provenance',
    (field) => {
      signFixture(root, manifestPath, privateKey, publicKey);
      const manifest = readManifest(manifestPath) as unknown as Record<string, unknown>;
      manifest[field] =
        field === 'commit' ? 'b'.repeat(40) : field === 'target' ? 'windows-x64' : 'tampered';
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() =>
        verifyReleaseArtifacts(manifestPath, {
          requireSignature: true,
          trustedPublicKey: publicKey,
        }),
      ).toThrow(`build parameter does not match manifest: ${field}`);
    },
  );

  it('rejects unsafe, duplicate, and missing artifact references', () => {
    const manifest = readManifest(manifestPath);
    manifest.archive.file = '..\\openslack.tar.gz';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyReleaseArtifacts(manifestPath)).toThrow('unsafe or invalid');

    const duplicate = readManifest(createFixture(root));
    duplicate.sbom.file = duplicate.archive.file;
    writeFileSync(manifestPath, JSON.stringify(duplicate));
    expect(() => verifyReleaseArtifacts(manifestPath)).toThrow('duplicate or missing');

    const missing = readManifest(createFixture(root));
    unlinkSync(join(root, missing.archive.file));
    expect(() => verifyReleaseArtifacts(manifestPath)).toThrow('Release asset is missing');
  });

  it('does not project trusted public key content into plain or JSON output', () => {
    signFixture(root, manifestPath, privateKey, publicKey);
    const result = verifyReleaseArtifacts(manifestPath, {
      requireSignature: true,
      trustedPublicKey: publicKey,
    });
    for (const format of ['plain', 'json'] as const) {
      const output = renderReleaseVerification(result, format);
      expect(output).not.toContain(publicKey);
      expect(output).toContain(result.keyId!);
    }
  });
});

function createFixture(root: string): string {
  const archivePath = join(root, 'openslack-v0.1.0-linux-x64.tar.gz');
  const sbomPath = join(root, 'openslack-v0.1.0-linux-x64.sbom.cdx.json');
  const provenancePath = join(root, 'openslack-v0.1.0-linux-x64.provenance.intoto.json');
  writeFileSync(archivePath, 'archive');
  writeFileSync(sbomPath, '{"bomFormat":"CycloneDX"}');
  const identity = {
    version: '0.1.0',
    commit: 'a'.repeat(40),
    channel: 'stable',
    target: 'linux-x64',
  };
  writeFileSync(
    provenancePath,
    JSON.stringify({
      _type: 'https://in-toto.io/Statement/v1',
      predicateType: 'https://slsa.dev/provenance/v1',
      subject: [
        { name: 'openslack-v0.1.0-linux-x64.tar.gz', digest: { sha256: sha256File(archivePath) } },
        {
          name: 'openslack-v0.1.0-linux-x64.sbom.cdx.json',
          digest: { sha256: sha256File(sbomPath) },
        },
      ],
      predicate: { buildDefinition: { externalParameters: identity } },
    }),
  );
  const manifestPath = join(root, 'openslack-v0.1.0-linux-x64.release-manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: 'openslack.release_manifest.v1',
      buildInfoSchema: 'openslack.build_info.v1',
      ...identity,
      archive: { file: 'openslack-v0.1.0-linux-x64.tar.gz', sha256: sha256File(archivePath) },
      sbom: {
        file: 'openslack-v0.1.0-linux-x64.sbom.cdx.json',
        sha256: sha256File(sbomPath),
      },
      provenance: {
        file: 'openslack-v0.1.0-linux-x64.provenance.intoto.json',
        sha256: sha256File(provenancePath),
        signature: { status: 'unsigned', reason: 'operator-signing-not-configured' },
      },
    }),
  );
  return manifestPath;
}

function signFixture(
  root: string,
  manifestPath: string,
  privateKeyPem: string,
  publicKeyPem: string,
): string {
  const manifest = readManifest(manifestPath);
  const provenancePath = join(root, manifest.provenance.file);
  const payload = readFileSync(provenancePath);
  const publicKey = createPublicKey(publicKeyPem);
  const envelope: ProvenanceSignatureEnvelope = {
    schema: 'openslack.provenance_signature.v1',
    algorithm: 'ed25519',
    keyId: releaseKeyId(publicKey),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
    signature: sign(null, payload, createPrivateKey(privateKeyPem)).toString('base64'),
  };
  const signaturePath = `${provenancePath}.sig`;
  writeFileSync(signaturePath, JSON.stringify(envelope));
  manifest.provenance.signature = {
    status: 'signed',
    file: `${manifest.provenance.file}.sig`,
    sha256: sha256File(signaturePath),
    algorithm: 'ed25519',
    keyId: envelope.keyId,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return signaturePath;
}

function readManifest(path: string): FixtureManifest {
  return JSON.parse(readFileSync(path, 'utf-8')) as FixtureManifest;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
