# Notification Delivery IB6 Order Supersession

> **Decision:** complete repository-only IB6 readiness, exact-history import, and productization
> before requesting or configuring release/live external inputs.
>
> **Recorded at:** `2026-07-25T17:25:00+08:00`
>
> **Effective:** only after the governed OpenSlack pull request containing this decision is merged.

## Preserved Architecture And Evidence

OpenSlack remains the control plane, Notification Delivery Service remains a separate process and
Go module, and receipts/reconciliation remain the evidence plane. The import must preserve the
standalone repository's original commit IDs and ancestry through a non-squashed, two-parent
unrelated-history merge.

The earlier `G5-CANARY → G5-IMPORT-QUALIFICATION` decision remains immutable historical evidence.
The new record supersedes only its unexecuted `G5-IMPORT-QUALIFICATION` role as a pre-IB6
authorization gate. It preserves `G5-CANARY=SUPERSEDED_NOT_RUN` and `executed=false`; it does not
erase or reinterpret the earlier record. Its receipt, schema, amendment, and v1 environment
manifest are byte-bound by the new append-only decision record:

[`integration/gates/ib6-repository-import-order-supersession.json`](../../integration/gates/ib6-repository-import-order-supersession.json).

Nothing in this decision rewrites an earlier run, manufactures a PASS, or changes the default
fail-closed service admission.

## Revised Order

Before IB6:

```text
IB6-REPOSITORY-IMPORT-READINESS
  -> exact human IB6_HISTORY_IMPORT_ONLY authorization
  -> pure unrelated-history import PR
  -> repository-only productization PRs
  -> IB6-HISTORY-IMPORT receipt
  -> PX2 Exit
```

Only after PX2 Exit:

```text
release date / npm / signing trust / GitHub App subscriptions / Provider / clean machines
  -> post-IB6 v0.2.0 freeze and full release validation
  -> G4-E2E
  -> G5-POST-IMPORT-QUALIFICATION
  -> separately authorized IB7 evaluation
```

`IB6-MERGE-TRAIN/PX2-EXIT` is the accepted ordering boundary, and `PX2-EXIT` is its terminal
unlock gate. External inputs remain `PENDING_EXTERNAL` until that exit. `v0.2.0` is re-frozen from
post-IB6 `main`; no pre-IB6 release or live claim is permitted, and prior release evidence is not
reusable for the new freeze.

## Authorization Boundary

The decision record authorizes no repository operation. Its merge records the repository order; it
does not authorize the IB6 import itself. Exact-head human approval of this Phase A PR is distinct
from the later import authorization. Before an import branch exists, that separate human decision
must bind the exact
OpenSlack base commit/tree, archive tag object, source commit/tree/count, import path, readiness
report digest, and any narrowly scoped archive-tag immutability exception.

This decision also does not authorize:

- G4 or G5 PASS;
- IB7 cutover or live routes;
- OpenSlack 0.2.0 or 0.3.0 release;
- production maturity;
- standalone repository archive;
- credential retirement or destructive cleanup.

## Post-Import Qualification Locator

The existing workflow filename remains stable:

```text
.github/workflows/notification-import-qualification.yml
```

Its current semantics are post-import. The hosted preflight binds `main` and `expected_commit`,
checks out that exact commit without persisting credentials, and refuses to enter the protected
environment until both the imported service path and the governed IB6 receipt exist. The protected
job checks out the same exact commit and reconfirms those invariants before setup or credential
materialization. It remains manual, bounded to 60 minutes, and `PENDING_EXTERNAL`.

The v2 environment manifest is:

[`deploy/notification-import-qualification/environment-manifest.v2.json`](../../deploy/notification-import-qualification/environment-manifest.v2.json).

It is an IB7-evaluation input only. It does not authorize IB7 cutover.
