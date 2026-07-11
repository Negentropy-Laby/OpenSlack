# Install OpenSlack from a release archive

OpenSlack P0 reference artifacts are versioned archives for Windows x64 and
Linux x64. Each archive contains the compiled CLI, embedded workflow assets,
and the target OS keychain binding. Node.js, Bun, Aby, and Negentropy-Lab are
not runtime dependencies.

## Verify the download

Download the target archive together with its release manifest, CycloneDX SBOM,
provenance statement, and `SHA256SUMS`. Verify the checksum before extraction.

Windows PowerShell:

```powershell
Get-FileHash .\openslack-v0.1.0-windows-x64.zip -Algorithm SHA256
```

Linux:

```bash
sha256sum openslack-v0.1.0-linux-x64.tar.gz
```

The result must equal both `SHA256SUMS` and the archive digest in the release
manifest. A release operator may additionally publish a signature or CI
attestation; signing keys are never stored in the repository or release bundle.

## Extract and run

Keep the executable, `native/`, and `assets/` in the same installation directory.
Do not copy only the executable: native keychain support intentionally makes P0
a one-download archive, not a single physical file.

```text
openslack-v0.1.0-<target>/
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

## Linux keychain prerequisite

The Linux artifact contains the native Secret Service binding. A desktop session
normally provides a Secret Service implementation. Headless hosts must provide a
compatible D-Bus Secret Service before writable `keychain:` onboarding can pass;
OpenSlack does not fall back to an encrypted credential file.
