# Notification import qualification deployment

This pack prepares the single protected `G5-IMPORT-QUALIFICATION` run. It replaces the unrun
long-duration Canary gate only for IB6 history-import eligibility. It does not authorize
`LIVE_VERIFIED`, IB7, OpenSlack 0.3.0, production readiness, or retirement.

The workflow runs only from `integration/notification-delivery-0.3`, is serialized, and has a hard
60-minute job timeout. A deployment-owned runner configured by absolute path performs the real
two-repository/two-vendor events and controlled fault drills on the Linux host. The runner receives
credential file paths through its environment; raw credentials never appear in arguments or
evidence.

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

The checked-in environment manifest intentionally remains `PENDING_EXTERNAL` until the protected
environment, Linux host, Slack App/channel, service, database, receiver, vendor versions, and
caller/auditor scopes are verified.
