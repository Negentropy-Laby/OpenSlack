# Operations Runbook

> Target behavior only. Commands and dashboards are added after implementation; this file does not claim a running system.

## Signals

| Signal | Meaning | First action |
|---|---|---|
| outbox depth rising | intake exceeds delivery or workers cannot progress | inspect oldest age and readiness |
| oldest pending age rising | delivery latency/backlog | inspect Store/worker/vendor errors |
| dead count > 0 for 5m | at least one cycle needs operator decision | list dead and group by vendor/reason |
| readiness false | database/config/secret dependency unavailable | stop routing new traffic |
| worker health event | internal contract/config/deadline path failed | inspect stable error code and request ID |

Collection failure is unknown, never healthy zero.

## Backlog Triage

1. Confirm PostgreSQL readiness and schema compatibility.
2. Compare pending/in-flight/dead counts and oldest pending age.
3. Check worker health events without reading payload or secret material.
4. Group failures by stable vendor ID and sanitized result/reason.
5. Confirm vendor lifecycle and active endpoint version.
6. Do not bypass Store, edit rows manually or start a second ad-hoc delivery process.

## Dead Notification Recovery

1. Confirm the external vendor has recovered and evaluate duplicate-side-effect risk.
2. Query the notification and attempt history.
3. Preview explicit notification IDs with a meaningful justification.
4. Record the returned `expected_version`; preview does not reserve state.
5. Execute explicit `{notification_id, expected_version}` items.
6. Review succeeded/skipped/failed arrays individually.
7. If the response is lost or outcome unknown, query state/version/history; never blindly resubmit.

Batch maximum is 100. Automatic replay and “replay all matching query” are forbidden.

## Vendor Disable or Credential Incident

- Disable prevents unstarted attempts; an already sent request may finish and be recorded.
- Rotate credential by appending an endpoint version; never edit historical versions.
- Revoke affected API keys and issue a new key; do not log the replacement secret. (For a pepper compromise rather
  than a per-key incident, see [API-Key Pepper Rotation and Compromise](#api-key-pepper-rotation-and-compromise)
  below.)
- Verify audit and receipt convergence, then inspect new Delivery snapshots.

## API-Key Pepper Rotation and Compromise

Target behavior only; exact commands and drill cadence belong to the later deployment package.

- **Routine rotation** (planned): deploy `API_KEY_PEPPER_ACTIVE=new` with `API_KEY_PEPPER_PREVIOUS=old`, restart,
  rotate principal keys at leisure under the at-most-two-active-keys rule, confirm zero non-revoked keys still
  reference `previous` via a count query, then drop `previous`. Draining `previous` is a precondition for the next
  routine rotation.
- **Emergency rotation** (suspected pepper compromise): (1) freeze `manage_access_keys` (no issue/rotate); (2)
  bulk-revoke every key whose `pepper_id` is the compromised generation in one Store transaction — at commit, the
  next authentication of a revoked key returns `401` immediately (zero-staleness; auth reads DB status, not the
  pepper); if the commit outcome is unknown, re-query the non-revoked count with that `pepper_id` to converge; (3)
  deploy the new pepper as `active` with **no** `previous` retained and restart so the burned pepper leaves memory;
  (4) re-issue keys, then unfreeze.
- **Pepper loss**: startup is fail-closed (readiness false, authentication `503`). Restore the pepper from its
  separate backup (independent of the database backup); if both primary and backup are unrecoverable, generate a new
  pepper and treat it as compromise-equivalent (full re-issuance).
- **Evidence** (per [Escalation and Evidence](#escalation-and-evidence)): capture the compromised `pepper_id` label
  (never the value), the count and `key_id`s of revoked keys, the operator `principal_id`, timestamp, Store
  transaction id and deploy version. The pepper **value** is never captured (CTRL-016). Closure must state whether any
  key issued under the burned `pepper_id` survived into the restart window (only possible if the freeze was violated).

## Database Failure

- Intake returns retryable service-unavailable; never return `202` before commit.
- Workers stop claiming; existing leases recover after the database and service are healthy.
- Confirmed rollback and commit-outcome-unknown are diagnosed differently.
- Do not start an empty replacement database or write to local disk as a fallback.

## Backup and Restore Target Procedure

This is the required production procedure, not evidence that a backup system already exists:

1. use the PostgreSQL platform's encrypted base-backup plus continuous WAL/PITR facility; backup storage credentials
   are separate from application credentials;
2. select retention and recovery objectives during deployment review from measured business needs—this design does
   not invent an RPO/RTO;
3. restore first into an isolated database at the selected recovery point, using the same PostgreSQL major and a
   schema version supported by the application release;
4. verify database consistency, migration version, notification immutable fields, unique idempotency keys,
   monotonic notification versions/attempt sequences, endpoint version immutability and current vendor pointers;
5. reconcile the restored maximum attempt/audit sequence and identify notifications whose send result may have
   occurred after the recovery point; treat them as duplicate-risk cases, never silently mark them delivered;
6. rotate database/backup credentials, point a controlled service instance at the restored database, run readiness
   checks and a scoped read-only inspection before routing intake;
7. record recovery point, validation evidence, potential duplicate window and operator decision.

A restore drill must succeed before production readiness and recur on an operator-owned schedule. Exact platform
commands, retention and drill cadence belong to the later deployment package.

## Safe Manual Actions

Allowed: scoped query, preview, replay execute, key revoke/rotate, vendor disable/config version append.

Forbidden: direct state UPDATE, attempt/audit DELETE, lease clearing, payload/secret export, bypass HTTP calls or
manually marking delivered.

## Escalation and Evidence

Capture request/notification/vendor IDs, stable result/reason, timestamps, config version and deployment version.
Never capture raw API keys, credential refs, payloads or response bodies. Incident closure must state whether duplicate
delivery was possible and whether a replay occurred.
