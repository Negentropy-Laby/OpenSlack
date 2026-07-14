# Install OpenSlack from a release archive

OpenSlack P0 reference artifacts are versioned archives for Windows x64 and
Linux x64. Each archive contains the compiled CLI, embedded workflow assets,
and the target OS keychain binding. Node.js, Bun, Aby, and Negentropy-Lab are
not runtime dependencies.

## Verify the download

Download the target archive together with its release manifest, CycloneDX SBOM,
provenance statement, detached provenance signature, and `SHA256SUMS`. Verify the
checksum before extraction. Stable tag releases are fail-closed unless every
target has a trusted Ed25519 provenance signature. PR and manual development
artifacts are explicitly marked `unsigned` in their manifest and must not be
treated as published releases.

Windows PowerShell:

```powershell
Get-FileHash .\openslack-v0.1.1-windows-x64.zip -Algorithm SHA256
```

Linux:

```bash
sha256sum openslack-v0.1.1-linux-x64.tar.gz
```

The result must equal both `SHA256SUMS` and the archive digest in the release
manifest. The signed provenance subjects bind both the archive and its SBOM.
Extract the downloaded CLI first, then use that installed executable to verify
the original archive and sidecars against the release public key obtained from
the organization's pinned, out-of-band trust channel. This command does not
require an OpenSlack source checkout, Bun, or Node.js:

```bash
openslack self release verify \
  --manifest openslack-v0.1.1-linux-x64.release-manifest.json \
  --trusted-public-key /trusted/path/openslack-release-public.pem \
  --format plain
```

Use `--format json` for the stable `openslack.release_verification.v1` result.
The command verifies the archive, SBOM, provenance, detached signature, key ID,
version, commit, channel, target, required provenance subjects, and the declared
container format (`ZIP` for Windows, gzip-compressed tar for Linux). It always
requires a trusted signature; unsigned PR/development candidates and archives
whose filename does not match their actual container are rejected.

The `.sig` envelope contains a public key for inspection, but that embedded key
is self-asserted and is not a substitute for the trusted public key. Signing
private keys are never stored in the repository, release bundle, logs, or
support evidence.

Published tag assets are immutable. Re-running a tag workflow is a no-op only
when the existing asset file set and every byte are identical; a missing, extra,
or different asset fails the workflow rather than replacing it.

## Extract and run

Keep the executable, `native/`, and `assets/` in the same installation directory.
Do not copy only the executable: native keychain support intentionally makes P0
a one-download archive, not a single physical file.

```text
openslack-v0.1.1-<target>/
├── openslack[.exe]
├── native/
├── assets/workflows/
├── build-info.json
├── smoke-report.json
└── LICENSES/
```

Add that directory to `PATH`, then verify the installed build:

```bash
openslack version --format json
openslack tui doctor
```

The version, commit, target, and schema compatibility must match
`build-info.json` and the release manifest.

## Initialize a repository

From an ordinary Git repository:

```bash
openslack init --repo <owner/repository>
openslack init --repo <owner/repository> --apply
openslack workspace validate
openslack setup onboarding --start
```

Continue with the guided onboarding ledger. Preview commands before apply
commands, store only `env:` or `keychain:` credential references, and keep bot PR
authorship separate from human approval.

When GitHub App setup writes `.openslack.local/github-app.json`, the installed
CLI resolves its `privateKeyRef` from the OS keychain for GitHub and delivery
commands. The config contains only App metadata and a credential reference; the
private key is not passed through argv or written to delivery evidence. Verify
the installation scope before the first mutation:

```bash
openslack github app bind-installation --installation-id <id>
openslack github app bind-installation --installation-id <id> --apply
openslack delivery doctor --repo <owner/repository> --require-issues-write
openslack delivery probe --repo <owner/repository>
```

## Linux keychain prerequisite

The Linux artifact contains the native Secret Service binding. A desktop session
normally provides a Secret Service implementation. Headless hosts must provide a
compatible D-Bus Secret Service before writable `keychain:` onboarding can pass;
OpenSlack does not fall back to an encrypted credential file.
