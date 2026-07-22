# ADR-0005: OpenSlack Notification Handoff Integration

## Status

Accepted under the owner-authorized standalone review waiver —
`G0_CONTRACT_PASS_WITH_RC_REVIEW_WAIVER`.

## Date

2026-07-22

## Summary

Integrate this service with OpenSlack as a process-isolated notification delivery authority. OpenSlack owns durable
materialization and retry before a valid `202 Accepted`; PostgreSQL in this service owns delivery after that receipt.
The target release is OpenSlack 0.3.0. This ADR freezes contracts only and does not enable a new runtime path.

## Provenance And Release Boundary

- Source review baseline: commit `7976962e7de1c6ffcd234d2962b89dc4b23c95c0`, tree
  `ad742f2295c70af27d67173b248f7ae151e7faf9`, seven reachable commits.
- OpenSlack 0.2.0 code-delivery evidence anchor: commit
  `e2eb615d37fe5e2861d6e90e6382ee6c34ff3ede`, tree `0db4739bfe63df46572db583baeaaaa727e1e2a1`.
- OpenSlack integration development base: commit `cdf1cbc629273b89f1737a6efc4e8325e7c9ebfb`, tree
  `c62f6643c0f8fe966bb463c0b585b1b496fcdba2`.
- IB0 through IB5 remain on two independent repositories. History import is forbidden until the 14-day Canary passes
  and OpenSlack 0.2.0 has an immutable release.
- The future import target is `services/notification-delivery`; the service remains an independent Go module,
  container and process.

The mechanical source record is [`../../integration/source-manifest.json`](../../integration/source-manifest.json).

## Authority Boundary

```text
GitHub event
  -> OpenSlack durable event
  -> final vendor bytes
  -> content-addressed Blob and route reference
  -> POST /v1/notifications
  -> valid 202 and durable local receipt
  -> rc_wsman PostgreSQL outbox
  -> vendor
```

- OpenSlack must not submit before the final Blob and its route reference are durable.
- Until a valid receipt is durable locally, OpenSlack may retry only with the same idempotency key.
- Once OpenSlack persists `accepted`, this service permanently owns vendor delivery for that route record.
- OpenSlack must never direct-send an accepted record. Delivered/dead views are read-only projections.
- A service `202` means durable acceptance, not vendor delivery. It cannot produce OpenSlack's
  `notification.sent` event.

## Route Identity And Handoff Key

Every external v2 route has an immutable `route_id` matching
`^(?:[a-z])(?:[a-z0-9-]{0,62}[a-z0-9])?$` (1–64 characters). It is unique within the canonical repository.

`routing_epoch` is a positive safe
integer starting at 1. Backend, vendor, target, encoder, response policy, outbound idempotency mapping or any other
incompatible delivery-semantic change requires a higher epoch. Persisted records keep their frozen values.

The v2 preimage is exact bytes:

```text
UTF8("openslack.watch.handoff.v2") || 0x00 ||
UTF8(event_stable_key)             || 0x00 ||
UTF8(route_id)                     || 0x00 ||
ASCII(routing_epoch without leading zeroes)
```

OpenSlack hashes the preimage with SHA-256, takes the first 16 bytes, sets the RFC 4122 variant and version nibble 5,
then renders lowercase `8-4-4-4-12`. This is a UUIDv5-formatted SHA-256 digest: it uses the UUID variant and
version-5 bit layout only for encoding. It is not RFC 4122 UUIDv5, which uses SHA-1; implementations must not replace
this construction with a standard UUIDv5 library. Payload digest is deliberately excluded. The same key with
different vendor or payload bytes must converge to the existing notification or return `409 IdempotencyConflict`;
it must not create a new notification.

`event_stable_key` is non-empty and contains no U+0000. The canonical `route_id` is also NUL-free and
`routing_epoch` is decimal ASCII, making the delimiter-based preimage unambiguous.

## Final Vendor Body

OpenSlack materializes exactly once, before submission:

- Slack encoder `openslack.slack_chat_post_message.v1` writes UTF-8 JSON for the ordered object
  `{channel,text,client_msg_id}`, where `client_msg_id` is the handoff key.
- Webhook encoder `openslack.webhook_notification.v1` writes the current ordered `NotificationPayload` JSON.
- There is no BOM, trailing newline, whitespace reformatting or service-side canonicalization.
- The decoded maximum remains 262144 bytes.
- Slack endpoint versions use no outbound idempotency mapping because the key is in the body.
- Webhook endpoint versions map the ingress key to `Idempotency-Key` and
  `X-OpenSlack-Idempotency-Key` without rewriting the body.

OpenSlack stores these raw bytes in a local SHA-256 content-addressed Blob. This service stores the decoded bytes and
sends them unchanged.

## Intake Receipt Contract

The existing intake request remains:

```http
POST /v1/notifications
Authorization: Bearer <caller key>
Idempotency-Key: <frozen handoff key>
Content-Type: application/json

{"vendor_id":"...","payload_base64":"..."}
```

A valid receipt is only HTTP 202 with a strict envelope and deployment digest:

```json
{
  "request_id": "...",
  "data": {
    "notification_id": "...",
    "state": "pending",
    "accepted_at": "...",
    "idempotent_replay": false
  }
}
```

```http
X-Notification-Service-Deployment-Digest: sha256:<64 lowercase hex>
```

Unknown fields, truncated JSON, invalid JSON or a missing/malformed digest make a 202 a retryable protocol error
because the service may already have committed. A syntactically valid digest that differs from OpenSlack's frozen
expected digest is an integrity quarantine. A replay must return the original notification identity.

## Handoff HTTP Classification

| Response | OpenSlack result |
|---|---|
| strict 202 plus matching deployment digest | accepted |
| malformed/incomplete 202 | retryable protocol error |
| valid 202 with unexpected deployment digest | quarantined: deployment digest mismatch |
| same key with conflicting receipt identity | quarantined: receipt conflict |
| any other 2xx | quarantined: unexpected success status |
| 3xx | rejected: protocol redirect; never follow |
| 408, 429, 5xx | retryable |
| timeout, reset, response loss or temporary DNS/TLS error | retryable |
| 400, 401, 403, 404, 413 | rejected |
| 409 | quarantined: idempotency conflict |
| other 4xx | rejected: unexpected client error |

All response reads are capped at 16 KiB. Raw response bodies are never persisted or logged.

## Handoff Retry And Terminal States

OpenSlack's pre-202 handoff policy is independent of this service's existing vendor policy:

- first POST is attempt 1 and runs immediately;
- after failed attempt `n`, delay is
  `min(1 hour, max(5 seconds * 2^(n-1), valid Retry-After))`;
- there is no random jitter;
- the deadline is 24 hours after the Blob and route reference first become durable;
- attempt 25 failure or the deadline, whichever comes first, produces `handoff_dead`;
- claim and immediate pre-send checks both enforce the bounds;
- a persisted processing intent consumes an attempt after a crash because the request may have escaped;
- retries and governed recovery always use the original key.

OpenSlack states are `pending`, `processing`, `retryable`, `accepted`, `rejected`, `quarantined` and `handoff_dead`.
`accepted` is terminal for pre-202 ownership. `delivered` and `dead` are separate read-only service projections.

## Service Endpoint Configuration V2

IB1 will add `config_schema_version: 2` while preserving v1 defaults:

- response policy: `http_status_v1` or `json_ack_v1`;
- auth strategy: `bearer` or `none`;
- outbound idempotency source: `notification_id` or `ingress_idempotency_key`;
- one to four unique, lower-case, allowlisted header names.

The vendor-admin wire contract is a closed union. Its v1 arm retains the pre-IB1 request shape byte-for-byte and
continues to mean schema 1 + `http_status_v1`; it does not accept v2 discriminator fields. The v2 arm requires both
`config_schema_version: 2` and an explicit `response_policy`. Registration accepts either arm. `update_version`
accepts same-version replacement or v1-to-v2 upgrade but rejects v2-to-v1 downgrade. Credential rotation is valid
only for bearer endpoints and changes only the credential reference while preserving the complete current endpoint,
schema, response policy and idempotency mapping.

Schema v2 `auth_strategy:none` forbids both `credential_ref` and `credential_field` transport headers. Its historical
and list projections omit `credential_descriptor`. Schema v2 never permits `body_field`; it supports only `none` or
one-to-four-header mapping sourced from `notification_id` or `ingress_idempotency_key`.

Slack uses bearer auth, `json_ack_v1` and no idempotency mapping. On 2xx, `json_ack_v1` reads no more than 16 KiB:
top-level `ok: true` succeeds; `ok: false` with `fatal_error`, `internal_error`, `ratelimited`, `request_timeout` or
`service_unavailable` retries; other codes are permanent vendor rejection; malformed or oversized acknowledgements
are permanent sanitized vendor protocol errors.

Webhook uses no auth, `http_status_v1`, and maps the ingress key to both OpenSlack idempotency headers. V2 never
rewrites the final body.

## Principals And Deployment Evidence

IB1 bootstraps two least-privileged principals in one transaction:

```text
openslack-handoff-caller
  caller; submit_notification; scoped to two Canary vendors

openslack-canary-auditor
  operator; read_notifications; same vendor scope; no managed-principal scope
```

The runtime caller cannot query operations. The Canary auditor cannot submit, replay or administer. Raw keys are
returned once to an explicit `0600` create-only file and never appear in stdout or logs.

`cmd/bootstrap-openslack` is the sole IB1 provisioning surface. It is a one-shot, non-HTTP command rather than a
general key-administration interface. It accepts exactly two unique vendor IDs and always creates the fixed identities
and capabilities above. The command durably creates and synchronizes the credential file before opening PostgreSQL,
then uses a dedicated transaction-scoped advisory lock to insert both principals and both key verifiers in one
transaction. A confirmed rollback removes and synchronizes the file; an indeterminate commit retains it for manual
convergence. Existing output files or either existing principal fail closed and are never overwritten.

Canary/production startup requires `NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST=sha256:<64 lowercase hex>`, supplied by
the deployment system from the verified OCI image. All first and replayed 202 responses carry it. OpenSlack records
it with a secret-free canonical watch-config digest and independently queried vendor config versions.

## V1 Queue Migration

Migration is per route, not per delivery:

- completed routes become non-sending tombstones;
- failed routes become terminal archives;
- pending/retryable routes remain owned and drained by v1 direct delivery;
- processing routes wait for lease recovery and remain v1-owned;
- mixed deliveries may contain routes in different categories;
- legacy keys are copied and never recalculated with the v2 formula.

No accepted service record may ever be imported into or claimed by direct delivery.

## Canary And History Gates

Runtime integration cannot pass until a real two-repository/two-vendor E2E completes. The Canary gate is at least 336
continuous hours and 100 distinct, non-replay accepted keys, covering at least two repositories and two vendor IDs,
with restart and response-loss drills and no unresolved correctness or security blocker.

The service history may be imported only after that gate and after OpenSlack 0.2.0 is immutably released. The import
must retain this baseline and every subsequent standalone commit as ancestors, preserve the exact final source tree
at `services/notification-delivery`, and put relocation changes in later commits. Standalone repository archival and
database cleanup remain separately authorized external actions.

## Standalone Review Governance

The owner accepted the IB0 contract merge at `1b68cb6` without representing it as independently reviewed. For the
remaining standalone lifetime of this repository, integration changes require all of the following controls:

- every change is proposed through a pull request based on the latest `main`;
- the required CI checks pass against that current base;
- the repository owner uses a merge commit; direct pushes, squash merges, rebases and force-pushes are forbidden;
- no pull-request approval is required in this standalone repository.

This is a review-policy waiver, not a technical-contract waiver. It does not alter the authority boundary, frozen
wire contracts, implementation gates or acceptance criteria in this ADR. It also does not claim that pull request
#1 received an independent approval. The waiver ends when the complete standalone history is imported at IB6; from
that point, this service and all later changes are governed by OpenSlack's independent-review requirements.

## Non-Goals Of IB0

- No migrations, endpoint schema changes, response-body reads or credentials are implemented here.
- No OpenSlack Blob, client, queue, router, CLI or runtime path is enabled here.
- No production-readiness or live-verification claim is made.
- G0 is recorded as `G0_CONTRACT_PASS_WITH_RC_REVIEW_WAIVER`; the service-side exception is limited to the
  standalone review policy defined above.
