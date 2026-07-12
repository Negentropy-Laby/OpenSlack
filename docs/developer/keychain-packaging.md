# Native keychain packaging decision

Status: **selected for the versioned Windows/Linux bundle; artifact verification
continues in the P0 release slice**.

OpenSlack uses `@napi-rs/keyring` 1.3.0 behind `NativeKeychainBackend`. The
dependency exposes a synchronous N-API binding over Windows Credential Manager
and Linux Secret Service and publishes platform packages for Windows x64/arm64
and Linux x64/arm64 GNU and musl. The version is pinned so release artifacts do
not silently change their native credential implementation.

## Decision matrix

| Candidate                    | Decision | Reason                                                                                                                                                                           |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@napi-rs/keyring`           | Selected | Maintained N-API binding, current prebuilt Windows/Linux artifacts, synchronous API matches the credential callback boundary.                                                    |
| `keytar`                     | Rejected | Its repository was archived in 2022; adopting an unmaintained native security dependency is not acceptable.                                                                      |
| `cross-keychain`             | Rejected | Its automatic backend chain includes encrypted-file and shell fallbacks. OpenSlack forbids an encrypted-file fallback in P0 and does not pass secrets through process arguments. |
| Product-owned encrypted file | Rejected | It creates an unsolved passphrase/key lifecycle and violates the P0 boundary.                                                                                                    |

Primary implementation sources:

- [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node)
- [archived `keytar`](https://github.com/atom/node-keytar)

## Runtime boundary

- `env:` remains the read-only CI/headless backend.
- `keychain:` uses the native OS store. Values are visible only inside
  `CredentialStore.withSecret` consumers.
- Native load or OS-service errors become fixed, redacted, fail-closed errors.
- A missing native binary does not crash module import; backend status reports
  unavailable and secret-dependent operations stop before external mutation.
- Create-only writes use an OpenSlack cross-process lock keyed by a SHA-256 hash
  of the canonical reference, then check-before-set while the lock is held.
- Lock files contain no reference or secret value and are removed in `finally`.
- There is no plaintext, encrypted-file, PowerShell, `secret-tool`, or Git
  credential-helper fallback.

## Release artifact contract

OpenSlack must be shipped as a versioned bundle, not claimed as a single
JavaScript file. The bundle must keep the selected platform `.node` artifact
adjacent to the package loader. The credentials test suite checks that the
pinned dependency advertises Windows x64 and Linux x64 GNU/musl artifacts and
loads the current platform binding without touching the real keychain.

P0 release validation must run the same import/type/test smoke in native Windows
and Linux artifact jobs. Linux operators also need an available Secret Service
and D-Bus session; headless environments without one must use `env:` references
and will remain fail-closed for writable keychain onboarding.
