# Governance Control shadow service

This module contains the frozen GS4 governed-plan validator/read model and the
GS5 `governance-control-v1` private PostgreSQL shadow service. The service
durably receives exact canonical observation envelopes from the TypeScript
authority, independently recomputes record, confirmation, and audit parity,
and exposes a credential-free projection.

The authority and evidence ceiling is strict:

- `@openslack/operator` remains the only governed-plan writer, confirmation
  authority, execution claimant, mutation dispatcher, and authoritative audit
  emitter.
- The Go service is an observer only. It accepts no raw confirmation token,
  credentials, executable action, workflow command, or mutation authority.
- The PostgreSQL namespace is independent from the TypeScript governed-plan
  store. A matched Go projection is parity evidence, not source authority.
- Local qualification, an image build, and repository manifests do not claim a
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

`GOVERNANCE_NETWORK_MODE=internal` additionally permits private, link-local,
loopback, or wildcard IP-literal binds. Hostnames and public IPs are rejected.
The container uses `/migrations` by default and must run `/migrate` before
`/server`; startup fails closed unless schema version 1 is present and clean.

## HTTP surface

- `POST /v1/shadow/governance/observations` requires one `Content-Type:
  application/json` value, exact canonical JSON plus LF, and the deterministic
  `openslack.governance-shadow.v1.<sha256(exact-body-bytes)>` idempotency key.
  The 2 MiB body ceiling and 30 second request deadline are fail closed.
- `GET /v1/shadow/governance/plans/{planId}/projection` requires the bounded
  `X-OpenSlack-Workspace-ID` binding.
- `GET /health/live`, `/health/ready`, `/health/version`, and `/metrics` expose
  process, dependency, build, and low-cardinality telemetry evidence.

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
