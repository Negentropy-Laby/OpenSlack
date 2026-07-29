---
schema: openslack.document.v1
id: standard-go-service
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-07-30
sources:
  - docs/architecture/adr/adr-0002-multi-go-service-workspace.md
  - memory_bank/t2_execution/technical-preferences.md
  - services/notification-delivery/go.mod
  - services/notification-delivery/Dockerfile
  - .github/workflows/notification-delivery-service.yml
---

# Go Service Standard

This standard governs ADR-approved Go services in the OpenSlack repository. It
defines the creation and verification baseline without turning Notification
Delivery into a shared template or requiring capabilities a service does not
own.

## Module and Workspace Rules

- Each service owns `services/<name>/go.mod` and `go.sum`.
- The repository has no root `go.mod`.
- Root `go.work` is a reviewed developer aggregation, not release authority.
- Service CI and release jobs set `GOWORK=off` and assert that `go env GOWORK`
  returns the literal value `off` before build or test.
- `go mod tidy` runs inside one service module. Routine CI does not run
  `go work sync`.
- `go.work.sum` is committed only when the pinned toolchain generates required
  hashes; empty placeholder files are forbidden.
- A module enters `go.work` only with importable, tested behavior. A health-only
  shell is insufficient.
- Exact Go and dependency versions are pinned per module. Shared dependency
  versions are coordinated deliberately, not inherited from the workspace.

## Common Runtime Baseline

Every long-running service provides:

```text
closed, validated configuration
graceful startup and shutdown
structured allowlisted logging
bounded request and response sizes
GET /health/live
GET /health/ready
GET /health/version
GET /metrics
```

HTTP services publish OpenAPI 3.1 and contract-test the implementation against
it. Distributable containers use reviewed digest-pinned build and runtime
images, run as a non-root user, expose no undeclared port, include a read-only
root filesystem where compatible, and produce SBOM/provenance evidence before
a distribution claim.

Readiness proves required dependencies and schema state. Liveness does not
depend on remote systems. Version output identifies the exact build and
contract versions without exposing credentials or host-local paths.

## Package Shape

Use capability-oriented packages rather than an empty universal directory
template:

```text
services/<name>/
  go.mod
  go.sum
  cmd/server/
  internal/app/
  internal/<business-capability>/
  docs/api/openapi.yaml       when HTTP is exposed
  migrations/                 when durable schema is owned
  Dockerfile                  when an image is distributed
```

Business state machines remain pure where possible. The composition root owns
configuration, database, HTTP, workers, and shutdown wiring. Store packages
cannot silently become policy authorities, and transport packages cannot
invent actor, tenant, scope, or workflow decisions.

## Capability-Specific Controls

Apply these controls only when the service has the named capability.

### Ingest or Mutation

- Require `Idempotency-Key` when callers can safely identify one logical
  request.
- Bind each key to a strict canonical request fingerprint.
- Same key and same fingerprint returns the original durable receipt.
- Same key and different fingerprint returns conflict.
- Commit domain state, receipt, and required audit/outbox visibility in one
  PostgreSQL transaction.
- Use OCC or CAS for state transitions and reject stale revisions.
- A response lost after commit returns or discovers the original receipt; if
  commit status cannot be proven, enter `reconciliation_required`.

### Asynchronous Work

- Use leases with explicit ownership, expiry, and renewal.
- Bound attempts, delay, jitter, and total retry duration.
- Recover expired leases after restart.
- Represent exhausted or ambiguous work as dead or reconciliation state.
- Provide bounded inspect, preview, and execute recovery operations.

### Event Publication

- Persist state and publication intent transactionally.
- Publish at least once with stable event identity.
- Consumers deduplicate and preserve business correlation.
- Do not introduce Kafka, Redis, or a second queue until measured load or
  isolation requirements justify a separate ADR.

### Durable Database State

- PostgreSQL schema changes use versioned `golang-migrate` migrations.
- Startup fails closed on dirty, unknown, or incompatible schema versions.
- Immutable evidence or canonical payload rows are never updated in place.
- Head movement and record transitions use explicit revisions.
- Database roles and grants preserve package and authority boundaries.

### Public Network Boundary

- Require authenticated service or user principals.
- Derive tenant and scope server-side.
- Enforce rate, concurrency, body, record, and response limits.
- Require TLS and document OAuth/token rotation when applicable.
- Reject caller-provided fields that override host policy, actor identity,
  adapter selection, or approval authority.

## Canonical Data and Receipts

When byte parity or integrity is part of a contract, store and compare the exact
canonical bytes. Database-native JSON reserialization is a rebuildable query
index, not byte authority.

Receipts include:

```text
record identity
accepted revision
authority and routing epoch
request fingerprint or integrity binding
correlation identity
durable outcome
reconciliation state when needed
```

No caller receives an accepted receipt before its transaction commits.

## Verification

The common module gate is:

```bash
go mod tidy
git diff --exit-code -- go.mod go.sum
test -z "$(gofmt -l .)"
go build ./...
go vet ./...
go test -race ./...
```

Repository verification runs the reviewed container wrapper with the pinned Go
image and `GOWORK=off`. It uses Docker named caches and never writes a module
cache into the repository.

Add capability checks:

| Capability        | Additional evidence                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------ |
| PostgreSQL        | Migration up/down policy, real database integration, rollback and restart, race repetition |
| HTTP              | OpenAPI validation, contract tests, image build, container health smoke                    |
| Prometheus        | Metrics contract and `promtool` validation where rules/config exist                        |
| Worker            | Lease expiry, duplicate, crash recovery, bounded retry, dead/reconciliation                |
| Distribution      | SBOM, provenance, digest pinning, deterministic build inputs                               |
| Authority cutover | Differential fixtures, canary, routing epoch, rollback, single-writer audit                |

Pure packages do not start PostgreSQL. Database tests use an isolated Docker
network, container DNS, unique database/schema/volume names, and deterministic
cleanup. Verification does not read `.env`, PEM, key, credential, or secret
files.

## Evidence and Claims

Record local, CI, image, deployment, authenticated external, release, and human
approval evidence separately. A passing local wrapper does not establish
hosted CI. A green service CI does not establish deployment, runtime admission,
Qoder Desktop qualification, `QODER_VERIFIED`, release, or production
readiness.

New service work must not modify Notification Delivery's existing stage,
batch, review archive, or service history. Reused patterns are requalified for
the new service and do not inherit its acceptance evidence.
