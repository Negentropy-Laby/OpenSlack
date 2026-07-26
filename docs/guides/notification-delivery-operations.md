# Notification Delivery Operations

Use this guide to inspect and recover the existing notification queue without exposing payloads or
silently changing delivery authority. The complete command and flag reference remains
[`docs/user-guide.md`](../user-guide.md); this page organizes the safe operating flow.

The Notification Delivery Service is currently unreleased, runtime admission remains gated, and
PX2 is pending. These commands inspect or govern repository-local delivery state; they do not
authorize new service records, IB7 cutover, external configuration, or production use.

## Check Readiness

Start with the read-only checks:

```bash
openslack github notifications doctor
openslack github notifications status
```

`doctor` validates the explicit v2 watch configuration, queue, active Blobs, committed acceptance
receipts, handoff credential reference, separate read-only auditor credential, expected service
deployment digest, and metadata-only vendor evidence configuration. It does not send a
notification.

`status` summarizes payload-blind v2 and legacy queue counts. A passing local status is not proof
of service availability, vendor delivery, PX2 exit, or qualification.

## Inspect The Queue

List all route projections or filter by the exact local state:

```bash
openslack github notifications queue
openslack github notifications queue --state <state>
```

The output includes whitelisted route identity, local state, authority, attempt count, receipt
ledger state, and remote delivery projection. It excludes event prose, payload bytes, Blob
references, credentials, and raw vendor responses.

Interpret the main delivery terms separately:

| Term        | Meaning                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `accepted`  | OpenSlack has committed a strict service receipt and transferred authority to the service       |
| `delivered` | Read-only reconciliation verified the service result and matching metadata-only vendor evidence |
| `dead`      | The service's read-only projection reached a terminal delivery failure                          |
| `unknown`   | No authoritative remote delivery projection is available; it is not proof of success or failure |

Local handoff states such as `rejected`, `quarantined`, and `handoff_dead` describe the
OpenSlack-to-service boundary. They are distinct from the service's `delivered` and `dead`
projections.

## Reconcile One Route

Use the immutable route-record ID, not a notification payload or vendor URL:

```bash
openslack github notifications reconcile <route-record-id>
```

Reconciliation compares:

1. the committed local acceptance receipt;
2. the service's sanitized notification state and attempt history through the read-only auditor
   principal; and
3. protected metadata-only vendor evidence.

Only `outcome=consistent` establishes the `delivered` projection. `pending`, `dead`,
`vendor_evidence_required`, `unavailable`, and `conflict` remain fail-closed outcomes and require
investigation.

## Recover A Rejected Or Dead Handoff

This flow applies to a rejected or `handoff_dead` OpenSlack handoff that still retains its immutable
Blob. A service-side `dead` projection does not return authority to OpenSlack and is not retried
through this command.

Always preview first:

```bash
openslack github notifications retry <route-record-id> --reason "<reason>"
```

Check the current queue projection and, for accepted or quarantined records, reconcile before any
decision. Only after explicit operator authorization should you apply a new governed recovery
cycle:

```bash
openslack github notifications retry <route-record-id> --reason "<reason>" --apply
```

Recovery may reset the attempt/deadline window, but it must not change the route ID, routing epoch,
vendor, idempotency key, Blob, encoder, or final vendor bytes.

## Resolve Quarantine

Inspect the record and reconcile it before choosing a disposition:

```bash
openslack github notifications quarantine show <route-record-id>
openslack github notifications reconcile <route-record-id>
openslack github notifications quarantine resolve <route-record-id> \
  --decision retry \
  --reason "<reason>"
```

The resolve command is preview-oriented unless `--apply` is explicitly supplied. A retry or archive
decision requires matching read-only reconciliation evidence; otherwise resolution fails closed.
Archive is an append-only terminal disposition. It does not delete the route, expose the payload,
or transfer delivery authority.

## Inspect Qualification State

```bash
openslack github notifications qualification status
openslack github notifications qualification report
```

`QUALIFICATION_NOT_RUN` is the expected result when no sealed post-import qualification report
exists. A missing, invalid, or failing report must not be interpreted as qualification, PX2, IB7,
release, or live evidence.

## Common Failures

| Result or code                       | Meaning and safe response                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REMOTE_RECONCILIATION_REQUIRED`     | Local evidence cannot authorize quarantine recovery. Configure and run read-only three-party reconciliation first.                                                |
| `BLOB_NOT_AVAILABLE`                 | The retained immutable Blob is missing or unavailable. Do not re-render bytes or substitute another payload.                                                      |
| `ACCEPTED_RECEIPT_RECOVERY_REQUIRED` | An accepted receipt ledger was interrupted before the receipt file was committed. Run normal startup recovery, then doctor again.                                 |
| `DEPLOYMENT_DIGEST_MISMATCH`         | The service-reported deployment identity differs from the configured expected digest. Quarantine the assumption; do not hand off or recover against that service. |
| `QUALIFICATION_NOT_RUN`              | No sealed qualification report exists. External qualification and all later lifecycle claims remain pending.                                                      |
| `QUALIFICATION_ARTIFACT_INVALID`     | The report, checksum, file identity, permissions, or schema could not be verified safely. Treat it as no valid evidence.                                          |

For service-side database, worker, vendor, metrics, backup, and PITR response procedures, use the
[service operations runbook](../../services/notification-delivery/docs/operations/runbook.md).
For the immutable handoff and HTTP classification rules, use the
[cross-process integration contract](../developer/notification-delivery-integration.md).
