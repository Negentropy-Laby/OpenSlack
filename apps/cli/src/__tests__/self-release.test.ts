import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseVerificationResult } from '@openslack/runtime';
import { selfReleaseCommands } from '../commands/self-release.js';

const result: ReleaseVerificationResult = {
  schema: 'openslack.release_verification.v1',
  status: 'verified',
  verified: true,
  version: '0.1.0',
  commit: 'a'.repeat(40),
  channel: 'stable',
  target: 'linux-x64',
  keyId: 'b'.repeat(64),
  signature: { status: 'signed', trusted: true },
  assets: [
    { role: 'archive', file: 'openslack.tar.gz', sha256: 'c'.repeat(64) },
    { role: 'sbom', file: 'openslack.sbom.json', sha256: 'd'.repeat(64) },
    { role: 'provenance', file: 'openslack.provenance.json', sha256: 'e'.repeat(64) },
    { role: 'signature', file: 'openslack.provenance.json.sig', sha256: 'f'.repeat(64) },
  ],
};

describe('openslack self release verify', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['plain', 'json'] as const)(
    'requires a trusted signature and renders %s without public key material',
    async (format) => {
      const publicKeyCanary = 'trusted-public-key-content-canary';
      const verify = vi.fn(() => result);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await selfReleaseCommands({
        readTrustedPublicKey: () => publicKeyCanary,
        verify,
      }).parseAsync(
        [
          'node',
          'release',
          'verify',
          '--manifest',
          'release-manifest.json',
          '--trusted-public-key',
          'trusted-public.pem',
          '--format',
          format,
        ],
        { from: 'node' },
      );

      expect(verify).toHaveBeenCalledWith('release-manifest.json', {
        requireSignature: true,
        trustedPublicKey: publicKeyCanary,
      });
      const output = String(log.mock.calls[0]?.[0]);
      expect(output).not.toContain(publicKeyCanary);
      expect(output).toContain(format === 'json' ? 'openslack.release_verification.v1' : 'PASS:');
    },
  );

  it('replaces key read failures with a fixed non-leaking error', async () => {
    const keyReadCanary = 'key-read-error-canary';
    await expect(
      selfReleaseCommands({
        readTrustedPublicKey: () => {
          throw new Error(keyReadCanary);
        },
      }).parseAsync(
        [
          'node',
          'release',
          'verify',
          '--manifest',
          'release-manifest.json',
          '--trusted-public-key',
          'missing.pem',
        ],
        { from: 'node' },
      ),
    ).rejects.toThrow('Trusted release public key could not be read.');
  });
});
