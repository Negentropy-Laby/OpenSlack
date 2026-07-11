# Manual upgrade and rollback

P0 upgrades are explicit operator actions. `openslack update`, automatic service
restart, and automatic rollback are deferred to P1.

## Upgrade

1. Download and verify the new archive, manifest, SBOM, detached provenance
   signature, and checksum. Stable tag releases require a trusted Ed25519 public
   key; an `unsigned` PR/development manifest is not an upgrade artifact.
2. Run the new binary from its extracted version directory:

   ```bash
   openslack version --format json
   openslack setup state
   openslack setup migrate-state
   ```

3. Review every proposed state migration. Apply only after confirming the backup
   destination:

   ```bash
   openslack setup migrate-state --apply
   ```

4. Run `openslack workspace validate`, `openslack setup smoke`, and
   `openslack doctor` before switching the installation path or symlink.
5. Retain the previous version directory and state-migration backup until the new
   version completes the required workflows.

State migration is backup-first and fails closed if the source changes between
backup and publication. A future or corrupt schema is never silently rewritten.

## Rollback

1. Stop starting new OpenSlack work.
2. Restore the prior executable directory or installation symlink.
3. If the upgrade applied a state migration, preserve the failed/new state for
   audit, then restore the exact backup recorded by `migrate-state --apply`.
4. Run `openslack version --format json`, `openslack setup state`, and
   `openslack workspace validate`.
5. Resume work only after the prior version reports compatible state.

Do not copy credentials between machines or place private keys in an archive.
OS keychain entries remain owned by the operating-system credential service.

## Release operator signing

Tag publication requires two GitHub Actions secrets:

- `OPENSLACK_RELEASE_SIGNING_PRIVATE_KEY` — an offline-generated Ed25519 PKCS#8
  PEM private key;
- `OPENSLACK_RELEASE_TRUSTED_PUBLIC_KEY` — the matching Ed25519 SPKI PEM public
  key used to prevent signing with an unexpected key.

Provision and rotate the private key outside Git and outside the OpenSlack
workspace. Publish the public key fingerprint and public key through a pinned
organizational trust channel independent of the release assets. A tag build
fails before publication if either secret is absent, the keys do not match, or
any detached signature fails verification. Existing tag assets are never
overwritten; an identical rerun verifies and exits without uploading.
