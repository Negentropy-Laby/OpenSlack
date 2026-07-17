# Public npm publishing

OpenSlack publishes exactly four public packages:

```text
@openslack/plugin-api
@openslack/plugin-host
@openslack/sdk
@openslack/plugin-testkit
```

All other workspace packages remain private. Run `bun run public:verify` before any registry action. It builds two independent pack sets, compares their unpacked canonical manifests, and installs the four tarballs into a clean consumer.

## Bootstrap 0.2.0

Staged publishing cannot create a package that does not already exist. An npm maintainer must first:

1. Prove control of the `@openslack` scope and enable 2FA.
2. Create a one-use granular token without exposing it to an agent.
3. Store it as `NPM_BOOTSTRAP_TOKEN` in the protected `npm-production` GitHub environment.
4. Approve and dispatch `npm-stage-publish.yml` on `main` with mode `bootstrap-0.2.0` and version `0.2.0`.
5. Confirm all four registry versions and tarball identities.

The bootstrap workflow refuses every other version. It uses the token only in the bootstrap step and publishes the already verified tarballs with npm provenance.

The granular token must expire within 24 hours and be scoped only to the four
packages. Bootstrap is not complete merely because the packages exist: the same
maintenance window must record the workflow run URL, the four verified registry
versions, the npm audit-event reference, the token revocation time, and the
GitHub environment-secret removal time in the release evidence. Do not retain
or rotate the bootstrap token into a reusable repository credential.

## Convert to stage-only OIDC

After bootstrap:

1. Configure each package's npm trusted publisher for repository `Negentropy-Laby/OpenSlack`, workflow `npm-stage-publish.yml`, and environment `npm-production`.
2. Grant the trust relationship `stage publish` only; do not grant direct publish.
3. Revoke the npm token and remove `NPM_BOOTSTRAP_TOKEN` from the protected
   environment before closing the bootstrap maintenance window.
4. Configure each package to require 2FA and disallow token publishing.

Future dispatches use mode `stage`. GitHub-hosted Actions obtains a short-lived OIDC identity and runs `npm stage publish`. A maintainer must inspect each staged tarball and approve it with npm 2FA before it becomes public.

The npm OIDC provenance is independent of OpenSlack archive Ed25519 signatures. Do not translate, reuse, or mix the two evidence formats.
