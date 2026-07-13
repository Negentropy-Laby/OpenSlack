import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const RELEASE_MANIFEST_SCHEMA = 'openslack.release_manifest.v1';
const BUILD_INFO_SCHEMA = 'openslack.build_info.v1';
const PROVENANCE_SIGNATURE_SCHEMA = 'openslack.provenance_signature.v1';
const LEGACY_UNSIGNED_SIGNATURE_SENTINEL = 'operator-required';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const SAFE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Keep this fail-closed allowlist aligned with the hosted release build matrix
// in scripts/release/lib.ts. A new target is not trusted until both surfaces
// explicitly support it.
const SUPPORTED_RELEASE_TARGETS = new Set(['windows-x64', 'linux-x64']);

export interface ProvenanceSignatureEnvelope {
  schema: 'openslack.provenance_signature.v1';
  algorithm: 'ed25519';
  keyId: string;
  publicKey: string;
  payloadSha256: string;
  signature: string;
}

export interface VerifiedProvenanceSignature {
  keyId: string;
  trusted: boolean;
}

export interface VerifyReleaseArtifactsOptions {
  requireSignature?: boolean;
  trustedPublicKey?: string;
}

export type ReleaseVerificationAssetRole = 'archive' | 'sbom' | 'provenance' | 'signature';

export interface ReleaseVerificationAsset {
  role: ReleaseVerificationAssetRole;
  file: string;
  sha256: string;
}

export interface ReleaseVerificationResult {
  schema: 'openslack.release_verification.v1';
  status: 'verified';
  verified: true;
  version: string;
  commit: string;
  channel: string;
  target: string;
  keyId: string | null;
  signature: {
    status: 'signed' | 'unsigned';
    trusted: boolean;
  };
  assets: ReleaseVerificationAsset[];
}

interface ArtifactReference {
  file: string;
  sha256: string;
}

interface SignedProvenanceReference extends ArtifactReference {
  status: 'signed';
  algorithm: 'ed25519';
  keyId: string;
}

interface UnsignedProvenanceReference {
  status: 'unsigned';
  reason: string;
}

interface ReleaseManifest {
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
}

interface ProvenanceStatement {
  _type?: string;
  predicateType?: string;
  subject?: Array<{ name?: string; digest?: { sha256?: string } }>;
  predicate?: {
    buildDefinition?: {
      externalParameters?: Record<string, unknown>;
    };
  };
}

/**
 * Verify a release manifest and every referenced artifact from one directory.
 * Stable installed releases must call this with requireSignature and a trusted
 * out-of-band public key. The optional mode exists only for PR/development
 * release tooling that must inspect explicitly unsigned candidates.
 */
export function verifyReleaseArtifacts(
  manifestInput: string,
  options: VerifyReleaseArtifactsOptions = {},
): ReleaseVerificationResult {
  const manifestPath = resolve(manifestInput);
  const directory = dirname(manifestPath);
  const manifest = parseJsonFile<ReleaseManifest>(
    manifestPath,
    'Release manifest is invalid JSON.',
  );
  validateManifestIdentity(manifest);

  const baseReferences: Array<[ReleaseVerificationAssetRole, ArtifactReference]> = [
    ['archive', manifest.archive],
    ['sbom', manifest.sbom],
    ['provenance', manifest.provenance],
  ];
  assertUniqueArtifactNames(baseReferences.map(([, reference]) => reference));
  const archiveAsset = verifyArtifactReference(directory, 'archive', manifest.archive);
  const sbomAsset = verifyArtifactReference(directory, 'sbom', manifest.sbom);
  const verifiedProvenance = readVerifiedArtifactReference(
    directory,
    'provenance',
    manifest.provenance,
  );
  const assets = [archiveAsset, sbomAsset, verifiedProvenance.asset];
  const provenanceBytes = verifiedProvenance.bytes;
  const provenance = parseJsonBytes<ProvenanceStatement>(
    provenanceBytes,
    'Release provenance is invalid JSON.',
  );
  validateProvenanceSubjects(manifest, provenance);

  const signature = manifest.provenance.signature;
  if (signature && typeof signature === 'object' && signature.status === 'signed') {
    if (
      signature.algorithm !== 'ed25519' ||
      !SHA256_PATTERN.test(signature.keyId) ||
      baseReferences.some(([, reference]) => reference.file === signature.file)
    ) {
      throw new Error('Release manifest contains invalid provenance signature metadata.');
    }
    const verifiedSignature = readVerifiedArtifactReference(directory, 'signature', signature);
    const envelope = parseJsonBytes<ProvenanceSignatureEnvelope>(
      verifiedSignature.bytes,
      'Provenance signature envelope is invalid JSON.',
    );
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
    return {
      schema: 'openslack.release_verification.v1',
      status: 'verified',
      verified: true,
      version: manifest.version,
      commit: manifest.commit,
      channel: manifest.channel,
      target: manifest.target,
      keyId: verified.keyId,
      signature: { status: 'signed', trusted: verified.trusted },
      assets: [...assets, verifiedSignature.asset],
    };
  }

  if (signature && typeof signature === 'object' && signature.status === 'unsigned') {
    if (typeof signature.reason !== 'string' || signature.reason.trim().length === 0) {
      throw new Error('Release manifest contains invalid unsigned provenance metadata.');
    }
  } else if (signature !== undefined && signature !== LEGACY_UNSIGNED_SIGNATURE_SENTINEL) {
    throw new Error('Release manifest contains invalid provenance signature metadata.');
  }
  if (options.requireSignature) {
    throw new Error('A trusted provenance signature is required for this release.');
  }
  return {
    schema: 'openslack.release_verification.v1',
    status: 'verified',
    verified: true,
    version: manifest.version,
    commit: manifest.commit,
    channel: manifest.channel,
    target: manifest.target,
    keyId: null,
    signature: { status: 'unsigned', trusted: false },
    assets,
  };
}

export function renderReleaseVerification(
  result: ReleaseVerificationResult,
  format: 'plain' | 'json' = 'plain',
): string {
  if (format === 'json') return JSON.stringify(result, null, 2);
  const signature =
    result.signature.status === 'unsigned'
      ? 'unsigned development candidate'
      : result.signature.trusted
        ? `trusted Ed25519 signature ${result.keyId}`
        : `self-asserted Ed25519 signature ${result.keyId}`;
  return [
    `PASS: OpenSlack v${result.version} ${result.target} (${result.commit})`,
    `Channel: ${result.channel}`,
    `Signature: ${signature}`,
    `Assets: ${result.assets.map((asset) => `${asset.role}=${asset.file}`).join(', ')}`,
  ].join('\n');
}

export function verifyProvenanceSignature(
  payload: Buffer,
  envelope: ProvenanceSignatureEnvelope,
  trustedPublicKeyPem?: string,
  requireTrusted = false,
): VerifiedProvenanceSignature {
  if (
    !envelope ||
    envelope.schema !== PROVENANCE_SIGNATURE_SCHEMA ||
    envelope.algorithm !== 'ed25519' ||
    !SHA256_PATTERN.test(envelope.keyId) ||
    !SHA256_PATTERN.test(envelope.payloadSha256) ||
    envelope.payloadSha256 !== sha256(payload) ||
    !isCanonicalBase64(envelope.signature)
  ) {
    throw new Error('Provenance signature envelope is invalid.');
  }

  let embeddedPublicKey: KeyObject;
  try {
    embeddedPublicKey = createPublicKey(envelope.publicKey);
  } catch {
    throw new Error('Provenance signature public key is invalid.');
  }
  assertEd25519(embeddedPublicKey);
  if (releaseKeyId(embeddedPublicKey) !== envelope.keyId) {
    throw new Error('Provenance signature key id does not match its public key.');
  }

  let verificationKey = embeddedPublicKey;
  let trusted = false;
  if (trustedPublicKeyPem) {
    try {
      verificationKey = createPublicKey(trustedPublicKeyPem);
    } catch {
      throw new Error('Trusted release public key is invalid.');
    }
    assertEd25519(verificationKey);
    if (releaseKeyId(verificationKey) !== envelope.keyId) {
      throw new Error('Provenance signature was made by an untrusted release key.');
    }
    trusted = true;
  } else if (requireTrusted) {
    throw new Error('A trusted release public key is required for signature verification.');
  }

  if (!verify(null, payload, verificationKey, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('Provenance signature verification failed.');
  }
  return { keyId: envelope.keyId, trusted };
}

export function releaseKeyId(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

function validateManifestIdentity(manifest: ReleaseManifest): void {
  if (manifest.schema !== RELEASE_MANIFEST_SCHEMA) {
    throw new Error('Unsupported release manifest schema.');
  }
  if (manifest.buildInfoSchema !== BUILD_INFO_SCHEMA) {
    throw new Error('Unsupported executable build info schema.');
  }
  if (
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0 ||
    typeof manifest.commit !== 'string' ||
    !COMMIT_PATTERN.test(manifest.commit) ||
    typeof manifest.channel !== 'string' ||
    manifest.channel.length === 0 ||
    !SUPPORTED_RELEASE_TARGETS.has(manifest.target)
  ) {
    throw new Error('Release manifest identity metadata is invalid.');
  }
}

function validateProvenanceSubjects(
  manifest: ReleaseManifest,
  provenance: ProvenanceStatement,
): void {
  if (
    provenance._type !== 'https://in-toto.io/Statement/v1' ||
    provenance.predicateType !== 'https://slsa.dev/provenance/v1'
  ) {
    throw new Error('Release provenance statement is invalid.');
  }
  const archiveSubjects = provenance.subject?.filter(
    (subject) => subject.name === manifest.archive.file,
  );
  if (
    archiveSubjects?.length !== 1 ||
    archiveSubjects[0]?.digest?.sha256 !== manifest.archive.sha256
  ) {
    throw new Error('Provenance subject does not match the release archive.');
  }

  const signature = manifest.provenance.signature;
  const structuredSignature = signature && typeof signature === 'object';
  if (structuredSignature) {
    const sbomSubjects = provenance.subject?.filter(
      (subject) => subject.name === manifest.sbom.file,
    );
    if (sbomSubjects?.length !== 1 || sbomSubjects[0]?.digest?.sha256 !== manifest.sbom.sha256) {
      throw new Error('Provenance subject does not match the release SBOM.');
    }
  }
}

function validateSignedBuildParameters(
  manifest: ReleaseManifest,
  provenance: ProvenanceStatement,
): void {
  const parameters = provenance.predicate?.buildDefinition?.externalParameters;
  for (const field of ['version', 'commit', 'channel', 'target'] as const) {
    if (parameters?.[field] !== manifest[field]) {
      throw new Error(`Signed provenance build parameter does not match manifest: ${field}`);
    }
  }
}

function verifyArtifactReference(
  directory: string,
  role: ReleaseVerificationAssetRole,
  item: ArtifactReference,
): ReleaseVerificationAsset {
  return readVerifiedArtifactReference(directory, role, item).asset;
}

function readVerifiedArtifactReference(
  directory: string,
  role: ReleaseVerificationAssetRole,
  item: ArtifactReference,
): { asset: ReleaseVerificationAsset; bytes: Buffer } {
  if (
    !item ||
    typeof item.file !== 'string' ||
    !SAFE_ASSET_NAME_PATTERN.test(item.file) ||
    item.file.includes('/') ||
    item.file.includes('\\') ||
    typeof item.sha256 !== 'string' ||
    !SHA256_PATTERN.test(item.sha256)
  ) {
    throw new Error('Release manifest contains an unsafe or invalid artifact reference.');
  }
  const path = join(directory, item.file);
  if (!existsSync(path)) throw new Error(`Release asset is missing: ${item.file}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Release asset is not a regular file: ${item.file}`);
  }
  const bytes = readFileSync(path);
  if (sha256(bytes) !== item.sha256) {
    throw new Error(`Release checksum mismatch: ${item.file}`);
  }
  return { asset: { role, file: item.file, sha256: item.sha256 }, bytes };
}

function assertUniqueArtifactNames(references: ArtifactReference[]): void {
  const names = references.map((reference) => reference?.file);
  if (names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length) {
    throw new Error('Release manifest contains duplicate or missing artifact references.');
  }
}

function parseJsonFile<T>(path: string, message: string): T {
  if (!existsSync(path)) throw new Error('Release manifest or referenced asset is missing.');
  return parseJsonBytes<T>(readFileSync(path), message);
}

function parseJsonBytes<T>(bytes: Buffer, message: string): T {
  try {
    const value = JSON.parse(bytes.toString('utf-8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
    return value as T;
  } catch {
    throw new Error(message);
  }
}

function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'ed25519' || key.type !== 'public') {
    throw new Error('Release public key must be Ed25519.');
  }
}

function sha256(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}
