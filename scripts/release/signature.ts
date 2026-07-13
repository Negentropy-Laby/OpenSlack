import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import {
  releaseKeyId,
  type ProvenanceSignatureEnvelope,
} from '../../packages/runtime/src/release-verification.js';

export {
  releaseKeyId,
  verifyProvenanceSignature,
} from '../../packages/runtime/src/release-verification.js';
export type {
  ProvenanceSignatureEnvelope,
  VerifiedProvenanceSignature,
} from '../../packages/runtime/src/release-verification.js';

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
