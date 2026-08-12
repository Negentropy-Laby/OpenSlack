# Workflow Control

This module contains the GS7-A pure Go consumer of the TypeScript-owned Workflow Control v1
contract, the GS7-B PostgreSQL shadow observation service, the explicit GS8-B runner-lifecycle
control plane, the GS9-B default-off PostgreSQL authority qualification spine, and the GS9-C
checkpoint/resume differential observer. The four servers are separate entry points and have
separate configuration and authority boundaries.

The GS7-B service is observational only. It durably records exact TypeScript observations,
idempotency receipts, parity mismatches, and ambiguous commit outcomes. A mismatch advances the
source observation sequence but does not advance the matched projection head. The service exposes
only observation ingest, projection, health, version, and low-cardinality metrics routes.

The default `cmd/server` remains the credential-free observational service and never starts a
worker. The default-off `cmd/runner-server` owns only runner job admission, attempts, leases,
fencing, cancellation controls, process supervision, and protocol receipts. It launches one
externally SHA-256-anchored TypeScript worker bundle by direct argv, never a command supplied by an
HTTP request or job. `@openslack/workflows` still owns JavaScript execution, provider calls,
RunStore, checkpoints, resume, effect approval and execution, and budgets through GS8. GS9 alone
may transfer those records.

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

## Explicit runner control mode

The image also contains `/runner-server`, but its entry point remains `/server`; runner control
cannot start accidentally. A runner operator must override the entry point and supply all closed
bindings, including:

```text
WORKFLOW_RUNNER_CONTROL_ENABLED=1
DATABASE_URL=postgres://...
WORKFLOW_RUNNER_CONTROL_HTTP_BIND=127.0.0.1:8081
WORKFLOW_RUNNER_CONTROL_NETWORK_MODE=loopback
WORKFLOW_RUNNER_CONTROL_SERVICE_BUILD_SHA=<64 lowercase hex>
WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN_SHA256=<sha256 of bearer token>
WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID=<workspace id>
WORKFLOW_RUNNER_CONTROL_INSTANCE_ID=<supervisor prefix>
WORKFLOW_RUNNER_CONTROL_BUNDLE_ROOT=<absolute sealed bundle root>
WORKFLOW_RUNNER_CONTROL_BUNDLE_MANIFEST_SHA256=<64 lowercase hex>
WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT=<absolute workspace root>
WORKFLOW_RUNNER_CONTROL_DESCRIPTOR_ROOT=<absolute owner-only descriptor root>
WORKFLOW_CONTROL_HEALTH_URL=http://127.0.0.1:8081/health/ready
```

The external bundle root is a closed directory containing exactly the reviewed manifest, a copied
`runner-node` executable, and the self-contained `workflow-runner-worker.js` entrypoint. The
manifest's `runnerBuildHash` is the SHA-256 of that entrypoint and is recomputed at startup; extra
files, subdirectories, links, reparse points, or any byte drift fail closed. The health URL override
is required when the container entry point is changed to `/runner-server`, because the image's
shadow-only default listens on port 8080 while runner control defaults to port 8081.

Only Linux and Windows are admitted because those are the platforms with qualified parent-death
and process-tree termination behavior. One PostgreSQL advisory lock permits only one runner-server
for a workspace. Every boot receives a fresh supervisor identity so orphan recovery cannot confuse
a restarted process with its predecessor.

The runner API is private, bearer-authenticated, single-workspace, canonical JSON only, and defined
in `docs/api/runner-openapi.yaml`. It is an admission and inspection surface; workflow source,
arguments, prompts, credentials, arbitrary paths, arbitrary URLs, approval decisions, and budget
decisions are not accepted.

## Explicit GS9-B authority qualification mode

The image contains `/authority-server`, but its default entry point remains the observational
`/server`. Without `WORKFLOW_CONTROL_AUTHORITY_MODE=local-qualification-v1`, the authority binary
exposes only health, version, and metrics; mutation routes are not registered. The explicit mode
also requires an exact loopback bind, database, service-build SHA-256, bearer-token SHA-256,
workspace, caller, and positive routing epoch.

The qualification store owns only immutable route registration and the Workflow run
state/revision/phase/resume-generation spine. It commits the run head, append-only transition
event, byte-exact receipt, and outbox in one PostgreSQL transaction. It remains separate from the
GS8 runner job/attempt/lease/fence namespace and does not own checkpoints, approvals, effects,
budgets, active routing, CLI/MCP/Qoder reads, or TypeScript RunStore records. Its API is frozen in
`docs/api/authority-openapi.yaml`; its evidence ceiling is documented in
`docs/testing/gs9b-qualification.md`.

## Explicit GS9-C checkpoint shadow qualification mode

The image also contains `/checkpoint-shadow-server`; the default entry point remains `/server`.
Without `WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE=local-qualification-v1`, the checkpoint binary is
health-only and does not register observation or read routes. Explicit qualification additionally
requires a loopback bind, database, exact service-build SHA-256, bearer-token SHA-256, workspace,
and caller binding:

```text
WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE=local-qualification-v1
WORKFLOW_CONTROL_CHECKPOINT_SHADOW_HTTP_BIND=127.0.0.1:8083
WORKFLOW_CONTROL_CHECKPOINT_SHADOW_SERVICE_BUILD_SHA=<64 lowercase hex>
WORKFLOW_CONTROL_CHECKPOINT_SHADOW_BEARER_TOKEN_SHA256=<sha256 of bearer token>
WORKFLOW_CONTROL_CHECKPOINT_SHADOW_WORKSPACE_ID=<workspace id>
WORKFLOW_CONTROL_CHECKPOINT_SHADOW_CALLER_ID=<caller id>
```

TypeScript remains the only checkpoint-head, resume-generation, and artifact writer. It persists
the bounded artifact and canonical control head before it durably journals a credential-free
`checkpoint_commit` or `resume_advance` observation. The Go server recomputes parity in the
isolated `workflow_control_checkpoint_shadow_*` namespace and stores exact receipts and unresolved
commit evidence. A Go outage, mismatch, or reconciliation result cannot change or roll back the
TypeScript commit and cannot authorize resume. Artifact bytes never cross the observation wire.

The API is frozen in `docs/api/checkpoint-shadow-openapi.yaml`; the boundary and evidence ceiling
are documented in `docs/architecture/checkpoint-shadow.md` and
`docs/testing/gs9c-qualification.md`. This batch does not activate runner v2, Go Workflow
authority, routing, canary, approval/effect authority, durable budget authority, or production
cutover.
