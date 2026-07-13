import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  verifyReleaseArtifacts,
  type VerifyReleaseArtifactsOptions,
} from '../../packages/runtime/src/release-verification.js';
import { hasArg, parseArg } from './lib.js';

export type VerifyReleaseOptions = VerifyReleaseArtifactsOptions;

/**
 * Compatibility wrapper for PR/development release tooling. Installed stable
 * releases use `openslack self release verify`, which always requires a trusted
 * signature.
 */
export function verifyRelease(manifestInput: string, options: VerifyReleaseOptions = {}): string {
  const result = verifyReleaseArtifacts(manifestInput, options);
  const signatureStatus =
    result.signature.status === 'unsigned'
      ? 'UNSIGNED (allowed for PR/dev builds)'
      : result.signature.trusted
        ? `SIGNED/TRUSTED ${result.keyId}`
        : `SIGNED/SELF-ASSERTED ${result.keyId}`;
  const archive = result.assets.find((asset) => asset.role === 'archive')!;
  const sbom = result.assets.find((asset) => asset.role === 'sbom')!;
  const provenance = result.assets.find((asset) => asset.role === 'provenance')!;
  return `PASS: ${archive.file}, ${sbom.file}, and ${provenance.file} match the release manifest. Provenance: ${signatureStatus}.`;
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
