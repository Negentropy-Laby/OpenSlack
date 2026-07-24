# OpenSlack 0.2.0 Release Runbook

This runbook executes the external release and live-verification gates for the
already implemented OpenSlack 0.2.0 release path. It does not redesign the
release workflow, package boundary, blocker taxonomy, capstone, or governance
model.

The code and automation are complete at the audited baseline. A release is not
complete, however, until the operator-owned GitHub, npm, provider, clean-machine,
human-approval, and evidence-promotion gates below have passed.

Related guidance:

- [Live capstone harness](live-capstone.md)
- [Public npm publishing](npm-publishing.md)
- [npm rollback and recovery](npm-rollback.md)
- [Install from a release archive](../guides/install-openslack.md)
- [Manual upgrade and rollback](../guides/manual-upgrade-rollback.md)
- [Module maturity and evidence](module-maturity.md)
- [GitHub automation](github-automation.md)
- [Human approval](../security/human-approval.md)

## 0. Scope, roles, and hard boundaries

The run uses four roles. One person may hold more than one operator role, but a
human approver must be authorized and must not be the capstone PR author.

| Role                      | Responsibility                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Release operator          | Select the release head, create the owner-controlled tag, dispatch npm bootstrap, and enforce STOP/GO gates.             |
| Platform operator         | Execute the clean Windows or Linux checks and return only redacted observations and public-artifact hashes.              |
| Evidence recorder         | Own the one canonical capstone ledger and record both platforms into it.                                                 |
| Authorized human reviewer | Make and record the current-head GitHub approval decision. Bot, app, and agent identities are not valid human approvers. |

Agents may perform read-only inspection, prepare commands and evidence files,
create bot-authored PRs, diagnose PRs, and merge only after all constitutional
gates pass. Agents must not originate or submit an approval decision.

These operations remain operator-owned:

- provisioning or rotating signing material;
- accepting GitHub App permissions and event subscriptions;
- supplying npm, GitHub App, webhook, or model-provider credentials;
- dispatching live publication;
- executing clean-machine tests;
- approving the capstone or promotion PR as a human.

Never place a credential value, private key, webhook secret, provider token, or
secret-bearing response body in:

- a command line or shell history;
- a screenshot, copied terminal log, or PR body;
- a capstone evidence reference;
- `.openslack/modules.yaml`, `docs/status/current.md`, or live-evidence JSON;
- the release operator checklist.

Commands below accept only an opaque credential reference using the schemes
documented for that command: Agent Runtime accepts `env:` or `keychain:`, while
the live-capstone planner accepts `credential:` or `keychain:`. Secret
availability is proved by redacted diagnostics, not by printing, reading,
copying, hashing, or summarizing the value.

## 1. Release identity and freeze

Define the release identity once. Use full lowercase 40-character commit SHAs
in comparisons and evidence; short SHAs are display-only.

### Bash

```bash
export RELEASE_VERSION="0.2.0"
export RELEASE_TAG="v0.2.0"
export RELEASE_DATE="<YYYY-MM-DD>"
export CAPSTONE_ID="CAP-<YYYYMMDD>-<8-TO-64-UPPERCASE-OR-DIGIT-CHARS>"
export TESTED_COMMIT="$(git rev-parse HEAD)"
```

### PowerShell

```powershell
$env:RELEASE_VERSION = "0.2.0"
$env:RELEASE_TAG = "v0.2.0"
$env:RELEASE_DATE = "<YYYY-MM-DD>"
$env:CAPSTONE_ID = "CAP-<YYYYMMDD>-<8-TO-64-UPPERCASE-OR-DIGIT-CHARS>"
$env:TESTED_COMMIT = (git rev-parse HEAD).Trim()
```

`CAPSTONE_ID` must match `CAP-[A-Z0-9][A-Z0-9-]{7,63}`. The evidence recorder
creates it exactly once.

The plan-audit SHA
`e2eb615d37fe5e2861d6e90e6382ee6c34ff3ede` is not automatically the release
commit. Select `TESTED_COMMIT` only after the release runbook, npm recovery
runbook, changelog, public-package metadata, and any final release-date PR have
merged.

After selection, freeze `main` through the live-evidence promotion PR:

- `main`, `origin/main`, the tag target, the release workflow `headSha`, and the
  npm workflow `headSha` must all equal `TESTED_COMMIT`;
- no product, package, workflow, policy, or ordinary documentation change may
  merge;
- only these paths may differ from `TESTED_COMMIT`:

  ```text
  .openslack/evidence/live/*.json
  .openslack/modules.yaml
  docs/status/current.md
  ```

Any other change makes live evidence stale. Start a new capstone against the
new commit.

## 2. Release-head preflight

Every numbered gate is fail-closed. Record its result, timestamp, responsible
role, and redacted URL/hash in a temporary operator-owned checklist outside the
repository.

### Gate P1 — exact clean `main`

Fetch the current branch and tags, then select the release head.

#### Bash

```bash
git fetch origin main --tags --prune
git switch main
git pull --ff-only origin main
test -z "$(git status --porcelain=v1)"
export TESTED_COMMIT="$(git rev-parse HEAD)"
test "$TESTED_COMMIT" = "$(git rev-parse origin/main)"
test "$(printf '%s' "$TESTED_COMMIT" | wc -c | tr -d ' ')" = "40"
```

#### PowerShell

```powershell
git fetch origin main --tags --prune
git switch main
git pull --ff-only origin main
if (git status --porcelain=v1) { throw "STOP: worktree is not clean" }
$env:TESTED_COMMIT = (git rev-parse HEAD).Trim()
if ($env:TESTED_COMMIT -ne (git rev-parse origin/main).Trim()) {
  throw "STOP: main and origin/main differ"
}
if ($env:TESTED_COMMIT -notmatch '^[a-f0-9]{40}$') {
  throw "STOP: TESTED_COMMIT is not a full lowercase SHA"
}
```

**GO:** the worktree is clean and all three revisions are identical.

**STOP:** a pull is not fast-forward, any tracked/untracked content exists, or
the SHA is not a full lowercase SHA.

### Gate P2 — versions and finalized changelog

The root and all four public packages must be exactly `0.2.0`.

#### Bash

```bash
node -e 'const fs=require("node:fs"); const files=["package.json","packages/plugin-api/package.json","packages/plugin-host/package.json","packages/sdk/package.json","packages/plugin-testkit/package.json"]; for (const file of files) { const value=JSON.parse(fs.readFileSync(file,"utf8")).version; if (value!=="0.2.0") throw new Error(`${file}: ${value}`); console.log(`${file}: ${value}`) }'
grep -F "## [0.2.0] - $RELEASE_DATE" CHANGELOG.md
if grep -F "YYYY-MM-DD" CHANGELOG.md; then exit 1; fi
```

#### PowerShell

```powershell
$manifests = @(
  "package.json",
  "packages/plugin-api/package.json",
  "packages/plugin-host/package.json",
  "packages/sdk/package.json",
  "packages/plugin-testkit/package.json"
)
foreach ($manifest in $manifests) {
  $version = (Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).version
  if ($version -ne $env:RELEASE_VERSION) {
    throw "STOP: $manifest has version $version"
  }
}
if (-not (Select-String -LiteralPath CHANGELOG.md -SimpleMatch "## [0.2.0] - $env:RELEASE_DATE")) {
  throw "STOP: finalized changelog date is absent"
}
if (Select-String -LiteralPath CHANGELOG.md -SimpleMatch "YYYY-MM-DD") {
  throw "STOP: changelog still contains a date placeholder"
}
```

**GO:** all five manifests and the changelog agree.

**STOP:** do not edit `main` at tag time. Merge a bot-authored, human-approved
changelog-only PR, rerun all preflight checks, and select the new head as
`TESTED_COMMIT`.

### Gate P3 — tag and GitHub Release collision

First prove GitHub access without displaying credential material:

```bash
gh auth status
gh repo view --json nameWithOwner,url
```

For a fresh release, both the tag and GitHub Release must be absent:

```bash
git show-ref --verify "refs/tags/$RELEASE_TAG"
gh release view "$RELEASE_TAG" --json tagName,isDraft,isPrerelease,assets,url
```

Both commands are expected to report absence for a fresh release. Do not treat
an authentication, transport, rate-limit, or repository-selection error as
absence.

For an interrupted retry, an existing tag is allowed only when:

```bash
test "$(git rev-list -n 1 "$RELEASE_TAG")" = "$TESTED_COMMIT"
```

PowerShell equivalent:

```powershell
if ((git rev-list -n 1 $env:RELEASE_TAG).Trim() -ne $env:TESTED_COMMIT) {
  throw "STOP: existing tag points at different source"
}
```

If a GitHub Release already exists, its tag must resolve to `TESTED_COMMIT`.
The tag workflow will accept existing assets only when the complete published
file set is byte-identical to its candidate.

**GO:** both objects are absent, or the existing objects are the exact immutable
retry of this release identity.

**STOP:** never move/delete an exposed tag to reuse `v0.2.0`, and never replace
an existing release asset. A source fix requires a governed new version,
normally `0.2.1`.

### Gate P4 — npm registry absence

Bootstrap is valid only when all four versions are absent. A sequential partial
publish is not an absent release and is handled by the recovery gate in Phase
B1.

Check registry connectivity first:

```bash
npm ping --registry=https://registry.npmjs.org
```

#### Bash

```bash
for package in plugin-api plugin-host sdk plugin-testkit; do
  output="$(mktemp)"
  if npm view "@openslack/${package}@${RELEASE_VERSION}" version \
    --registry=https://registry.npmjs.org >"$output" 2>&1; then
    cat "$output"
    rm -f "$output"
    echo "STOP: @openslack/${package}@${RELEASE_VERSION} already exists" >&2
    exit 1
  fi
  if ! grep -q "E404" "$output"; then
    cat "$output"
    rm -f "$output"
    echo "STOP: registry lookup failed for @openslack/${package}" >&2
    exit 1
  fi
  rm -f "$output"
done
```

#### PowerShell

```powershell
foreach ($package in @("plugin-api", "plugin-host", "sdk", "plugin-testkit")) {
  $output = npm view "@openslack/$package@$env:RELEASE_VERSION" version `
    --registry=https://registry.npmjs.org 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    throw "STOP: @openslack/$package@$env:RELEASE_VERSION already exists"
  }
  if (($output -join "`n") -notmatch "E404") {
    throw "STOP: registry lookup failed for @openslack/$package"
  }
}
```

**GO:** npm is reachable and every exact version returns a genuine `E404`.

**STOP:** any version exists or any lookup is inconclusive.

### Gate P5 — external environments and named trust inputs

Identify, without exposing values:

- one isolated Windows x64 machine;
- one isolated Linux x64 machine;
- one trusted evidence-recorder host with a clean source checkout at
  `TESTED_COMMIT`;
- the out-of-band trusted release public-key location;
- the GitHub App installation and accepted repository scope;
- the provider endpoint/model and an opaque credential reference;
- the protected `npm-production` environment;
- the temporary, four-package-scoped bootstrap token name;
- the authorized non-author human reviewer.

Secret-name/readiness checks may list names only:

```bash
gh secret list --repo Negentropy-Laby/OpenSlack
gh secret list --repo Negentropy-Laby/OpenSlack --env npm-production
```

Require the expected signing secret names and `NPM_BOOTSTRAP_TOKEN` name, but do
not retrieve their values. Require the bootstrap token to expire within 24
hours and be scoped only to the four public packages.

Run read-only GitHub and provider diagnostics in the designated disposable
repository:

```bash
openslack setup github
openslack github doctor
openslack agent-runtime doctor --provider openai-compatible --format json
```

The provider may still be `not_configured` before Phase A2; that is a known STOP
for provider smoke, not permission to skip configuration.

**GO:** both platform operators, recorder, trust inputs, App owner, npm
maintainer, provider operator, and human reviewer are assigned.

**STOP:** do not improvise a credential transport or substitute a human OAuth
identity for bot delivery.

### Gate P6 — full release-head validation

Gate P6 produces the four tarball hashes that Phase B1 later compares
byte-for-byte with the registry packages. Its public-pack toolchain must
therefore match `.github/workflows/npm-stage-publish.yml` exactly:

```text
Node 22.14.0
npm 11.15.0
Bun 1.3.14
```

Verify the versions before generating P6 artifacts.

#### Bash

```bash
set -euo pipefail
test "$(node --version)" = "v22.14.0"
test "$(npm --version)" = "11.15.0"
test "$(bun --version)" = "1.3.14"
```

#### PowerShell

```powershell
if ((node --version).Trim() -ne "v22.14.0") {
  throw "STOP: P6 Node version does not match npm-stage-publish.yml"
}
if ((npm --version).Trim() -ne "11.15.0") {
  throw "STOP: P6 npm version does not match npm-stage-publish.yml"
}
if ((bun --version).Trim() -ne "1.3.14") {
  throw "STOP: P6 Bun version does not match npm-stage-publish.yml"
}
```

Run from the clean source checkout:

```bash
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun run test
bun run build
bun run public:verify
bun run openslack workspace validate
bun run openslack self eval --suite golden
bun run openslack status generate
git diff --exit-code -- docs/status/current.md
bun run openslack status verify
bash scripts/genesis-validate.sh
git status --short
```

Known failures receive no waiver at this gate. Treat the exact candidate head
and the repository-wide command output as authoritative rather than carrying
forward a historical drift list. Any `bun run format:check` failure is a
release-head **STOP**. Repair it through a separately scoped governed PR, rerun
the complete suite on the merged head, and only then select `TESTED_COMMIT`. Do
not combine agent identity, registry, prompt, constitutional, generated-status,
and ordinary package formatting into one mechanical change; each protected
boundary keeps its own authority and review requirements. A targeted check of
this runbook or one repaired file is useful authoring evidence but is not a
substitute for the repository-wide gate.

On Windows, use Git for Windows Bash when `bash` resolves to the WSL launcher:

```powershell
& "C:\Program Files\Git\bin\bash.exe" scripts/genesis-validate.sh
```

Inspect
`.openslack.local/public-pack/v0.2.0/verification.json`. Require:

- schema `openslack.public_pack_verification.v1`;
- version `0.2.0`;
- `reproducibleCanonicalManifests: true`;
- all four package names under `cleanConsumer.installedTarballs`;
- `esmImports`, `declarations`, `typescriptConsumer`, and
  `isolatedPluginHosts` all `PASS`;
- four artifact records with `tarballSha256`, `manifestSha256`, and bounded file
  lists.

Retain the report hash, four tarball hashes, and exact Node/npm/Bun versions in
the external operator checklist. Do not accept hashes produced by a different
toolchain, and do not commit `.openslack.local/**`. The tag archive workflow's
separately pinned toolchain and PR build-smoke do not replace this public-pack
identity check.

**GO:** every command exits zero, generated status has no diff, and final
`git status --short` is empty.

**STOP:** any failure or unintended generated source change. Fix through a PR,
then restart preflight and select a new `TESTED_COMMIT`.

## 3. Recording protocol

The evidence recorder creates the one canonical ledger in Phase A3, after the
signed public release manifest exists. No `record` command may run before that
entry gate.

The capstone has exactly eleven fixed steps:

| #   | Step ID                      | Required observation                                                                    |
| --- | ---------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `release_artifacts`          | `v0.2.0` archive, SBOM, provenance, detached signature, trusted public-key verification |
| 2   | `clean_machine_archive`      | clean archive verification and launch                                                   |
| 3   | `guided_attach`              | preview-first transactional attach                                                      |
| 4   | `github_app_readiness`       | accepted permissions, events, and repository scope                                      |
| 5   | `openai_compatible_provider` | configuration, ready doctor, and governed read-only smoke                               |
| 6   | `issue_claim_agent_delivery` | Issue, atomic claim, actual worker execution, bot-authored draft PR                     |
| 7   | `repository_webhooks`        | real PR/review/check webhook observations                                               |
| 8   | `pr_doctor`                  | live PRMS diagnosis                                                                     |
| 9   | `independent_human_approval` | current-head authorized non-author human approval                                       |
| 10  | `merge_steward_issue_done`   | governed merge and completed Issue/claim lifecycle                                      |
| 11  | `negentropy_preview_schema`  | unsigned SHADOW preview and pinned-schema parity only                                   |

For every step and platform, the platform operator supplies:

- the exact platform;
- `PASS` or `FAIL`;
- a non-secret observation time;
- at least one allowed redacted reference;
- public-artifact paths/hashes when applicable;
- a STOP/abort reason in the external checklist if the status is `FAIL`.

The harness itself records `recordedAt`; it has no free-form note field. Abort
notes therefore belong in the external checklist, not in `run.json`.

Allowed reference prefixes are:

```text
artifact:
github:
negentropy:
npm:
openslack:
run:
```

Record from the recorder host:

```bash
bun run live:capstone -- record \
  --correlation-id "$CAPSTONE_ID" \
  --tested-commit "$TESTED_COMMIT" \
  --platform <windows-x64|linux-x64> \
  --step <EXACT-STEP-ID> \
  --status <PASS|FAIL> \
  --evidence-ref <ALLOWED-PREFIX:REDACTED-REFERENCE> \
  --artifact <OPTIONAL-PUBLIC-ARTIFACT-TO-HASH>
```

`--evidence-ref` and `--artifact` are repeatable. `--artifact` must be a regular
non-credential file locally available to the recorder. The harness stores only
its SHA-256, not its path or contents.

On a failed observation, record `FAIL`, record the secret-safe abort note
externally, stop the dependent phase, remediate, and replace that same
platform/step record only after a real rerun. Do not record `PASS` from expected
behavior or local tests.

## 4. Phase A — release foundation

Tracks A1 and A2 may run in parallel only after every preflight gate is GO.

### A1. Create the tag and verify the signed archive release

The workflow does not cryptographically sign the Git tag. The authorized
operator creates an owner-controlled annotated tag; the workflow signs each
target's SLSA/in-toto provenance with Ed25519 and publishes immutable assets.

For a fresh tag:

```bash
git tag -a "$RELEASE_TAG" "$TESTED_COMMIT" -m "OpenSlack $RELEASE_TAG"
test "$(git rev-list -n 1 "$RELEASE_TAG")" = "$TESTED_COMMIT"
git push origin "refs/tags/$RELEASE_TAG"
```

PowerShell:

```powershell
git tag -a $env:RELEASE_TAG $env:TESTED_COMMIT -m "OpenSlack $env:RELEASE_TAG"
if ((git rev-list -n 1 $env:RELEASE_TAG).Trim() -ne $env:TESTED_COMMIT) {
  throw "STOP: local tag target mismatch"
}
git push origin "refs/tags/$env:RELEASE_TAG"
```

Select the tag-triggered run by identity, not merely by “latest”:

```bash
export RELEASE_RUN_ID="$(gh run list \
  --workflow openslack-release.yml \
  --event push \
  --limit 20 \
  --json databaseId,headSha,headBranch,status,conclusion,url,createdAt \
  --jq ".[] | select(.headSha == \"$TESTED_COMMIT\" and .headBranch == \"$RELEASE_TAG\") | .databaseId" |
  head -n 1)"
test -n "$RELEASE_RUN_ID"
```

The selected row must have `headSha == TESTED_COMMIT` and
`headBranch == RELEASE_TAG`. Then:

```bash
gh run watch "$RELEASE_RUN_ID" --exit-status
gh run view "$RELEASE_RUN_ID" \
  --json headSha,headBranch,status,conclusion,jobs,url
gh release view "$RELEASE_TAG" \
  --json tagName,isDraft,isPrerelease,assets,url
```

PowerShell can select the row without external JSON tools:

```powershell
$runs = gh run list `
  --workflow openslack-release.yml `
  --event push `
  --limit 20 `
  --json databaseId,headSha,headBranch,status,conclusion,url,createdAt |
  ConvertFrom-Json
$run = $runs |
  Where-Object {
    $_.headSha -eq $env:TESTED_COMMIT -and
    $_.headBranch -eq $env:RELEASE_TAG
  } |
  Select-Object -First 1
if (-not $run) { throw "STOP: matching release workflow run not found" }
$env:RELEASE_RUN_ID = "$($run.databaseId)"
gh run watch $env:RELEASE_RUN_ID --exit-status
```

Require both `Build and smoke windows-x64` and `Build and smoke linux-x64`, plus
`Publish tag release`, to conclude `success`.

Download to an empty public-artifact directory:

```bash
mkdir -p ".openslack.local/release/$RELEASE_TAG"
gh release download "$RELEASE_TAG" \
  --dir ".openslack.local/release/$RELEASE_TAG"
```

The release must contain exactly one set per target:

```text
openslack-v0.2.0-windows-x64.zip
openslack-v0.2.0-windows-x64.release-manifest.json
openslack-v0.2.0-windows-x64.sbom.cdx.json
openslack-v0.2.0-windows-x64.provenance.intoto.json
openslack-v0.2.0-windows-x64.provenance.intoto.json.sig
openslack-v0.2.0-windows-x64.SHA256SUMS
openslack-v0.2.0-linux-x64.tar.gz
openslack-v0.2.0-linux-x64.release-manifest.json
openslack-v0.2.0-linux-x64.sbom.cdx.json
openslack-v0.2.0-linux-x64.provenance.intoto.json
openslack-v0.2.0-linux-x64.provenance.intoto.json.sig
openslack-v0.2.0-linux-x64.SHA256SUMS
```

Verify both manifests from the source checkout with the out-of-band trusted
public key:

```bash
export TRUSTED_PUBLIC_KEY_PATH="<OUT-OF-BAND-PUBLIC-KEY-PATH>"
for target in windows-x64 linux-x64; do
  bun run release:verify \
    --manifest ".openslack.local/release/$RELEASE_TAG/openslack-v0.2.0-${target}.release-manifest.json" \
    --require-signature \
    --public-key "$TRUSTED_PUBLIC_KEY_PATH"
done
```

Require `PASS` for each target. Inspect the JSON manifests and require
`version == 0.2.0`, `commit == TESTED_COMMIT`, `channel == stable`, and the
matching target. The verifier checks archive container identity, archive/SBOM/
provenance/signature hashes, required provenance subjects, Ed25519 key ID, and
signed build parameters.

Retain the two secret-safe results for Phase A3. After the canonical ledger
exists, record `release_artifacts` separately for `windows-x64` and
`linux-x64`. A useful reference shape is
`artifact:github-release/v0.2.0/<target>/<manifest-sha256>`.

**GO:** matching workflow SHA, three successful jobs, twelve exact assets, and
two trusted verifier passes.

**STOP:** any missing/extra asset, signature/key mismatch, identity mismatch,
non-stable channel, or workflow SHA mismatch.

**Retry boundary:** a configuration-only failure may rerun on the same unchanged
tag. Existing assets are accepted only when byte-identical. A source correction
requires a new governed version.

### A2. Configure the OpenAI-compatible provider

Perform preview and write on each clean-machine workspace that will run the
provider smoke. The credential value must already be available through the
operator-owned `env:` or native `keychain:` mechanism.

```bash
openslack agent-runtime setup openai-compatible \
  --base-url <HTTPS-CHAT-COMPLETIONS-BASE-URL> \
  --model <MODEL-ID> \
  --credential-ref <env:NAME|keychain:SERVICE/ACCOUNT>
```

Require a successful preview with no write. Then repeat the exact command with
`--write`:

```bash
openslack agent-runtime setup openai-compatible \
  --base-url <HTTPS-CHAT-COMPLETIONS-BASE-URL> \
  --model <MODEL-ID> \
  --credential-ref <env:NAME|keychain:SERVICE/ACCOUNT> \
  --write

openslack agent-runtime doctor \
  --provider openai-compatible \
  --format json
```

Require a passing doctor with readiness `ready`. The local
`.openslack.local/agent-runtime.json` may contain only endpoint, model, safety
limits, and the credential reference. Do not copy that local file into release
evidence.

**GO:** preview succeeds, write succeeds, and the redacted doctor is ready.

**STOP:** the referenced credential is unavailable, the probe fails, or output
contains a credential value. Provider configuration alone does not clear
`model_endpoint_not_configured`; both-platform Phase B4 smoke is also required.

### A3. Create the one canonical capstone ledger

This is the entry gate for every `record` call and for Phase B. It runs only
after A1 has produced and verified the public signed manifest.

Only the evidence-recorder host runs `plan`. It must be at the exact
`TESTED_COMMIT` and have the public signed manifest and trusted public key
available as regular files.

```bash
bun run live:capstone -- plan \
  --tested-commit "$TESTED_COMMIT" \
  --correlation-id "$CAPSTONE_ID" \
  --credential-ref keychain:openslack/capstone-provider \
  --signed-artifact <PUBLIC-RELEASE-MANIFEST-PATH> \
  --public-key <OUT-OF-BAND-PUBLIC-KEY-PATH>
```

PowerShell uses backticks for continuation:

```powershell
bun run live:capstone -- plan `
  --tested-commit $env:TESTED_COMMIT `
  --correlation-id $env:CAPSTONE_ID `
  --credential-ref keychain:openslack/capstone-provider `
  --signed-artifact <PUBLIC-RELEASE-MANIFEST-PATH> `
  --public-key <OUT-OF-BAND-PUBLIC-KEY-PATH>
```

The output must have schema `openslack.live_capstone_run.v1`, the exact
correlation and tested commit, expected platforms `windows-x64` and
`linux-x64`, and an empty `runs` object.

The canonical file is:

```text
.openslack.local/capstone/<CAPSTONE_ID>/run.json
```

There is no merge/import command for separately created ledgers. Platform
operators must not run `plan`. They return only public artifacts, hashes,
redacted evidence references, and non-secret observations to the recorder,
which records both platforms into this one file.

After `plan`, record the two retained A1 `release_artifacts` results using the
protocol in Section 3.

**GO:** exactly one ledger exists and contains the two A1 records after they are
added.

**STOP:** if the correlation already exists unexpectedly, or any machine has
created a competing ledger, select a new correlation ID and restart the
capstone. Never splice JSON files manually.

## 5. Phase B — independent publication and clean-machine verification

Phase B must not begin until A2 and A3 are GO. All later records are written to
that same ledger.

### B1. Bootstrap the four public npm packages

Staged publishing cannot create a brand-new package. The one-time
`bootstrap-0.2.0` mode is therefore used only after Gate P4 proves that all four
versions are absent.

Immediately before dispatch:

```bash
test "$(git rev-parse main)" = "$TESTED_COMMIT"
test "$(git rev-parse origin/main)" = "$TESTED_COMMIT"
```

PowerShell:

```powershell
if ((git rev-parse main).Trim() -ne $env:TESTED_COMMIT) {
  throw "STOP: local main moved"
}
if ((git rev-parse origin/main).Trim() -ne $env:TESTED_COMMIT) {
  throw "STOP: origin/main moved"
}
```

Dispatch only on `main`:

```bash
gh workflow run npm-stage-publish.yml \
  --ref main \
  -f mode=bootstrap-0.2.0 \
  -f version=0.2.0
```

Select the run whose workflow is `npm-stage-publish.yml`, branch is `main`, and
`headSha == TESTED_COMMIT`:

```bash
export NPM_RUN_ID="$(gh run list \
  --workflow npm-stage-publish.yml \
  --branch main \
  --event workflow_dispatch \
  --limit 20 \
  --json databaseId,headSha,headBranch,status,conclusion,url,createdAt \
  --jq ".[] | select(.headSha == \"$TESTED_COMMIT\" and .headBranch == \"main\") | .databaseId" |
  head -n 1)"
test -n "$NPM_RUN_ID"
```

PowerShell:

```powershell
$npmRuns = gh run list `
  --workflow npm-stage-publish.yml `
  --branch main `
  --event workflow_dispatch `
  --limit 20 `
  --json databaseId,headSha,headBranch,status,conclusion,url,createdAt |
  ConvertFrom-Json
$npmRun = $npmRuns |
  Where-Object {
    $_.headSha -eq $env:TESTED_COMMIT -and
    $_.headBranch -eq "main"
  } |
  Select-Object -First 1
if (-not $npmRun) { throw "STOP: matching npm workflow run not found" }
$env:NPM_RUN_ID = "$($npmRun.databaseId)"
```

Then:

```bash
gh run watch "$NPM_RUN_ID" --exit-status
gh run view "$NPM_RUN_ID" \
  --json headSha,headBranch,status,conclusion,jobs,url
```

Recheck `origin/main == TESTED_COMMIT` after completion. The npm workflow runs
from `refs/heads/main`, not from the tag; the freeze is what binds its tarballs
to the signed release source.

For each package:

```bash
for package in plugin-api plugin-host sdk plugin-testkit; do
  npm view "@openslack/${package}@0.2.0" \
    name version repository exports engines files dist \
    --json \
    --registry=https://registry.npmjs.org
done
```

Require the exact name/version, repository, exports, engines, files, tarball,
integrity, shasum, and provenance/attestation metadata. Download the registry
tarballs to a clean directory:

```bash
mkdir -p .openslack.local/public-pack/registry-v0.2.0
for package in plugin-api plugin-host sdk plugin-testkit; do
  npm pack "@openslack/${package}@0.2.0" \
    --pack-destination .openslack.local/public-pack/registry-v0.2.0 \
    --ignore-scripts \
    --json
done
```

Compare each downloaded tarball SHA-256 with the corresponding
`tarballSha256` retained from Gate P6. Unpack and compare its canonical file
manifest with the matching Gate P6 artifact record. This proves both byte and
content identity to the verified `TESTED_COMMIT` pack set.

Create a disposable clean consumer, install all four exact versions with
scripts disabled, import the ESM exports, typecheck their declarations, execute
the isolated-host consumer, and verify registry signatures/provenance:

```bash
npm install \
  @openslack/plugin-api@0.2.0 \
  @openslack/plugin-host@0.2.0 \
  @openslack/sdk@0.2.0 \
  @openslack/plugin-testkit@0.2.0 \
  --ignore-scripts \
  --save-exact
npm audit signatures
```

Use the same consumer program exercised by `bun run public:verify`; do not
replace it with a package-existence-only check.

Only after all four packages pass:

```bash
for package in plugin-api plugin-host sdk plugin-testkit; do
  test "$(npm view "@openslack/${package}" dist-tags.latest)" = "0.2.0"
done
```

Within the same maintenance window:

1. revoke the temporary bootstrap token;
2. remove `NPM_BOOTSTRAP_TOKEN` from the protected environment;
3. record the workflow URL, four registry versions, npm audit-event reference,
   token revocation time, and environment-secret removal time;
4. configure exactly one trusted publisher per package:
   organization `Negentropy-Laby`, repository `OpenSlack`, workflow
   `npm-stage-publish.yml`, environment `npm-production`;
5. grant **stage publishing only**, never direct publishing;
6. confirm the workflow's Node `22.14.0` and npm `11.15.0`;
7. perform a non-destructive configuration/readiness check only. Do not publish
   an unplanned version.

GitHub archive Ed25519 evidence and npm OIDC provenance are independent. Neither
can replace the other.

#### Partial-bootstrap STOP and recovery

The workflow publishes sequentially:

```text
plugin-api -> plugin-host -> sdk -> plugin-testkit
```

If any publication or verification fails:

1. stop automatic retry;
2. inventory every exact version as **public**, **absent**, or **inconclusive**;
3. retain the workflow URL and verified candidate tarball hashes;
4. revoke the bootstrap token and remove the environment secret;
5. never republish an existing `package@0.2.0`;
6. follow [npm rollback and recovery](npm-rollback.md);
7. resume only the absent subset through an explicit operator recovery using
   the already verified exact tarballs, or through a separate governed workflow
   change;
8. if artifact identity cannot be proved, do not complete `0.2.0`; prepare a
   new governed version.

Do not blindly rerun `bootstrap-0.2.0`. npm does not permit a published version
to be reused even after unpublish.

**GO:** all four exact versions, hashes, canonical contents, metadata,
provenance, consumer checks, and `latest` values pass; token cleanup and the
four stage-only trusted publishers are recorded.

**STOP:** any partial, mismatched, unproven, or still token-enabled state.

### B2. Verify the archives on both clean machines

Use only the public GitHub Release and the public key obtained through the
independent pinned trust channel.

#### Windows x64

```powershell
$assetRoot = "<EMPTY-RELEASE-DOWNLOAD-DIRECTORY>"
gh release download $env:RELEASE_TAG `
  --repo Negentropy-Laby/OpenSlack `
  --dir $assetRoot
Get-FileHash "$assetRoot\openslack-v0.2.0-windows-x64.zip" -Algorithm SHA256
Expand-Archive `
  "$assetRoot\openslack-v0.2.0-windows-x64.zip" `
  -DestinationPath "$assetRoot\extracted"
& "$assetRoot\extracted\openslack-v0.2.0-windows-x64\openslack.exe" `
  self release verify `
  --manifest "$assetRoot\openslack-v0.2.0-windows-x64.release-manifest.json" `
  --trusted-public-key <OUT-OF-BAND-PUBLIC-KEY-PATH> `
  --format json
& "$assetRoot\extracted\openslack-v0.2.0-windows-x64\openslack.exe" version --format json
& "$assetRoot\extracted\openslack-v0.2.0-windows-x64\openslack.exe" tui doctor
```

#### Linux x64

```bash
asset_root="<EMPTY-RELEASE-DOWNLOAD-DIRECTORY>"
gh release download "$RELEASE_TAG" \
  --repo Negentropy-Laby/OpenSlack \
  --dir "$asset_root"
sha256sum "$asset_root/openslack-v0.2.0-linux-x64.tar.gz"
mkdir -p "$asset_root/extracted"
tar -xzf "$asset_root/openslack-v0.2.0-linux-x64.tar.gz" \
  -C "$asset_root/extracted"
"$asset_root/extracted/openslack-v0.2.0-linux-x64/openslack" \
  self release verify \
  --manifest "$asset_root/openslack-v0.2.0-linux-x64.release-manifest.json" \
  --trusted-public-key <OUT-OF-BAND-PUBLIC-KEY-PATH> \
  --format json
"$asset_root/extracted/openslack-v0.2.0-linux-x64/openslack" version --format json
"$asset_root/extracted/openslack-v0.2.0-linux-x64/openslack" tui doctor
```

Require release-verification schema `openslack.release_verification.v1`,
`verified: true`, version `0.2.0`, commit `TESTED_COMMIT`, channel `stable`,
matching target, `signature.status: signed`, and `signature.trusted: true`.
The platform hash command must equal both the archive entry in that target's
`SHA256SUMS` and the manifest archive digest. Version/build info must agree with
the manifest.

Record `clean_machine_archive` for each platform.

**GO:** both clean machines independently verify and launch their target.

**STOP:** any trust, hash, schema, target, native binding, or launch mismatch.

### B3. Transactional guided attach on both clean machines

Use a separate disposable external Git repository on each machine. Do not run
against OpenSlack itself.

From the repository root, first preview:

```bash
openslack setup attach \
  --repo <OWNER/REPOSITORY> \
  --mode full-agent
```

Require an applicable plan and an unchanged `git status --short`. Then apply:

```bash
openslack setup attach \
  --repo <OWNER/REPOSITORY> \
  --mode full-agent \
  --apply
openslack workspace validate
```

Capture the changed-path list. Confirm:

- only the previewed workspace files changed;
- the target repository contains no OpenSlack source-tree copy;
- generated provider configuration contains only a credential reference;
- generated agents retain `can_approve=false` and `can_merge=false`;
- no credential or `.openslack.local` material was added to Git;
- no interrupted transaction journal remains.

Run the same apply command again:

```bash
openslack setup attach \
  --repo <OWNER/REPOSITORY> \
  --mode full-agent \
  --apply
openslack workspace validate
```

Require “already matches”/no changed paths and an unchanged tracked tree. Record
preview, first apply, validation, and idempotent reapply as the transactional
evidence. Do not induce an unsafe crash merely to manufacture rollback evidence;
an actual interrupted operation must fail closed and be recovered by the
built-in next-apply journal recovery before PASS.

Record `guided_attach` for each platform.

**GO:** preview is non-mutating, apply is atomic and valid, and reapply is
idempotent.

**STOP:** conflict, symlink/path escape, unexpected file, credential copy,
validation failure, or unresolved journal.

### B4. GitHub App and provider readiness on both clean machines

An App owner must first accept the expected permissions, repository scope, and
Issue/push/PR/review/check event subscriptions outside OpenSlack.

Run:

```bash
openslack setup github
openslack github doctor
openslack delivery doctor \
  --repo <OWNER/REPOSITORY> \
  --require-issues-write
openslack delivery probe \
  --repo <OWNER/REPOSITORY> \
  --require-issues-write
openslack delivery probe \
  --repo <OWNER/REPOSITORY> \
  --require-issues-write \
  --apply
```

The applied probe must create, verify, delete, and verify removal of only its
temporary `openslack/probes/write-*` ref. If cleanup is incomplete, use the
exact preview/apply recovery command printed by OpenSlack; do not delete normal
branches.

Record `github_app_readiness` only when the App identity, accepted permissions,
event subscriptions, selected-repository scope, and write probe pass.

Then:

```bash
openslack agent-runtime doctor \
  --provider openai-compatible \
  --format json
openslack agent-runtime smoke \
  --provider openai-compatible
```

Require ready doctor and a passing governed read-only Chat Completions smoke
with terminal run evidence under `.openslack.local/agents/runs/`. Record only a
redacted run reference, not the transcript or response body.

Record `openai_compatible_provider` for each platform.

**GO:** App readiness and provider smoke pass independently on both platforms.

**STOP:** a dry-run client, scope mismatch, missing App event/permission,
temporary-ref cleanup failure, provider readiness other than `ready`, or failed
smoke.

Do not clear `model_endpoint_not_configured` for `operator`, `collaboration`, or
component `agent_runtime` until provider setup, ready doctor, and both-platform
smokes all exist.

## 6. Phase C — live Issue claim, worker execution, and bot delivery

Use one designated disposable live repository and one narrowly scoped Green
task. The repository must already have the full-agent attach, configured App,
registered agent, and configured provider.

The current CLI separates the lifecycle:

- `agent tick` discovers and atomically claims; it does **not** execute a model
  task;
- the configured agent worker executes in the isolated worktree;
- `task sync` commits, pushes, creates/updates the bot-authored draft PR,
  synchronizes the remote and PR head, and moves the claim to review.

Do not report `agent tick` or provider smoke alone as agent execution.

### C1. Preview and create the capstone Issue

```bash
openslack task create \
  --template docs \
  --title "OpenSlack 0.2.0 live delivery capstone" \
  --description "Make one bounded, reversible documentation change for live delivery verification." \
  --risk low \
  --path "docs/**" \
  --success "Bot-authored draft PR is synchronized to the current head" \
  --preview
```

Review the exact schema-valid preview, then rerun the same command with
`--create-issue` instead of `--preview`. Capture `ISSUE_NUMBER` and the generated
task ID.

### C2. Bootstrap and claim

```bash
openslack agent bootstrap --agent-id <AGENT_ID>
openslack agent tick \
  --agent-id <AGENT_ID> \
  --source github-issues
```

Require action `claimed`, the expected issue number, and claim ref
`refs/heads/openslack/claims/issue-<ISSUE_NUMBER>`.

Create the isolated worktree:

```bash
openslack task checkout \
  --issue-number <ISSUE_NUMBER> \
  --agent-id <AGENT_ID> \
  --run-id <RUN_ID>
```

### C3. Execute the actual agent worker

Invoke the repository's configured agent worker/runner for that claimed task
and isolated worktree, with runtime provider `openai-compatible`. There is no
top-level `openslack agent-runtime run` command in 0.2.0; do not invent one.

Require durable run evidence that binds:

- `AGENT_ID`, `RUN_ID`, generated task ID, and issue number;
- provider `openai-compatible`;
- the isolated worktree;
- terminal success;
- one bounded allowed-path change;
- no Red/Black path or `.openslack.local/**` access.

If the configured worker cannot produce this evidence, record Phase C as STOP.
The read-only `agent-runtime smoke` from B4 proves provider connectivity but
does not substitute for this task execution.

### C4. Publish the bot-authored draft PR

From the isolated worktree after a successful run:

```bash
openslack task sync \
  --agent-id <AGENT_ID> \
  --task-id <TASK_ID> \
  --run-id <RUN_ID> \
  --paths "<COMMA-SEPARATED-CHANGED-PATHS>" \
  --description "OpenSlack 0.2.0 live delivery capstone" \
  --issue-number <ISSUE_NUMBER>
```

Require:

- successful commit, push, and draft PR creation/update;
- PR body marker schema `openslack.task_link.v1`;
- issue/task/run/claim/branch/PR correlation;
- remote branch SHA equals PR `headRefOid`;
- initial empty check rollup is reported as `empty`, not passed;
- issue transition to review completes, or the printed idempotent
  `openslack github claim review ...` recovery command succeeds;
- PR author login equals the configured bot/agent identity, not the human
  reviewer.

Record `issue_claim_agent_delivery` for both capstone platforms only after each
platform has executed its designated live-delivery observation. Reuse the same
canonical ledger, not separate run files.

**GO:** real agent-run evidence and synchronized bot draft PR.

**STOP:** claim mismatch, manual/human PR authorship, missing task marker,
provider-smoke substitution, unsynchronized head, or incomplete review
transition.

## 7. Phase D — webhook evidence, PRMS, human approval, and merge

Continue with the Phase C PR.

### D1. Observe real repository webhooks

Start webhook mode without `--poll`:

```bash
openslack github watch start \
  --config .openslack/monitors/github-watch.yaml
```

The webhook secret is supplied through the operator-owned process environment,
never through argv. Generate real PR, review, check-run, and/or check-suite
events on the capstone PR, then inspect:

```bash
openslack github watch status
openslack collaboration activity \
  --object pr:<PR_NUMBER> \
  --format json
```

Require accepted repository-scoped live refresh, durable completed route
records, and collaboration observations for the configured event types. Webhook
review observations remain informational; they are not approval or PRMS
authority.

Record `repository_webhooks` on both platforms.

**STOP:** polling-only evidence, wrong-repository fallback, failed delivery
route, unaccepted App subscription, or any claim that a webhook approval is a
human approval.

### D2. Diagnose the capstone PR

Mark the draft ready for review through the authorized GitHub operator path,
then run live PRMS:

```bash
openslack pr status <PR_NUMBER>
openslack pr review <PR_NUMBER>
openslack pr doctor \
  <PR_NUMBER> \
  --repo <OWNER/REPOSITORY>
```

`--dry-run` is simulation and cannot be used as merge-readiness evidence. When
bot-authenticated diagnosis is required on Windows, use:

```powershell
powershell -ExecutionPolicy Bypass `
  -File scripts\openslack-bot.ps1 `
  pr doctor <PR_NUMBER> `
  --repo <OWNER/REPOSITORY>
```

Before approval, bind the branch, PR, and checks to one head:

```bash
git ls-remote origin \
  "refs/heads/<PR-BRANCH>" \
  "refs/pull/<PR_NUMBER>/head"
gh pr view <PR_NUMBER> \
  --repo <OWNER/REPOSITORY> \
  --json headRepository,headRefName,headRefOid,statusCheckRollup,mergeable,mergeStateStatus,reviewDecision,latestReviews,author,isDraft
gh pr checks <PR_NUMBER> --repo <OWNER/REPOSITORY>
```

Require branch SHA, pull ref, `headRefOid`, and all check-run SHAs to be the
same. Record the full PR SHA:

```bash
export EXPECTED_PR_HEAD="$(gh pr view <PR_NUMBER> \
  --repo <OWNER/REPOSITORY> \
  --json headRefOid \
  --jq .headRefOid)"
test "$EXPECTED_PR_HEAD" = "$(git ls-remote origin "refs/heads/<PR-BRANCH>" | cut -f1)"
```

Inspect unresolved review threads with the existing GraphQL gate.

Bash:

```bash
gh api graphql \
  -f owner="<OWNER>" \
  -f name="<REPOSITORY>" \
  -F number=<PR_NUMBER> \
  -f query='query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){
          nodes{
            id
            isResolved
            isOutdated
            comments(first:1){nodes{author{login} path body}}
          }
        }
      }
    }
  }'
```

PowerShell:

```powershell
gh api graphql `
  -f owner="<OWNER>" `
  -f name="<REPOSITORY>" `
  -F number=<PR_NUMBER> `
  -f query='query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){
          nodes{
            id
            isResolved
            isOutdated
            comments(first:1){nodes{author{login} path body}}
          }
        }
      }
    }
  }'
```

Resolve only a fixed/waived thread and only when the reviewer resolved it,
an authorized human explicitly directs it, or repository policy grants that
specific authority. An agent must not resolve an active blocker to make the PR
mergeable.

Record `pr_doctor` after both platforms have observed live diagnosis on the
same current PR head.

**GO to approval only when:** all technical checks pass on
`EXPECTED_PR_HEAD`, the branch/PR/check SHAs match, active blockers are fixed,
required conversations are resolved, and PRMS reports only missing human
approval as the remaining gate.

**STOP:** stale head/checks, failing/pending checks, conflicts, unresolved active
threads, wrong PR author, or any non-approval blocker.

### D3. Record a valid human approval

An authorized non-author human makes the decision under their human GitHub
identity:

```bash
gh pr review <PR_NUMBER> \
  --repo <OWNER/REPOSITORY> \
  --approve
```

If the task touches a governed workflow artifact, the review body must also
carry the repository's current-head Workflow Trust decision. The Green capstone
task above should not touch workflow artifacts.

Immediately re-run:

```bash
gh pr view <PR_NUMBER> \
  --repo <OWNER/REPOSITORY> \
  --json headRefOid,statusCheckRollup,mergeable,mergeStateStatus,reviewDecision,latestReviews
gh pr checks <PR_NUMBER> --repo <OWNER/REPOSITORY>
openslack pr doctor \
  <PR_NUMBER> \
  --repo <OWNER/REPOSITORY>
```

Require the unchanged `EXPECTED_PR_HEAD`, a valid current-head non-author human
approval, green checks, resolved required conversations, mergeable GitHub state,
and PRMS `READY_TO_MERGE`.

Record `independent_human_approval` for both platform observations. The approval
decision itself exists once on GitHub; the two capstone records prove that both
platforms observed the same authoritative current-head decision.

**STOP:** bot/app/agent approval, author approval, approval against an older
head, dismissed approval, or vague chat consent.

### D4. Governed merge and Issue completion

Apply a final expected-head guard immediately before the mutating OpenSlack
merge route:

```bash
test "$(gh pr view <PR_NUMBER> \
  --repo <OWNER/REPOSITORY> \
  --json headRefOid \
  --jq .headRefOid)" = "$EXPECTED_PR_HEAD"
openslack pr doctor \
  <PR_NUMBER> \
  --repo <OWNER/REPOSITORY>
openslack pr merge <PR_NUMBER> --method merge
```

`openslack pr merge` re-fetches live evidence and re-runs PRMS before invoking
the merge. Do not replace it with `gh pr merge --admin` or bypass rulesets. If
the expected head changes between the guard and merge, GitHub/PRMS must block or
the operator must stop and investigate; never treat the old approval as current.

Complete and verify the claim lifecycle:

```bash
openslack github claim complete \
  --issue-number <ISSUE_NUMBER> \
  --agent-id <AGENT_ID> \
  --pr-url <CANONICAL-PR-URL>
```

Require outcome `completed`, merged PR, closed/done Issue, and verified removal
of `refs/heads/openslack/claims/issue-<ISSUE_NUMBER>`.

Record `merge_steward_issue_done` for both platform observations.

**STOP:** merge decision other than `READY_TO_MERGE`, head drift, branch-policy
failure, or incomplete Issue/claim postconditions.

### D5. Verify only the Negentropy SHADOW preview schema

On each platform:

```bash
openslack collaboration integration negentropy export-slot --format json
openslack collaboration integration negentropy doctor --format json
openslack collaboration integration negentropy status --format json
```

Require the schema-pinned external/L5/SHADOW/opt-in/projection-only preview and
the bounded state allowed by current external evidence. The unsigned preview is
`NOT_REGISTERABLE` and contains no writer handle or mutation route.

Record `negentropy_preview_schema` for both platforms.

This step does not prove registration, activation, ENFORCE mode, external
signature, or administrator acceptance, and it does not independently clear any
of the nine release blockers.

## 8. Verify the canonical capstone

Inspect the one ledger locally:

### Bash

```bash
node -e 'const fs=require("node:fs"); const id=process.env.CAPSTONE_ID; const run=JSON.parse(fs.readFileSync(`.openslack.local/capstone/${id}/run.json`,"utf8")); console.log(JSON.stringify(run,null,2))'
bun run live:capstone -- verify \
  --correlation-id "$CAPSTONE_ID" \
  --tested-commit "$TESTED_COMMIT"
```

### PowerShell

```powershell
Get-Content -Raw `
  -LiteralPath ".openslack.local\capstone\$env:CAPSTONE_ID\run.json" |
  ConvertFrom-Json |
  ConvertTo-Json -Depth 20
bun run live:capstone -- verify `
  --correlation-id $env:CAPSTONE_ID `
  --tested-commit $env:TESTED_COMMIT
```

Require:

- schema `openslack.live_capstone_verification.v1`;
- exact `CAPSTONE_ID` and `TESTED_COMMIT`;
- `valid: true`;
- both `windows-x64` and `linux-x64` with `complete: true` and `passed: true`;
- no failures;
- exactly 11 steps on each platform, all `PASS`;
- no observation older than 30 days and no future timestamp;
- only allowed, bounded, redacted evidence references;
- a non-empty `runManifestSha256`.

Store the verification result, ledger hash, and secret-safe summary in the
operator evidence store. Do not commit `.openslack.local/**`.

**GO:** one canonical 11 × 2 PASS verification tied to `TESTED_COMMIT`.

**STOP:** missing, stale, failed, future-dated, secret-bearing, competing-ledger,
or different-commit evidence.

## 9. Blocker disposition

The registry has nine unique blocker IDs and eleven owner occurrences:

| Blocker                                           | Owner occurrences                                      | Required clearing evidence                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `signed_v0_2_0_release_pending`                   | `self_evolution`                                       | tag at `TESTED_COMMIT`, two signed target asset sets, trusted verification                                 |
| `clean_machine_release_capstone_pending`          | `self_evolution`                                       | steps 1 and 2 PASS on Windows and Linux                                                                    |
| `npm_publication_pending`                         | `self_evolution`                                       | all four exact packages, verified identity/provenance/consumer, token revoked, stage-only trust configured |
| `clean_machine_bot_delivery_smoke_pending`        | `github_task_loop`                                     | steps 4 and 6 with App, claim, actual agent run, bot PR, and synchronized head                             |
| `model_endpoint_not_configured`                   | `operator`, `collaboration`, component `agent_runtime` | provider config, ready doctor, and step 5 PASS on both platforms                                           |
| `clean_machine_onboarding_smoke_pending`          | `operator`                                             | step 3 PASS on both platforms                                                                              |
| `clean_machine_end_to_end_merge_capstone_pending` | `pr_review_merge`                                      | steps 7–10, including current-head human approval and governed merge                                       |
| `clean_machine_agent_task_capstone_pending`       | `collaboration`                                        | complete steps 6–10 agent-task flow                                                                        |
| `live_provider_smoke_pending`                     | component `agent_runtime`                              | step 5 PASS on both platforms                                                                              |

Step 4 is mandatory even though it has no unique blocker. Step 11 is mandatory
capstone coverage but clears no blocker by itself.

Repeated blocker IDs must be removed consistently only where the owner-specific
evidence exists. One module's evidence is not permission to clear another
module/component occurrence.

## 10. Live-evidence promotion

Promotion is a separate bot-authored PR after the canonical capstone verifies.
It must contain only:

```text
.openslack/evidence/live/*.json
.openslack/modules.yaml
docs/status/current.md
```

Do not mix the release runbook, npm recovery doc, changelog, package manifests,
or any product change into this PR.

### 10.1 Create six owner-scoped records

Create:

```text
.openslack/evidence/live/self_evolution.json
.openslack/evidence/live/github_task_loop.json
.openslack/evidence/live/operator.json
.openslack/evidence/live/pr_review_merge.json
.openslack/evidence/live/collaboration.json
.openslack/evidence/live/agent_runtime.json
```

Each file uses this exact schema:

```json
{
  "schema": "openslack.live_evidence.v1",
  "ownerId": "<EXACT-MODULE-OR-COMPONENT-ID>",
  "testedCommit": "<TESTED_COMMIT>",
  "outcome": "pass",
  "environment": "<BOUNDED-NON-SECRET-ENVIRONMENT-DESCRIPTION>",
  "observedAt": "<UTC-ISO-8601>",
  "expiresAt": "<UTC-ISO-8601-NO-MORE-THAN-30-DAYS-AFTER-OBSERVED>",
  "correlationId": "<CAPSTONE_ID>",
  "revision": "<TESTED_COMMIT>",
  "evidenceRefs": ["run:<CAPSTONE_ID>/<OWNER-ID>", "artifact:capstone/<RUN-MANIFEST-SHA256>"]
}
```

Use the full SHA for both `testedCommit` and `revision`; they must be equal.
`observedAt` must not predate the tested commit beyond five minutes and may not
be more than five minutes in the future. `expiresAt` must be future, later than
`observedAt`, and no more than 30 days later. Use a shorter operational window,
such as 29 days, to avoid boundary failure.

Minimum evidence allocation:

| Owner ID           | Minimum evidence                                                           |
| ------------------ | -------------------------------------------------------------------------- |
| `self_evolution`   | signed release, npm publication, steps 1–2                                 |
| `github_task_loop` | step 4, step 6, live claim/agent-run/PR linkage                            |
| `operator`         | step 3, provider setup/doctor, step 5                                      |
| `pr_review_merge`  | steps 7–10, synchronized head/checks, valid human approval, governed merge |
| `collaboration`    | steps 6–10, step 11 preview/projection evidence, step 5                    |
| `agent_runtime`    | provider setup/doctor and step 5                                           |

### 10.2 Commit 1 — evidence files

Create a promotion branch from frozen `TESTED_COMMIT`, add only the six JSON
files, validate them for secret-free bounded content, then:

```bash
git add .openslack/evidence/live/*.json
git diff --cached --name-only
git commit -m "status: record 0.2.0 live evidence"
export EVIDENCE_COMMIT="$(git rev-parse HEAD)"
```

PowerShell:

```powershell
git add .openslack/evidence/live/*.json
git diff --cached --name-only
git commit -m "status: record 0.2.0 live evidence"
$env:EVIDENCE_COMMIT = (git rev-parse HEAD).Trim()
```

The registry cannot reference a working-tree file or the later registry commit.
It must reference this evidence commit because this is the first commit that
contains the six paths.

### 10.3 Commit 2 — registry and generated status

Edit `.openslack/modules.yaml`:

- append `commit:<EVIDENCE_COMMIT>` and the owner's exact
  `repo:.openslack/evidence/live/<owner>.json` to each promoted owner;
- remove only blockers proved by that owner's record;
- set `operatorConfigured` from observed reference-environment reality;
- set maturity to `production_ready` only when that owner is configured and has
  zero remaining blockers;
- otherwise set at most `live_verified` and retain every uncleared blocker;
- promote component `agent_runtime` with Collaboration when its cap applies.

Generate status, validate, and commit:

```bash
bun run openslack status generate
bun run openslack status verify
bun run openslack workspace validate
bun run openslack self eval --suite golden
bash scripts/genesis-validate.sh
git add .openslack/modules.yaml docs/status/current.md
git commit -m "status: promote 0.2.0 live maturity"
git diff --name-only "$TESTED_COMMIT" HEAD --
```

The path list from `TESTED_COMMIT` through `HEAD` must match only:

```text
.openslack/evidence/live/agent_runtime.json
.openslack/evidence/live/collaboration.json
.openslack/evidence/live/github_task_loop.json
.openslack/evidence/live/operator.json
.openslack/evidence/live/pr_review_merge.json
.openslack/evidence/live/self_evolution.json
.openslack/modules.yaml
docs/status/current.md
```

Then rerun:

```bash
bun run format:check
bun run openslack workspace validate
bun run openslack self eval --suite golden
bun run openslack status generate
git diff --exit-code -- docs/status/current.md
bun run openslack status verify
bash scripts/genesis-validate.sh
git status --short
```

**GO:** six valid committed records, only proved blocker removals, cap-consistent
maturity, exactly generated status, and no non-allowlisted path since
`TESTED_COMMIT`.

**STOP:** stale product change, expired evidence, owner/revision mismatch,
registry reference to the wrong commit, component cap, remaining blocker hidden,
or `production_ready` while unconfigured/blocked.

### 10.4 Govern the promotion PR

The PR must be opened by the configured bot/agent identity through the
repository wrapper. Its body names the acting agent, Self-Evolution/module
status scope, Yellow zone, validation, rollback (revert the promotion commits
and restore blockers/maturity), and required human approval.

Bash:

```bash
./scripts/bot-gh-pr-create.sh \
  --title "status: record 0.2.0 live release evidence" \
  --body-file <SECRET-FREE-PR-BODY-FILE> \
  --base main \
  --head <PROMOTION-BRANCH>
```

PowerShell:

```powershell
powershell -ExecutionPolicy Bypass `
  -File scripts\bot-gh-pr-create.ps1 `
  --title "status: record 0.2.0 live release evidence" `
  --body-file <SECRET-FREE-PR-BODY-FILE> `
  --base main `
  --head <PROMOTION-BRANCH>
```

Before requesting approval, confirm remote branch SHA, PR `headRefOid`, and
checks are synchronized and current; inspect unresolved conversations; require
PRMS to show only the approval gate. A valid authorized non-author human
approval is required. Bot/app/agent approval is invalid.

Confirm the gate before asking:

```bash
gh pr view <PROMOTION-PR-NUMBER> \
  --json reviewDecision,mergeStateStatus,headRefOid,statusCheckRollup
```

Only when `reviewDecision` is `REVIEW_REQUIRED` and the sole remaining block is
approval may the authorized non-author human run:

```bash
gh pr review <PROMOTION-PR-NUMBER> --approve
```

The bot/agent author cannot run this command or make the decision.

## 11. Post-release confirmation

After the promotion PR merges, perform read-only confirmation:

```bash
gh release view "$RELEASE_TAG" \
  --json tagName,isDraft,isPrerelease,assets,url
for package in plugin-api plugin-host sdk plugin-testkit; do
  npm view "@openslack/${package}@0.2.0" \
    name version dist-tags dist \
    --json \
    --registry=https://registry.npmjs.org
done
bun run openslack status verify
bun run openslack governance audit --count 20
git status --short
```

Require the immutable release, four exact registry versions, verified generated
status, governance audit, and clean worktree. Retain the canonical verification,
six committed evidence records, workflow/release/npm URLs, human-review record,
and public artifact hashes according to the operator's evidence-retention
policy.

Remove the one-use npm bootstrap credential and any temporary secret injection
from the operator environment. Remove disposable extraction, consumer, and
public-artifact directories only after their non-secret hashes and evidence
references are retained. Do not remove the six committed records or rewrite the
tag/release.

## 12. Phase abort and cleanup index

| Phase           | GO                                                   | STOP/abort                                                             | Retain                                        | Secret-safe cleanup                                     | Next owner                |
| --------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- | ------------------------- |
| Preflight       | exact clean validated release head                   | any mismatch or missing role/trust input                               | validation URLs and public hashes             | remove only local generated/temporary non-source output | release operator          |
| A1 release      | two signed verified immutable target sets            | wrong SHA, failed build, asset/signature mismatch                      | run/release URLs, manifest and asset hashes   | no tag move or asset replacement                        | release operator          |
| A2 provider     | preview/write/ready doctor                           | missing reference or failed probe                                      | redacted doctor reference                     | keep credential in operator-owned store                 | platform operator         |
| B1 npm          | four exact public packages and stage-only trust      | partial/mismatch/inconclusive/token retained                           | workflow, registry, audit, hash refs          | revoke token and remove environment secret              | npm maintainer            |
| B2 archive      | both targets verify and launch                       | checksum/signature/schema/launch mismatch                              | public artifact hashes and verifier summaries | remove disposable extraction dirs                       | platform operator         |
| B3 attach       | preview/apply/validate/idempotent                    | conflict, secret copy, journal/validation failure                      | changed-path and validation refs              | preserve failed target for audit; use built-in recovery | platform operator         |
| B4 App/provider | App scope/probe and provider smoke pass              | scope/permission/ref cleanup/provider failure                          | redacted diagnostic/run refs                  | remove temporary probe ref through printed recovery     | App/provider operator     |
| C delivery      | claim + actual worker + synchronized bot PR          | human author, no run evidence, stale PR head                           | Issue/claim/run/branch/PR refs                | preserve dirty worktree as recoverable handoff          | agent operator            |
| D governance    | webhook + PRMS + human approval + merge + Issue done | stale head, unresolved blocker, invalid approval, incomplete lifecycle | PR/check/review/merge/Issue refs              | stop watcher gracefully; retain durable queue           | PR operator/human         |
| Capstone        | one 11 × 2 PASS ledger                               | missing/stale/failed/secret-bearing record                             | verification and manifest hash                | keep `.openslack.local` uncommitted                     | evidence recorder         |
| Promotion       | six valid records and allowlisted two-commit PR      | stale product path or unsupported maturity                             | evidence commit and PR/check refs             | revert promotion metadata if rejected                   | bot author/human reviewer |

## 13. Operator-only final checklist

The release operator must explicitly check every item:

- [ ] `RELEASE_VERSION`, `RELEASE_TAG`, real `RELEASE_DATE`,
      `TESTED_COMMIT`, and `CAPSTONE_ID` are fixed.
- [ ] `main == origin/main == TESTED_COMMIT`; worktree clean.
- [ ] Changelog and five package versions agree; no date placeholder.
- [ ] Tag/release collision is absent or exact immutable retry.
- [ ] All four npm versions were absent immediately before bootstrap.
- [ ] Full release-head validation and `public:verify` passed.
- [ ] One canonical ledger exists; no competing Windows/Linux ledger.
- [ ] Tag points at `TESTED_COMMIT`; release workflow `headSha` matches.
- [ ] Both signed target release sets pass trusted verification.
- [ ] npm workflow ran from `main` at `TESTED_COMMIT`.
- [ ] All four registry tarballs match preflight hashes/canonical manifests.
- [ ] Bootstrap token revoked and removed; four publishers are stage-only.
- [ ] Windows and Linux archive, attach, App, and provider checks pass.
- [ ] Live task includes atomic claim, actual worker run, and bot-authored PR.
- [ ] PR branch, pull ref, `headRefOid`, checks, and approval share one head.
- [ ] Required review conversations are resolved with authority and evidence.
- [ ] Authorized non-author human approval is recorded on the current head.
- [ ] PRMS reports `READY_TO_MERGE`; governed merge and Issue completion pass.
- [ ] Negentropy evidence claims preview schema only, not registration.
- [ ] Canonical verification reports 11 × 2 PASS within 30 days.
- [ ] Six owner-scoped records use the exact owner IDs and tested revision.
- [ ] Evidence promotion uses two commits and only allowlisted paths.
- [ ] Every one of the nine unique blockers is proved cleared for each owner or
      explicitly retained.
- [ ] `production_ready` is claimed only where configured, unblocked, and not
      capped by component maturity.

Until every applicable checkbox is supported by authoritative evidence,
OpenSlack 0.2.0 remains not eligible for the corresponding maturity promotion.
