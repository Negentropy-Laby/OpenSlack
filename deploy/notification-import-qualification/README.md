# Notification post-import qualification deployment

This pack prepares the single protected `G5-POST-IMPORT-QUALIFICATION` run. It is
`IB7_EVALUATION_ONLY`: a PASS supplies evidence for a separately authorized IB7 decision and does
not authorize IB6, IB7 cutover, `LIVE_VERIFIED`, either OpenSlack release, production readiness,
repository archive, or destructive retirement.

The v1 environment manifest and its schema are immutable historical records for the unexecuted
pre-IB6 `G5-IMPORT-QUALIFICATION` role. The current closed inputs are
`environment-manifest.v2.json` and `environment-manifest.v2.schema.json`; they remain
`PENDING_EXTERNAL`.

External environment, repository, identity, release, and live-system inputs must not be requested
or configured before `IB6-MERGE-TRAIN/PX2-EXIT`. After PX2 Exit, the post-IB6 OpenSlack 0.2.0
freeze and G4 must also pass before G5 can run.

The workflow runs only from an explicitly selected commit on `main`, is serialized, and has a hard
60-minute protected-job timeout. The dispatch must provide `expected_commit`. The hosted,
environment-free preflight checks out that exact commit without persisted credentials and refuses
to enter the protected environment unless it contains both:

- `services/notification-delivery`;
- `integration/gates/ib6-history-import.json`.

The protected job checks out the same exact commit and reconfirms its commit identity, Git object
types, paths, and non-symlink state before setup, external input validation, or credential
materialization.

A deployment-owned runner configured by absolute path performs the real two-repository/two-vendor
events and controlled fault drills on the Linux host. The runner receives credential file paths
through its environment; raw credentials never appear in arguments or evidence.

The runner must create, within its run-specific evidence directory:

- `qualification-input.json`;
- `receipt-reconciliation.json`;
- `security-review.json`;
- one `fault-runs/<drill>.json` file and its `fault-runs/<drill>.sha256` sidecar for every
  required drill.

All files are metadata-only, mode `0600`, and immutable for the run. The repository sealer verifies
their SHA-256 bindings and fault sidecars, binds the input to the checked-out commit and protected
environment's exact clean checkout tree, watch config, service commit/tree/image digest,
repositories, vendors, routes, and epochs, derives PASS or FAIL from the closed qualification
contract, and publishes `qualification-report.json` plus `qualification-report.sha256` create-only.
A timeout or missing or mismatched external artifact fails the workflow; it is never replaced with
mock evidence.

After every prerequisite is satisfied, the standard dispatch remains:

```bash
MAIN_SHA="$(gh api repos/Negentropy-Laby/OpenSlack/commits/main --jq .sha)"
gh workflow run notification-import-qualification.yml \
  --repo Negentropy-Laby/OpenSlack \
  --ref main \
  -f expected_commit="$MAIN_SHA"
```
