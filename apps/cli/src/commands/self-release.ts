import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import { renderReleaseVerification, verifyReleaseArtifacts } from '@openslack/runtime';

interface SelfReleaseDependencies {
  readTrustedPublicKey?: (path: string) => string;
  verify?: typeof verifyReleaseArtifacts;
}

export function selfReleaseCommands(dependencies: SelfReleaseDependencies = {}): Command {
  const readTrustedPublicKey =
    dependencies.readTrustedPublicKey ?? ((path: string) => readFileSync(resolve(path), 'utf-8'));
  const verify = dependencies.verify ?? verifyReleaseArtifacts;
  const release = new Command('release').description('Verify OpenSlack release artifacts');

  release
    .command('verify')
    .description('Verify a signed release using an out-of-band trusted public key')
    .requiredOption('--manifest <path>', 'Path to the release manifest')
    .requiredOption('--trusted-public-key <path>', 'Path to the trusted Ed25519 public key')
    .addOption(
      new Option('--format <format>', 'Output format').choices(['plain', 'json']).default('plain'),
    )
    .action((options: { manifest: string; trustedPublicKey: string; format: 'plain' | 'json' }) => {
      let trustedPublicKey: string;
      try {
        trustedPublicKey = readTrustedPublicKey(options.trustedPublicKey);
      } catch {
        throw new Error('Trusted release public key could not be read.');
      }
      const result = verify(options.manifest, {
        requireSignature: true,
        trustedPublicKey,
      });
      console.log(renderReleaseVerification(result, options.format));
    });

  return release;
}
