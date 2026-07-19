# npm publication recovery and rollback

This runbook covers registry recovery for OpenSlack's four public packages:

```text
@openslack/plugin-api
@openslack/plugin-host
@openslack/sdk
@openslack/plugin-testkit
```

Use it with [`npm-publishing.md`](npm-publishing.md) for forward publication.
It does not roll back OpenSlack release archives, Git tags, installed binaries,
or workspace state; use
[`manual-upgrade-rollback.md`](../guides/manual-upgrade-rollback.md) for CLI
binary and local-state recovery.

## Safety invariants

- Treat the four packages as one release set. Do not declare a release healthy
  while their public or staged versions are inconsistent.
- Stop at the first unexpected registry result. Do not blindly rerun
  `bootstrap-0.2.0`: the workflow publishes sequentially, so earlier packages
  may already be public when a later publish fails.
- Never paste a token, OTP, private key, or secret value into a command,
  incident record, workflow input, or log. Let npm prompt for interactive 2FA.
- A published `package@version` is immutable. Unpublishing is irreversible and
  does not make that version reusable.
- Prefer deprecation and distribution-tag repair over unpublish. Unpublish is
  an exceptional operator decision subject to npm's current policy.
- Do not replace a governed workflow with an improvised local publish.
  Recovery must use the exact verified tarballs and retain an auditable
  workflow or operator record.
- npm provenance is independent of OpenSlack archive signatures. Neither is a
  substitute for the other.

The bootstrap workflow publishes in this order:

1. `@openslack/plugin-api`
2. `@openslack/plugin-host`
3. `@openslack/sdk`
4. `@openslack/plugin-testkit`

A failed run can therefore leave any leading subset public.

## First response and read-only inventory

Freeze npm release activity before changing registry state:

1. Cancel queued or in-progress runs for `npm-stage-publish.yml`.
2. Record the failed workflow URL, mode, requested version, `headSha`, and
   conclusion.
3. Confirm that the run's `headSha` is the governed release commit. Do not use
   a successful run for a different commit as recovery evidence.
4. Inspect every package independently; an `E404` is expected for an absent
   bootstrap version and must not stop inspection of the remaining packages.
5. Record public versions, `latest`, other dist-tags, staged entries, tarball
   integrity, and provenance references. Store references and hashes, never
   credentials.

Use read-only commands such as:

```bash
npm view @openslack/plugin-api versions --json
npm view @openslack/plugin-host versions --json
npm view @openslack/sdk versions --json
npm view @openslack/plugin-testkit versions --json

npm dist-tag ls @openslack/plugin-api
npm dist-tag ls @openslack/plugin-host
npm dist-tag ls @openslack/sdk
npm dist-tag ls @openslack/plugin-testkit

npm stage list @openslack/plugin-api
npm stage list @openslack/plugin-host
npm stage list @openslack/sdk
npm stage list @openslack/plugin-testkit
```

For each public version, also record the immutable registry artifact metadata:

```bash
npm view <package>@<version> dist.integrity dist.shasum dist.tarball --json
```

Compare the registry identity with the exact tarball produced by the governed
`public:verify` run. A matching version string alone is not sufficient.

## Select the recovery path

| Observed state                                     | Recovery path                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Versions exist only in npm staging                 | Reject the affected staged entries; do not use dist-tags or unpublish            |
| Bootstrap failed after publishing a leading subset | Follow **Partial bootstrap**                                                     |
| All four versions are public and valid             | Complete trusted-publisher conversion and verification                           |
| All four versions are public but must be withdrawn | Follow **Published release rollback**                                            |
| Any package has been unpublished                   | Never reuse that package/version; publish a new aligned release version          |
| Source or artifact identity is uncertain           | Do not complete `0.2.0`; contain public members and prepare a new version        |
| Token or trusted-publisher compromise is suspected | Revoke the credential or trust relationship first, then inventory registry state |

If the evidence does not unambiguously identify one row, keep publishing
frozen and treat the state as an incident. Do not guess.

## Reject a staged release before approval

`npm stage publish` does not make a version public. Before approval, reject the
stage instead of trying to repair dist-tags:

1. List and inspect each staged entry:

   ```bash
   npm stage list <package>
   npm stage view <stage-id>
   npm stage download <stage-id>
   ```

2. Match the stage ID, package, version, tag, tarball, and originating workflow
   evidence. Do not act on a stage ID inferred only from ordering.
3. An authorized npm maintainer rejects each affected entry:

   ```bash
   npm stage reject <stage-id>
   ```

   Rejection requires interactive 2FA and permanently removes the staged
   entry. Do not pass an OTP on the command line.

4. Run `npm stage list <package>` again for all four packages and record that
   the rejected entries are absent.

If even one staged entry was already approved, it is public; use the published
release procedures for that package. The tag selected when staging is
immutable. To change it before publication, reject the entry and stage a new
one through the governed workflow.

## Recover a partial `0.2.0` bootstrap

The bootstrap uses `npm publish` without an explicit `--tag`, so a successful
publish normally assigns `latest`. A retry starts again with
`@openslack/plugin-api`; it is not an idempotent resume operation.

### Contain the bootstrap credential

Contain the one-use bootstrap token immediately, whether the run succeeded or
failed:

1. Revoke it from the npm access-token settings, identifying it by token ID,
   not by copying its value. npm's CLI also supports revocation by ID:

   ```bash
   npm token list --json
   npm token revoke <token-id>
   ```

2. Remove the GitHub environment secret without reading it:

   ```bash
   gh secret delete NPM_BOOTSTRAP_TOKEN \
     --env npm-production \
     --repo Negentropy-Laby/OpenSlack
   ```

3. Confirm the token ID is absent from npm's token inventory and
   `NPM_BOOTSTRAP_TOKEN` is absent from:

   ```bash
   gh secret list \
     --env npm-production \
     --repo Negentropy-Laby/OpenSlack
   ```

4. Record the revocation and environment-secret removal times. npm warns that
   revocation propagation can be delayed; do not close containment solely
   because the delete request returned successfully.

Never rotate the bootstrap token into a reusable CI credential.

### Decide whether the published subset is acceptable

For every package already public at `0.2.0`, prove all of the following:

- the registry tarball identity matches the verified tarball from the exact
  workflow `headSha`;
- the package manifest, version, visibility, and provenance are expected;
- `latest` points to the intended version, or the tag difference is explicitly
  accounted for;
- the workflow and npm audit references explain when and by whom publication
  occurred.

Then choose exactly one recovery:

#### Resume the missing subset

Use this only when the already-published subset is correct and immutable.

- Do not rerun the existing bootstrap job unchanged.
- Do not republish a package/version that already exists.
- Resume only through a governed recovery workflow or reviewed workflow change
  that explicitly enumerates the missing packages, rebuilds and verifies the
  same release commit, checks the existing subset's registry integrity, and
  publishes only the missing exact tarballs.
- Afterward, verify all four public versions, integrity values, provenance
  references, and dist-tags before configuring trusted publishers.

Versions that were never published or staged can still be published as
`0.2.0`. This does not permit reuse of a version that was published and later
unpublished.

#### Abandon `0.2.0` and move the set forward

Use this when any published artifact is wrong, provenance cannot be proven, or
an aligned resume cannot be audited.

1. Repair `latest` according to the published-release matrix below.
2. Deprecate each public `0.2.0` member of the failed set with a concise
   recovery message.
3. Leave packages for which `0.2.0` was never published untouched.
4. Create a governed version-bump change for a new version across all four
   packages and the release automation.
5. Build and run `public:verify` for the new aligned version, then partition
   the four package names by registry existence:
   - an **existing package** has at least one registry version, even when
     `0.2.0` is deprecated;
   - a **new package** returns `E404` for the package name because bootstrap
     never reached it.
6. Submit the new version of every existing package through its stage-only
   trusted publisher. Inspect each staged exact tarball and keep it pending
   until the new-package bootstrap has been verified.
7. Do not run `npm stage publish` for a new package: npm cannot stage a package
   name that has never existed. Create each such package with a governed,
   one-use bootstrap that publishes only its exact `public:verify` tarball for
   the new version. The current `bootstrap-0.2.0` mode cannot be reused for
   another version; this requires an explicit reviewed recovery workflow or
   workflow change, not a local publish.
8. Revoke and remove the recovery bootstrap token immediately after bootstrap,
   verify the new-package artifacts, then have a maintainer approve each
   pending existing-package stage with interactive 2FA. Verify all four public
   artifact identities and configure or reconfirm the exact stage-only trusted
   publisher on every package. Once all four package names exist, subsequent
   releases use staged publishing for the complete set.

If an entire package was unpublished, obey npm's package-name republish delay
before treating it as a bootstrap-required package. It still cannot be staged
while the package name is absent.

Do not fill gaps by publishing modified `0.2.0` tarballs.

## Roll back an already published release

Deprecation warns consumers without breaking installations that already pin the
version:

```bash
npm deprecate <package>@<bad-version> "<recovery message>"
```

Use one of these dist-tag strategies for every package in the release set.
Inspect current tags immediately before each write and verify them immediately
afterward.

### A previous stable version exists

Point `latest` back to the last verified stable version, then deprecate the bad
version:

```bash
npm dist-tag add <package>@<previous-stable> latest
npm deprecate <package>@<bad-version> "<recovery message>"
npm dist-tag ls <package>
```

Never assume the previous stable is identical across the four packages; prove
each target before changing it. The release set is recovered only when the
resulting compatible versions are documented together.

### This is the first public release

There is no previous version to invent. If `latest` still points to the bad
first release, remove that tag and deprecate the version:

```bash
npm dist-tag rm <package> latest
npm deprecate <package>@<bad-version> "<recovery message>"
npm dist-tag ls <package>
```

The deprecated version remains installable by exact version, but an unqualified
install no longer selects it through `latest`. Publish a new governed version
before restoring `latest`.

### Unpublish is an exceptional last resort

npm recommends deprecation instead of unpublish. An operator may consider
unpublish only after checking the current npm policy and dependency/download
conditions:

- a newly created package can generally be unpublished within 72 hours only
  when no public-registry package depends on it;
- older packages must satisfy npm's additional dependency, download, and
  ownership criteria;
- unpublish cannot be undone;
- a used `package@version` can never be reused, even after unpublish;
- unpublishing every version of a package creates a 24-hour waiting period
  before that package name can publish again.

If an authorized operator selects this path, record the policy basis and exact
affected package/version before running the npm-documented command:

```bash
npm unpublish <package>@<version>
```

After any unpublish, the next release must use a new version for the entire
OpenSlack public package set. Never restore service by trying to republish the
removed version.

## Restore stage-only trusted publishing

Once the registry is in an accepted state, configure each package separately
with exactly one trusted publisher:

| Field                   | Required value              |
| ----------------------- | --------------------------- |
| Provider                | GitHub Actions              |
| Organization/repository | `Negentropy-Laby/OpenSlack` |
| Workflow filename       | `npm-stage-publish.yml`     |
| Environment             | `npm-production`            |
| Allowed action          | `npm stage publish` only    |

Do not grant direct `npm publish`. Configure package publishing access to
require 2FA and disallow traditional token publishing. Trusted publishing
requires GitHub-hosted runners; the repository workflow pins Node `22.14.0`
and npm `11.15.0`, which satisfy staged-publishing requirements. The human
maintainer's environment must independently use Node `22.14.0` or newer and
npm `11.15.0` or newer, with account-level 2FA enabled.

Create the relationship explicitly for each package; omitting
`--allow-publish` is intentional:

```bash
node --version
npm --version
npm trust github <package> \
  --repo Negentropy-Laby/OpenSlack \
  --file npm-stage-publish.yml \
  --env npm-production \
  --allow-stage-publish
npm trust list <package> --json
```

If the trusted relationship itself is suspect, list and revoke it by
relationship ID, then create and verify a replacement:

```bash
npm trust list <package> --json
npm trust revoke <package> --id <trust-id>
```

OIDC short-lived credentials can stage but cannot approve or reject. An npm
maintainer must review the downloaded staged tarball and use interactive 2FA
for `npm stage approve` or `npm stage reject`.

## Post-action verification

Run the complete read-only check after rejection, resumption, deprecation,
dist-tag repair, or unpublish. Capture each result independently so an `E404`
for one package does not hide the other three:

```bash
npm view @openslack/plugin-api versions dist-tags --json
npm view @openslack/plugin-host versions dist-tags --json
npm view @openslack/sdk versions dist-tags --json
npm view @openslack/plugin-testkit versions dist-tags --json

npm stage list @openslack/plugin-api
npm stage list @openslack/plugin-host
npm stage list @openslack/sdk
npm stage list @openslack/plugin-testkit

npm trust list @openslack/plugin-api --json
npm trust list @openslack/plugin-host --json
npm trust list @openslack/sdk --json
npm trust list @openslack/plugin-testkit --json
```

For every version that remains public, repeat the `dist.integrity`,
`dist.shasum`, and `dist.tarball` inspection and compare it with the governed
verification evidence. For every deliberately absent version, record the
registry `E404` as absence evidence rather than treating it as a successful
artifact check. For every package that exists, require the trust output to show
exactly one GitHub Actions relationship for `Negentropy-Laby/OpenSlack`,
`npm-stage-publish.yml`, `npm-production`, with `npm stage publish` allowed and
direct `npm publish` disallowed.

## Recovery evidence and exit criteria

Record only redacted references and public artifact identities:

- incident or release correlation ID;
- affected workflow URL, mode, version, `headSha`, and conclusion;
- per-package public versions, staged IDs/status, tarball integrity, provenance
  reference, and final dist-tags;
- decision taken for each published, staged, absent, deprecated, or unpublished
  version;
- bootstrap token revocation time and GitHub environment-secret removal time,
  without token IDs or values in public evidence;
- trusted-publisher repository, workflow, environment, and stage-only
  permission;
- authorized human maintainer approval or rejection reference;
- new recovery version and validation evidence, when applicable.

Recovery is complete only when:

1. no unintended stage remains;
2. all four packages have an explicitly accepted and compatible state;
3. `latest` selects only a verified stable version, or is deliberately absent
   for a withdrawn first release;
4. bad public versions are deprecated or covered by an exceptional recorded
   unpublish decision;
5. no used version is scheduled for reuse;
6. the bootstrap token and GitHub secret are removed;
7. each package has the exact stage-only trusted publisher and 2FA policy;
8. the evidence identifies the same governed source commit and exact tarballs.

## npm references

- [Staged publishing](https://docs.npmjs.com/staged-publishing/)
- [`npm stage` CLI, including approve and reject](https://docs.npmjs.com/cli/v11/commands/npm-stage/)
- [Trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [Revoking access tokens](https://docs.npmjs.com/revoking-access-tokens/)
- [Deprecating packages or versions](https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions/)
- [`npm dist-tag`](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)
- [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)
