import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

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

export interface ReleaseSigningEnvironment {
  privateKey?: string;
  trustedPublicKey?: string;
}

/**
 * Capture signing material once and remove it from the process environment
 * before the release builder starts any Git, compiler, archive, or smoke child.
 * The private key remains only in this local return value and is never forwarded
 * through the default child environment.
 */
export function consumeReleaseSigningEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ReleaseSigningEnvironment {
  const privateKey = env.OPENSLACK_RELEASE_SIGNING_PRIVATE_KEY;
  const trustedPublicKey = env.OPENSLACK_RELEASE_TRUSTED_PUBLIC_KEY;
  delete env.OPENSLACK_RELEASE_SIGNING_PRIVATE_KEY;
  delete env.OPENSLACK_RELEASE_TRUSTED_PUBLIC_KEY;
  return { privateKey, trustedPublicKey };
}

export function createProvenanceSignature(
  payload: Buffer,
  privateKeyPem: string,
  trustedPublicKeyPem: string,
): ProvenanceSignatureEnvelope {
  let privateKey: KeyObject;
  let trustedPublicKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
    trustedPublicKey = createPublicKey(trustedPublicKeyPem);
  } catch {
    throw new Error('Release signing key material is invalid.');
  }
  assertEd25519(privateKey, 'private');
  assertEd25519(trustedPublicKey, 'public');

  const derivedPublicKey = createPublicKey(privateKey);
  const derivedKeyId = releaseKeyId(derivedPublicKey);
  const trustedKeyId = releaseKeyId(trustedPublicKey);
  if (derivedKeyId !== trustedKeyId) {
    throw new Error('Release signing key does not match the configured trusted public key.');
  }

  return {
    schema: 'openslack.provenance_signature.v1',
    algorithm: 'ed25519',
    keyId: derivedKeyId,
    publicKey: exportPublicKey(derivedPublicKey),
    payloadSha256: sha256(payload),
    signature: sign(null, payload, privateKey).toString('base64'),
  };
}

export function verifyProvenanceSignature(
  payload: Buffer,
  envelope: ProvenanceSignatureEnvelope,
  trustedPublicKeyPem?: string,
  requireTrusted = false,
): VerifiedProvenanceSignature {
  if (
    !envelope ||
    envelope.schema !== 'openslack.provenance_signature.v1' ||
    envelope.algorithm !== 'ed25519' ||
    !/^[a-f0-9]{64}$/.test(envelope.keyId) ||
    !/^[a-f0-9]{64}$/.test(envelope.payloadSha256) ||
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
  assertEd25519(embeddedPublicKey, 'public');
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
    assertEd25519(verificationKey, 'public');
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

function assertEd25519(key: KeyObject, kind: 'private' | 'public'): void {
  if (key.asymmetricKeyType !== 'ed25519' || key.type !== kind) {
    throw new Error(`Release ${kind} key must be Ed25519.`);
  }
}

function exportPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
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
