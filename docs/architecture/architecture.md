# rc_wsman Master Architecture

> **Status**: Approved — independent Architecture review PASS (2026-07-20)
> **Stage**: Implementation
> **Stack**: Go 1.26.5, PostgreSQL 18.4, chi v5, pgx v5
> **Implementation**: B1–B6 implemented, mechanically verified and independently Approved; local submission-ready

## Goals and Constraints

The service accepts internal notification submissions, durably exposes them for delivery, and attempts approved
vendor HTTP(S) endpoints with at-least-once semantics. It must remain a delivery pipe, prevent open-proxy behavior,
bound failure, expose state and allow guarded manual replay.

Binding constraints:

- notification and outbox visibility commit atomically;
- Store is the only notification/lease/attempt/replay authority;
- Registry is the only vendor/config/credential-reference authority;
- external duplicates are possible and public;
- 25 attempts or 24 hours ends a delivery cycle in `dead`;
- no response-body business logic, automatic replay or arbitrary URL.

## Deployment View

```text
                 internal network / TLS
                          │
                   ┌──────▼──────┐
                   │ Go service  │
                   │             │
submit/admin/ops ─►│ HTTP API    │
metrics/scrape  ◄──│ Metrics     │
                   │ Worker pool ├──── safe HTTPS ───► approved vendors
                   │ Lease sweep │
                   └──────┬──────┘
                          │ pgx transactions
                   ┌──────▼──────┐
                   │ PostgreSQL  │
                   │ only truth  │
                   └─────────────┘
```

MVP uses one binary and one process. Multiple replicas remain compatible with row locking and leases but are not a
day-1 requirement. Logical modules are not separately deployable services.

## Component Ownership

| Component | Owns | Exposes | Consumes |
|---|---|---|---|
| Caller Access | principals, key digests, capabilities, vendor scope, rate counters | authenticate/authorize/context attenuation | key repository, clock |
| Vendor Registry | vendor lifecycle, endpoint versions, receipts, admin audit | active check, latest/specific snapshot, admin/read operations | PostgreSQL |
| Notification Store | notification, lease, attempt history, replay, query projections | accept/claim/transition/recover/query | PostgreSQL |
| Delivery | retry/dead decision, safe request construction and one HTTP attempt | worker lifecycle only | Store, Registry, secret resolver, safe transport |
| Operations Control | query/preview/execute composition | operator HTTP behavior | Caller Access, Store |
| Reliability Observability | three gauges and alert semantics | `/metrics` projection | Store global query |
| App lifecycle | dependency construction, startup/readiness/shutdown | process lifecycle | all ports |

No component except its owner may write an owned table. Cross-module calls use typed interfaces in the same process.

The deployment tool `cmd/bootstrap-openslack` is a separate, one-shot binary. It does not start the HTTP server or
workers and exposes no network listener. Its narrow configuration contains only `DATABASE_URL` and the active API-key
pepper. After durably creating a protected credential file, it acquires a dedicated PostgreSQL advisory transaction
lock and atomically creates the fixed OpenSlack caller/auditor principals and their two key verifiers. It is not a
general Caller Access administration surface.

Vendor Registry administration exposes a closed endpoint-config union. Legacy v1 commands retain their original wire
shape and are materialized as schema 1 with `http_status_v1`. Explicit schema v2 commands select response policy,
`bearer|none` authentication and the v2 no-rewrite idempotency mapping. Version changes may stay at the current schema
or move v1 to v2; they cannot downgrade. Credential rotation copies the current immutable version and replaces only
the bearer credential reference. Auth-none versions contain NULL credential columns and omit credential descriptors
from history/list projections.

## Startup and Shutdown

Startup is fail-closed:

1. parse and validate configuration; reject unknown credential schemes and invalid retry/lease invariants;
2. establish PostgreSQL pool and verify schema version compatibility;
3. load the active (and optional previous) API-key pepper generations and the allowlisted `env://` credential names;
   fail closed if any `pepper_id` present on a non-revoked `access_keys` row has no loaded pepper;
4. construct repositories, typed context factories and safe HTTP transport;
5. start lease recovery, Delivery workers and metrics collector;
6. expose readiness, then accept HTTP traffic.

Shutdown:

1. readiness becomes false and inbound server stops accepting new requests;
2. allow active intake transactions to finish;
3. cancel unstarted worker work; an in-flight HTTP attempt may finish within its hard timeout;
4. report its result when lease and shutdown deadline permit; otherwise Store recovery records unknown result;
5. stop metrics/recovery and close the database pool.

There is no lease renewal and no local disk fallback.

## Inbound Request Flow

```text
HTTP middleware
  -> request_id / size / JSON validation
  -> CallerAccess.authenticate(Bearer key)
  -> authorize submit_notification(vendor_id)
  -> VendorRegistry.is_vendor_active(singleton scoped context)
  -> construct ValidatedIntake
  -> NotificationStore.accept(transaction)
  -> 202, replayed 202, 409 conflict or closed error
```

The raw vendor body is carried as decoded base64 bytes. Registry supplies transport Content-Type and endpoint data;
the caller cannot provide them. `202` is returned only after the Store transaction commits.

## Delivery Flow

```text
claim oldest eligible row + lease
  -> pre-send attempt/deadline checks
  -> latest active snapshot
  -> resolve credential in memory
  -> build headers/body
  -> resolve all A/AAAA and validate policy
  -> dial one pinned IP with original TLS hostname
  -> classify one response/transport result
  -> atomic succeed/retry/die Store transition
```

If a retryable attempt finishes at or after `cycle_send_cutoff`, Delivery changes that actual result to permanent
`deadline_exceeded` in the current Store write. Store preserves status/error, increments the attempt, clears the
lease and writes `dead` atomically. A no-send cutoff remains a non-counting policy termination.

## Operator and Observability Flows

Operator APIs re-authenticate every request. Preview is read-only; execute accepts explicit
`notification_id + expected_version`, processes items best-effort and never expands a query into writes. Unknown
commit outcomes require re-query, not blind replay.

Metrics performs one global Store query and exports exactly outbox depth, oldest pending age and dead count.
Collection failure publishes no false zero. `dead > 0` for five uninterrupted minutes fires the fixed alert.

## Internal Interfaces

```go
type Store interface {
    Accept(ctx context.Context, in ValidatedIntake) (AcceptResult, error)
    Claim(ctx context.Context, leaseTTL time.Duration, actor StoreWorkerContext) (ClaimResult, error)
    Transition(ctx context.Context, req TransitionRequest, actor ActorContext) (TransitionResult, error)
    RecoverExpired(ctx context.Context, limit int, actor StoreSystemContext) ([]RecoveredLease, error)
    Query(ctx context.Context, query StoreQuery, actor ActorContext) (StoreProjection, error)
}

type VendorRegistry interface {
    IsActive(ctx context.Context, vendorID VendorID, actor VRIngressContext) (bool, error)
    SnapshotLatest(ctx context.Context, vendorID VendorID, actor VRDeliveryContext) (DeliverySnapshot, error)
    Admin(ctx context.Context, command AdminCommand, actor VRAdminContext) (AdminResult, error)
}
```

These are architecture shapes, not source files. Concrete API names must remain traceable to CDD operations.

## Persistence and Transactions

- Intake: dedup lookup/insert, immutable body/fingerprint and outbox visibility in one transaction.
- Claim: `FOR UPDATE SKIP LOCKED`, eligible/cycle-age ordering, lease and claimed history in one transaction.
- Result: OCC/lease validation, state/version, attempt row, count and terminal/retry timestamps in one transaction.
- Replay: dead validation, new cycle fields and replay history in one transaction.
- Vendor admin: record/version, audit and idempotency receipt in one transaction.

See `data-model.md` and ADR-0001.

## Configuration and Secrets

Configuration is loaded once at startup and validated as a generation. API keys use a versioned deployment HMAC pepper
(see ADR-0003): structured as `API_KEY_PEPPER_ACTIVE={id,value}` plus an optional `API_KEY_PEPPER_PREVIOUS={id,value}`
grace generation. Both are env secrets loaded via the startup `env://`-allowlist and changing either requires a
restart; the pepper **value** is a CTRL-016 secret and only the non-secret `pepper_id` label is persisted on
`access_keys`. Registry persists `env://NAME` only; the secret resolver accepts names in a startup allowlist and
returns bytes directly to an attempt-scoped buffer. Secret values never enter Store, logs, metrics, audit or API
responses.

Every process also requires `NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST=sha256:<64 lowercase hex>`. The deployment
system must supply the verified OCI image digest; there is no application default. Configuration rejects a missing,
uppercase or malformed value before database or network initialization. The value is process metadata, is not stored
on notification rows, and is returned on every successful intake `202`, including idempotent replay.

## Failure Model

| Failure | Behavior |
|---|---|
| PostgreSQL unavailable | readiness false; intake 503; workers stop claiming; no fallback writes |
| commit rolled back | explicit retryable rejection with proven no state |
| commit outcome unknown | client/worker converges by idempotent re-query/retry rules |
| process crash after send | lease recovery records unknown result; at-least-once retry may duplicate |
| vendor transient failure | counted retry with bounded full-jitter |
| vendor permanent/policy failure | counted actual-result or non-counted pre-send `dead` |
| DNS/private/redirect violation | fail closed without second request |
| credential unavailable | no network; stable policy termination |

## Evolution Boundaries

Add worker concurrency or LISTEN/NOTIFY only when age/depth measurements justify it. Add vendor fairness when one
vendor saturates workers, retention/partitioning when table maintenance degrades, and stronger identity when a shared
IdP exists. Kafka, sharding and multi-region require measured need and new ADRs; multi-region also requires a T0
amendment.

## Document Status

This architecture and its four ADRs, OpenAPI, data model, threat model, runbook, test strategy, surface profile,
entity registry and traceability records passed independent review. Approval does not imply code, test, migration,
CI or deployment existence.
