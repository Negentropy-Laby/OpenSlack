# Logical Data Model

> PostgreSQL 18.4 target. This is the logical contract implemented by the numbered files under `migrations/`;
> those files, rather than this narrative, are the executable DDL authority.

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
reference. Credential locator, secret, command fingerprint and raw caller fields are forbidden. A successful event
must reference its receipt and record the post-mutation revision; a rejected event has no receipt or post-mutation
revision and uses one of the seven closed business-rejection reasons.

An authorized `VENDOR_NOT_FOUND` rejection still requires an audit event even though no `vendors` row exists.
Consequently `admin_audit_events.vendor_id` is an immutable logical target identifier, not a foreign key, and
`owning_scope` is nullable only for that not-found history. This deliberate exception does not permit pre-authorization
scope failures to write an audit event.

Indexes: unique global `audit_seq`; keyset `(audit_seq DESC, event_id DESC)`; scope-qualified audit reads add
`vendor_id`/owning-scope lookup support without changing the frozen sequence bound.

On success, vendor mutation, optional version append, audit and receipt commit atomically. An authorized business
rejection writes its single sanitized audit in a standalone committed statement and writes no receipt or domain row.

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

`pepper_id` follows the Migration Principles: additive nullable first, backfill existing rows to the initial generation
id, then constrain NOT NULL; the unique-HMAC-digest constraint is unchanged. The CDD-level
`AccessKeyRecord.secret_hash` (opaque verifier) is unchanged; `pepper_id` and the HMAC mechanism live in this
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
- Migration tests cover clean bootstrap, upgrade from `000001`, explicit failure on legacy non-bearer endpoint rows,
  one-step down/up and full down/up. Production rollback remains conditional: a down migration must fail rather than
  discard append-only history that cannot fit the previous schema.

## Retention

MVP retains all records. No unmeasured retention period is invented. Architecture review records table growth as an
operational risk; measured table/index size and query maintenance determine a later retention/partition ADR.
