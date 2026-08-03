# Governance Control shadow and local authority service

This module contains the frozen GS4 governed-plan validator/read model and the
GS5 PostgreSQL shadow service plus the GS6 `governance-control-v2` local
authority candidate. The shadow service
durably receives exact canonical observation envelopes from the TypeScript
authority, independently recomputes record, confirmation, and audit parity,
and exposes a credential-free projection.

When the host enables the exact `local-qualification-v1` mode, plans whose new
route is `{backend: go, authority: governance-control}` use the Go service as
their sole durable writer. Accept and transition transactions atomically write
the persisted route, immutable record version, CAS head, append-only receipt,
authority event, and a pending authoritative-audit delivery. TypeScript remains
the planner, MCP/Qoder adapter, executor, and Collaboration audit sink; it must
not write a Go-routed governed-plan record after receiving a durable receipt.

The authority and evidence ceiling is strict:

- `@openslack/operator` remains authoritative for TS-routed records. Only an
  explicit, persisted GS6 route transfers record write authority to Go.
- The Go service accepts exact governed-plan records, never raw confirmation
  tokens, credentials, executable actions, or workflow commands.
- The PostgreSQL namespace is independent from the TypeScript governed-plan
  store. A matched Go projection is parity evidence, not source authority.
- The authority endpoints are disabled unless all exact local bindings are
  configured. Local qualification, an image build, and repository manifests do not claim a
  release, registry inclusion, live verification, or production readiness.

## Run locally

Use a dedicated PostgreSQL database, migrate it, then start the private HTTP
listener. `MIGRATION_DATABASE_URL` is optional; when absent it is derived from
`DATABASE_URL` with the `pgx5` scheme.

```bash
export DATABASE_URL='postgres://user:password@127.0.0.1:5432/governance_shadow?sslmode=disable'
export MIGRATION_DATABASE_URL='pgx5://user:password@127.0.0.1:5432/governance_shadow?sslmode=disable'
export MIGRATION_SOURCE="$PWD/migrations"
go run ./cmd/migrate

export GOVERNANCE_HTTP_BIND='127.0.0.1:8080'
export GOVERNANCE_NETWORK_MODE='loopback'
export GOVERNANCE_SERVICE_BUILD_SHA='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
go run ./cmd/server
```

To enable the GS6 authority surface for one loopback qualification binding:

```bash
export GOVERNANCE_AUTHORITY_MODE='local-qualification-v1'
export GOVERNANCE_AUTHORITY_WORKSPACE_ID='workspace.demo'
export GOVERNANCE_AUTHORITY_CALLER_ID='typescript:qoder-mcp'
export GOVERNANCE_AUTHORITY_ROUTING_EPOCH='7'
export GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS='true'
# Optional during rollback/drain; must be unique and exclude the active epoch.
export GOVERNANCE_AUTHORITY_DRAIN_EPOCHS='5,6'
go run ./cmd/server
```

`GOVERNANCE_NETWORK_MODE=internal` additionally permits private, link-local,
loopback, or wildcard IP-literal binds. Hostnames and public IPs are rejected.
The container uses `/migrations` by default and must run `/migrate` before
`/server`; startup fails closed unless schema version 2 is present and clean.
Authority mode is limited to loopback or the service's validated private
`internal` bind mode for isolated Docker qualification and is disabled by
default. Public IPs and hostnames remain rejected, and this mode has no remote
authentication or OAuth boundary. Accepting new Go records is a second, independently default-off gate.
Workspace, caller, an active or explicitly allowlisted drain epoch, and expected
service build headers must exactly match the host binding on every authority
GET and POST. Accept is limited to the active epoch; reads, receipts,
transitions, and audit acknowledgement may use a configured drain epoch only
when it also matches the record's persisted route. This permits old Go records
to drain after a higher-epoch `ts-local` rollback without routing new records to
Go.

## Rollback and drain

A governance-authority rollback is a new-record routing change, not a rescue or
data-migration operation for records already accepted by Go:

1. Start the higher-epoch MCP policy with `backend=ts-local` so only newly
   created plans return to the TypeScript writer.
2. Disable `GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS` and keep the former Go
   epoch in `GOVERNANCE_AUTHORITY_DRAIN_EPOCHS`.
3. Keep Governance Control, PostgreSQL, and the complete origin/build/caller/
   expiry transport available while every known Go-routed plan reaches a
   terminal or reconciled state and its pending audit delivery is recorded.
4. Retire the old epoch only after the point-read and Collaboration audit
   evidence agree. An outage blocks the affected plan IDs; it never authorizes
   TypeScript fallback, record copying, or effect replay.

The v1 authority deliberately has no unbounded plan-list route. TypeScript
enumeration returns only local and legacy plans, so it is not a total plan
count. Drain operations must retain the `planId` values from MCP receipts and
use the bounded record/pending-audit point reads plus Collaboration evidence.

## HTTP surface

- `POST /v1/shadow/governance/observations` requires one `Content-Type:
application/json` value, exact canonical JSON plus LF, and the deterministic
  `openslack.governance-shadow.v1.<sha256(exact-body-bytes)>` idempotency key.
  The 2 MiB body ceiling and 30 second request deadline are fail closed.
- `GET /v1/shadow/governance/plans/{planId}/projection` requires the bounded
  `X-OpenSlack-Workspace-ID` binding.
- `GET /health/live`, `/health/ready`, `/health/version`, and `/metrics` expose
  process, dependency, build, and low-cardinality telemetry evidence.

The GS6 surface uses exact canonical JSON plus LF. Mutation idempotency keys are
`openslack.governance-authority.v1.<sha256(exact-body)>`; the separate request
fingerprint also binds method, path, caller, workspace, routing epoch, expected
service build, and body. It exposes:

- `POST /v1/governance/plans:accept`
- `POST /v1/governance/plans/{planId}:claim-execution`
- `POST /v1/governance/plans/{planId}:complete-execution`
- `POST /v1/governance/plans/{planId}:cancel`
- `POST /v1/governance/plans/{planId}:expire`
- `POST /v1/governance/plans/{planId}:require-reconciliation`
- `GET /v1/governance/plans/{planId}` and
  `GET /v1/governance/receipts/{idempotencyKey}`
- `POST /v1/governance/plans/{planId}/authority-events/{acceptedRevision}:record`
  to move the transaction-created audit delivery from `pending` to `recorded`
  after the authoritative Collaboration sink succeeds.
- `GET /v1/governance/plans/{planId}/authority-events/{acceptedRevision}:pending`
  is a bounded point-recovery read for a locally known plan revision. It returns
  no record and treats recorded or absent deliveries as `404`; there is no list
  or claim surface.

Each plan has at most one pending authority-audit delivery, and its revision is
the current authority head. A transition is rejected until the prior revision's
delivery is recorded. This lets TypeScript recover a crash after the Go commit
but before its local audit journal prepare without scanning Go authority state.

Same-key/same-body requests return the durable original result. Same-key with
a different bound fingerprint, CAS loss, route drift, transition drift, or
immutable record drift fails closed. A response lost after commit is recovered
from the receipt; an unresolved commit returns `reconciliation_required` and
does not fabricate an accepted record.

The OpenAPI 3.1 document is in `docs/api/openapi.yaml`. TypeScript contract
bytes are mirrored exactly under `internal/contractmirror/generated/v1` and
`internal/contractmirror/generated/shadow/v1` and are checked against the
authoritative files in `packages/operator/contracts`.

Run the repository qualification wrapper with:

```bash
bash scripts/go-check.sh services/governance-control
```

For the isolated Go suite from this module directory:

```bash
GOWORK=off go test -race ./...
```
