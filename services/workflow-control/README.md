# Workflow Control

This module contains the GS7-A pure Go consumer of the TypeScript-owned Workflow Control v1
contract and the GS7-B PostgreSQL shadow observation service. It validates the closed observation
record, evaluates the frozen RunStore transition table, and projects a deterministic,
credential-free read model for cross-language differential qualification.

The GS7-B service is observational only. It durably records exact TypeScript observations,
idempotency receipts, parity mismatches, and ambiguous commit outcomes. A mismatch advances the
source observation sequence but does not advance the matched projection head. The service exposes
only observation ingest, projection, health, version, and low-cardinality metrics routes.

It has no worker, scheduler, lease, cancel, approval decision, budget decision, workflow execution,
resume, effect, routing epoch, or user-visible read authority. `@openslack/workflows` remains the
only RunStore writer and execution authority. GS8 owns the runner protocol, and GS9 owns any
authority cutover.

Run the module tests with the pinned repository toolchain:

```bash
GOWORK=off go test ./...
GOWORK=off go test -race ./... -count=5
```

For an isolated local PostgreSQL stack:

```bash
WORKFLOW_CONTROL_SERVICE_BUILD_SHA=$(git rev-parse HEAD) docker compose up --build
```

The listener is loopback-only by default. Container composition explicitly selects `internal`
mode while publishing the application port only on `127.0.0.1`. The API contract is frozen in
`docs/api/openapi.yaml`.
