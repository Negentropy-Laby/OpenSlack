import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hasArg, parseArg, sha256File } from './lib.js';
import { verifyProvenanceSignature, type ProvenanceSignatureEnvelope } from './signature.js';

export interface VerifyReleaseOptions {
  requireSignature?: boolean;
  trustedPublicKey?: string;
}

interface ArtifactReference {
  file: string;
  sha256: string;
}

interface SignedProvenanceReference {
  status: 'signed';
  file: string;
  sha256: string;
  algorithm: 'ed25519';
  keyId: string;
}

interface UnsignedProvenanceReference {
  status: 'unsigned';
  reason: string;
}

export function verifyRelease(manifestInput: string, options: VerifyReleaseOptions = {}): string {
  const manifestPath = resolve(manifestInput);
  const directory = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    schema: string;
    buildInfoSchema: string;
    version: string;
    commit: string;
    channel: string;
    target: string;
    archive: ArtifactReference;
    sbom: ArtifactReference;
    provenance: ArtifactReference & {
      signature?: SignedProvenanceReference | UnsignedProvenanceReference | string;
    };
  };
  if (manifest.schema !== 'openslack.release_manifest.v1') {
    throw new Error('Unsupported release manifest schema.');
  }
  if (manifest.buildInfoSchema !== 'openslack.build_info.v1') {
    throw new Error('Unsupported executable build info schema.');
  }
  for (const item of [manifest.archive, manifest.sbom, manifest.provenance]) {
    verifyArtifactReference(directory, item);
  }

  const provenancePath = join(directory, manifest.provenance.file);
  const provenanceBytes = readFileSync(provenancePath);
  const provenance = JSON.parse(provenanceBytes.toString('utf-8')) as {
    _type?: string;
    predicateType?: string;
    subject?: Array<{ name?: string; digest?: { sha256?: string } }>;
    predicate?: {
      buildDefinition?: {
        externalParameters?: Record<string, unknown>;
      };
    };
  };
  const archiveSubject = provenance.subject?.find(
    (subject) => subject.name === manifest.archive.file,
  );
  const sbomSubject = provenance.subject?.find((subject) => subject.name === manifest.sbom.file);
  const signature = manifest.provenance.signature;
  if (
    provenance._type !== 'https://in-toto.io/Statement/v1' ||
    provenance.predicateType !== 'https://slsa.dev/provenance/v1' ||
    archiveSubject?.digest?.sha256 !== manifest.archive.sha256
  ) {
    throw new Error('Provenance subject does not match the release archive.');
  }
  // Legacy unsigned v1 manifests covered only the archive. New manifests use a
  // structured signature status and must bind the SBOM even when the PR/dev
  // build is explicitly unsigned.
  if (
    signature &&
    typeof signature === 'object' &&
    sbomSubject?.digest?.sha256 !== manifest.sbom.sha256
  ) {
    throw new Error('Provenance subject does not match the release SBOM.');
  }

  let signatureStatus = 'UNSIGNED (allowed for PR/dev builds)';
  if (signature && typeof signature === 'object' && signature.status === 'signed') {
    verifyArtifactReference(directory, signature);
    if (signature.algorithm !== 'ed25519' || !/^[a-f0-9]{64}$/.test(signature.keyId)) {
      throw new Error('Release manifest contains invalid provenance signature metadata.');
    }
    const envelope = JSON.parse(
      readFileSync(join(directory, signature.file), 'utf-8'),
    ) as ProvenanceSignatureEnvelope;
    if (envelope.keyId !== signature.keyId || envelope.algorithm !== signature.algorithm) {
      throw new Error('Provenance signature metadata does not match its envelope.');
    }
    const verified = verifyProvenanceSignature(
      provenanceBytes,
      envelope,
      options.trustedPublicKey,
      options.requireSignature === true,
    );
    validateSignedBuildParameters(manifest, provenance);
    signatureStatus = verified.trusted
      ? `SIGNED/TRUSTED ${verified.keyId}`
      : `SIGNED/SELF-ASSERTED ${verified.keyId}`;
  } else if (signature && typeof signature === 'object' && signature.status === 'unsigned') {
    if (typeof signature.reason !== 'string' || signature.reason.length === 0) {
      throw new Error('Release manifest contains invalid unsigned provenance metadata.');
    }
    if (options.requireSignature) {
      throw new Error('A trusted provenance signature is required for this release.');
    }
  } else if (signature !== undefined && signature !== 'operator-required') {
    throw new Error('Release manifest contains invalid provenance signature metadata.');
  } else if (options.requireSignature) {
    throw new Error('A trusted provenance signature is required for this release.');
  }

  return `PASS: ${manifest.archive.file}, ${manifest.sbom.file}, and ${manifest.provenance.file} match the release manifest. Provenance: ${signatureStatus}.`;
}

function validateSignedBuildParameters(
  manifest: { version: string; commit: string; channel: string; target: string },
  provenance: {
    predicate?: { buildDefinition?: { externalParameters?: Record<string, unknown> } };
  },
): void {
  const parameters = provenance.predicate?.buildDefinition?.externalParameters;
  for (const field of ['version', 'commit', 'channel', 'target'] as const) {
    if (
      typeof manifest[field] !== 'string' ||
      manifest[field].length === 0 ||
      parameters?.[field] !== manifest[field]
    ) {
      throw new Error(`Signed provenance build parameter does not match manifest: ${field}`);
    }
  }
}

function verifyArtifactReference(directory: string, item: ArtifactReference): void {
  if (!item || item.file !== basename(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256)) {
    throw new Error('Release manifest contains an unsafe or invalid artifact reference.');
  }
  const path = join(directory, item.file);
  if (!existsSync(path) || sha256File(path) !== item.sha256) {
    throw new Error(`Release checksum mismatch: ${item.file}`);
  }
}

if (import.meta.main) {
  const manifestArg = parseArg('--manifest');
  if (!manifestArg) {
    throw new Error(
      'Usage: bun scripts/release/verify.ts --manifest <path> [--require-signature --public-key <path>|--public-key-env <name>]',
    );
  }
  const publicKeyPath = parseArg('--public-key');
  const publicKeyEnv = parseArg('--public-key-env');
  if (publicKeyPath && publicKeyEnv) {
    throw new Error('Use only one of --public-key or --public-key-env.');
  }
  const trustedPublicKey = publicKeyPath
    ? readFileSync(resolve(publicKeyPath), 'utf-8')
    : publicKeyEnv
      ? process.env[publicKeyEnv]
      : undefined;
  if (publicKeyEnv && !trustedPublicKey) {
    throw new Error(
      `Trusted release public key environment reference is unavailable: ${publicKeyEnv}`,
    );
  }
  console.log(
    verifyRelease(manifestArg, {
      requireSignature: hasArg('--require-signature'),
      trustedPublicKey,
    }),
  );
}
