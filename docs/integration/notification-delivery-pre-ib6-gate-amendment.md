# Notification Delivery Pre-IB6 Gate Amendment

> **Decision:** replace the unexecuted `G5-CANARY` prerequisite with
> `G5-IMPORT-QUALIFICATION` for IB6 history-import eligibility only
>
> **Recorded at:** `2026-07-24T00:46:29+08:00`
>
> **Owner authorization:** `wsman`
>
> **Effective:** only when the governed OpenSlack pull request containing this amendment is merged

## Decision

The previously documented `G5-CANARY` requirement of 336 continuous hours and 100 distinct non-replay accepted
keys is prospectively retired as an IB6 prerequisite. It is recorded as:

```text
G5-CANARY = SUPERSEDED_NOT_RUN
```

This is not a pass, waiver, backdated result or mutation of historical evidence. Existing branches, commits,
reports and evidence remain unchanged and retain their original status.

The replacement gate is:

```text
G5-IMPORT-QUALIFICATION = PENDING
```

It qualifies only whether the standalone notification-delivery history may enter the OpenSlack repository through
the separately governed IB6 exact-history import. It does not qualify a default cutover or production release.

## Replacement Qualification

One protected run must complete within a 60-minute timeout. The gate has no minimum elapsed duration. The run must
produce at least eight distinct accepted notifications where `idempotent_replay` is false, covering every cell of
this matrix at least once:

```text
2 repositories x 2 event kinds (issue, push) x 2 vendors = 8 cells
```

Every accepted notification must reach `delivered` within 10 minutes of its accepted timestamp. The run must also
exercise:

- an OpenSlack restart;
- loss of a successful 202 response followed by same-key retry;
- a notification-service restart while its PostgreSQL outbox is pending.

The protected run passes only when all of the following remain true:

- receipt, PostgreSQL and vendor observations reconcile;
- the response-loss retry returns the same notification ID for the same idempotency key;
- there is no unexplained vendor duplicate;
- there is no conflict or `delivery_dead`;
- an accepted route never falls back to direct delivery;
- handoff caller and read-only auditor scopes remain isolated;
- evidence, logs and reports contain neither payload nor secret material.

A timeout, missing matrix cell, delivery taking longer than 10 minutes, failed drill or violated invariant fails the
run. A later attempt is a new protected run with a new correlation ID; evidence from failed runs is retained and
cannot be combined to manufacture a pass.

## Required Evidence

The gate receipt must bind the run to:

- the OpenSlack commit and tree;
- the standalone service commit and tree;
- the service image and deployment digest;
- the normalized watch-config digest;
- both canonical repositories, both route IDs and routing epochs, both vendor IDs and their config versions;
- the caller and auditor scope descriptors;
- the correlation ID and start/end timestamps;
- the eight or more distinct non-replay accepted keys and their receipt, database and vendor reconciliation;
- the three fault-drill results;
- a secret/payload marker scan;
- immutable evidence-file SHA-256 values.

The machine-readable decision record is
[`integration/gates/g5-import-qualification-supersession.json`](../../integration/gates/g5-import-qualification-supersession.json).
Its closed contract is
[`notification-delivery-gate-supersession.v1.schema.json`](notification-delivery-gate-supersession.v1.schema.json).
A separate run receipt is required before `G5-IMPORT-QUALIFICATION` can become `PASS`.

## Runtime And Release Disposition

PR [#282](https://github.com/Negentropy-Laby/OpenSlack/pull/282) and merge commit
`5c7b3f842b429c34ad7244780720fb38570081d2` remain the runtime baseline. Their queue-v2, daemon/router and governed
operations changes are retained. `OPENSLACK_NOTIFICATION_SERVICE_NEW_RECORDS` remains fail-closed by default, so
this governance change does not admit service routes or change external traffic.

The `main` commit produced by merging this amendment becomes the next OpenSlack 0.2.0 `TESTED_COMMIT` candidate.
It is only a candidate until the complete 0.2.0 release validation is rerun at that exact commit. Evidence produced
for an earlier commit does not cover it.

Even after `G5-IMPORT-QUALIFICATION=PASS`, this amendment does not authorize:

- `LIVE_VERIFIED` status;
- IB7 default cutover;
- OpenSlack 0.3.0 release;
- module, product or production-readiness promotion.

All other IB6 prerequisites, exact-history import controls, review requirements and release-owner approvals remain
in force.
