# Logical Data Model

> PostgreSQL 18.4 target. This is a logical contract, not DDL or migration code.

## Ownership

| Aggregate | Owner | Core records |
|---|---|---|
| Notification | Notification Store | `notifications`, `delivery_attempts` |
| Vendor | Vendor Registry | `vendors`, `endpoint_versions`, `admin_command_receipts`, `admin_audit_events` |
| Principal | Caller Access | `principals`, `access_keys` |

Operations and Observability own no tables. Delivery owns no persistent state.

## Notification Store

### `notifications`

- identity: opaque `notification_id`; unique `(caller_id, idempotency_key)`;
- immutable: caller/vendor IDs, idempotency key, request fingerprint, decoded payload bytes and created time;
- mutable only by state machine: state/version, current-cycle attempt count/start, next attempt, lease,
  delivered/dead/replay fields and last-result projection;
- indexes:
  - unique caller/idempotency;
  - eligible partial index on `(next_attempt_at, delivery_cycle_started_at, created_at, notification_id)` for
    `state=pending`;
  - lease-expiry partial index on `(lease_expires_at, notification_id)` for `state=in_flight`;
  - scoped dead-list keyset index on `(vendor_id, dead_at, notification_id)` for `state=dead`;
  - scoped state/created index for singleton and aggregate queries.

### `delivery_attempts`

Append-only. Unique `(notification_id, attempt_seq)` and opaque attempt ID. Stores claimed/outcome/recovery/replay
events, actor, lease, result union, sanitized summary and recorded time. Database roles deny UPDATE/DELETE to the
application role; corrections append a new event.

Primary query index: unique `(notification_id, attempt_seq)` plus
`(notification_id, attempt_seq, attempt_id)` for stable ascending history pagination.

Notification transition and attempt append are one transaction. There is no second outbox or DLQ table: pending rows
are the outbox and dead rows are the DLQ.

## Vendor Registry

### `vendors`

Owns immutable vendor ID/owning scope and mutable lifecycle, record revision and active configuration pointer.
Disabled is one-way in MVP.

Indexes: primary key `vendor_id`; live-list keysets on `(created_at, vendor_id)` and
`(owning_scope, created_at, vendor_id)`; lifecycle/owning-scope filters must preserve the same immutable sort key.

### `endpoint_versions`

Append-only immutable configurations. Unique `(vendor_id, config_version)`. Contains canonical HTTPS target and
derived transport fields, method, literal/credential Header rules, opaque credential reference, outbound idempotency
mapping, endpoint policy and auth strategy. Updating policy or credential appends a version and moves the vendor
pointer.

Primary/unique index `(vendor_id, config_version)` supports snapshot-bounded ascending history.

### `admin_command_receipts`

Unique `(actor_id, idempotency_key)`, immutable command fingerprint and sanitized `AdminResult`. It is checked after
current authorization and before state/OCC, preventing an old receipt from bypassing revoked scope.

Indexes: primary key `receipt_id` and unique `(actor_id, idempotency_key)`.

### `admin_audit_events`

Append-only, globally increasing `audit_seq`, sanitized operation/outcome/authorization basis and optional receipt
reference. Credential locator, secret, command fingerprint and raw caller fields are forbidden.

Indexes: unique global `audit_seq`; keyset `(audit_seq DESC, event_id DESC)`; scope-qualified audit reads add
`vendor_id`/owning-scope lookup support without changing the frozen sequence bound.

Vendor mutation, optional version append, audit and receipt commit atomically.

## Caller Access

### `principals`

Principal ID, kind (`caller|operator`), status, vendor scope, capabilities, revision and timestamps. Vendor
administration is an operator capability set, not a third externally authenticating principal kind.

Indexes: primary key `principal_id`; bounded scope lookup is implementation-private and must not expose counts.

### `access_keys`

Key ID, principal ID, HMAC digest, `pepper_id` (non-secret label of the pepper generation that produced the digest — see ADR-0003), status, created/expiry/revoked timestamps. Raw key exists only once at issuance.
At most two active keys per principal. Rotation creates a new row; revocation never deletes history.

Indexes/constraints: primary key `key_id`; unique HMAC digest; `(principal_id, status)` for authentication/lifecycle.
Issue/rotation serializes the principal row and checks the fixed active-key cap atomically; an index alone is not
treated as proof of the cap.

`pepper_id` is an additive logical-schema column introduced per the Migration Principles (additive nullable first,
backfill all existing rows to the initial generation id, then constrain NOT NULL); the unique-HMAC-digest constraint is
unchanged. This is a logical design note only — no DDL or migration files are created in the documentation phase. The
CDD-level `AccessKeyRecord.secret_hash` (opaque verifier) is unchanged; `pepper_id` and the HMAC mechanism live in this
Architecture storage projection (caller-access.md delegates physical schema, hash algorithm, indexes and key
generation to Architecture).

MVP rate-limit counters are bounded in-memory state, not a durable guarantee. This limitation is documented and
triggers a shared limiter only when multiple replicas become required.

## Transaction Time and OCC

- PostgreSQL transaction time is authoritative for Store transitions, replay, recovery and persisted timestamps.
- Every mutable aggregate has a monotonic revision/version checked by writes.
- A rejected command writes no domain row unless the governing CDD explicitly requires a sanitized business-rejection
  audit.
- Commit results distinguish confirmed rollback from outcome unknown.

## Migration Principles

- Forward-only production evolution; every migration has a documented rollback or restore procedure.
- Additive nullable column first, backfill/verify, then constrain; never reinterpret existing enum values silently.
- Append-only history and immutable identity fields survive every migration.
- A migration changing state/union semantics requires CDD and ADR review before DDL.
- Implementation must test upgrade from the immediately previous schema and a clean bootstrap; this document does not
  create migration files.

## Retention

MVP retains all records. No unmeasured retention period is invented. Architecture review records table growth as an
operational risk; measured table/index size and query maintenance determine a later retention/partition ADR.
