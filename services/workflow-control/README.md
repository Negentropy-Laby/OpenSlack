# Workflow Control

This module contains the GS7-A pure Go consumer of the TypeScript-owned Workflow Control v1
contract, the GS7-B PostgreSQL shadow observation service, the explicit GS8-B runner-lifecycle
control plane, the GS9-B default-off PostgreSQL authority qualification spine, the GS9-C
checkpoint/resume differential observer, and the GS9-D effect decision/audit differential
observer. It also contains the GS9-E1 budget operational contract mirror and the GS9-E2 default-off
PostgreSQL budget qualification authority, the GS9-F1 runner-v2 transport foundation, the GS9-F2a
authority-binding contract mirror, and the default-off GS9-F2b runtime-delivery qualification
profile. The six servers are separate entry points with separate configuration and authority
boundaries.

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
WORKFLOW_RUNNER_CONTROL_LEASE_DURATION_MS=<optional 60000..86400000; default 60000>
WORKFLOW_CONTROL_HEALTH_URL=http://127.0.0.1:8081/health/ready
```

The external bundle root is a closed directory containing exactly the reviewed manifest, a copied
`runner-node` executable, and the self-contained `workflow-runner-worker.cjs` entrypoint. The `.cjs`
suffix fixes CommonJS parsing at the file itself, regardless of an ancestor package's module mode. The
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

Stage the reviewed three-file bundle with
`bun scripts/qualification/workflow-runner-bundle.ts stage --bundle-root <absolute-root> --node-executable <absolute-node>`.
The sealed v1 and v2 workers reject `workflowSource: builtin` before any catalog path lookup; builtin
discovery remains available only to ordinary TypeScript composition paths.

The lease duration is a hard, immutable execution bound; heartbeats prove liveness but do not
extend it. The configuration is extension-only: operators running work that may exceed the
qualified 60-second default can select up to the frozen 24-hour protocol limit. Lease expiry still
uses the existing bounded cancellation and terminal-recording path.

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

## Explicit GS9-D effect shadow qualification mode

The image also contains `/effect-shadow-server`; the default entry point remains `/server`.
Without `WORKFLOW_CONTROL_EFFECT_SHADOW_MODE=local-qualification-v1`, the effect-shadow binary is
health-only and does not register observation or read routes. Explicit qualification requires a
loopback bind, database, exact service-build SHA-256, bearer-token SHA-256, workspace, and caller:

```text
WORKFLOW_CONTROL_EFFECT_SHADOW_MODE=local-qualification-v1
WORKFLOW_CONTROL_EFFECT_SHADOW_HTTP_BIND=127.0.0.1:8084
WORKFLOW_CONTROL_EFFECT_SHADOW_SERVICE_BUILD_SHA=<64 lowercase hex>
WORKFLOW_CONTROL_EFFECT_SHADOW_BEARER_TOKEN_SHA256=<sha256 of bearer token>
WORKFLOW_CONTROL_EFFECT_SHADOW_WORKSPACE_ID=<workspace id>
WORKFLOW_CONTROL_EFFECT_SHADOW_CALLER_ID=<caller id>
```

TypeScript remains the sole effect decision, approval, execution-claim, outcome, and audit writer.
It durably journals only the sanitized `approval_created`, `approval_decided`, and
`audit_recorded` projections after the owner-local transition. Go stores differential parity,
byte-exact receipts, matched decision/audit outbox evidence, and unknown-commit reconciliation in
the isolated `workflow_control_effect_shadow_*` namespace. Immutable 202 receipts are closed only
through the internal observer resolve route using the original envelope and idempotency key;
accepted closure evidence is stored separately, and `committedAt` denotes transaction acceptance
rather than an externally visible post-COMMIT instant. The outbox is read-only and cannot
publish, acknowledge, grant, or execute an effect; callers traverse it with the opaque keyset
cursor returned by each bounded page.

The API is frozen in `docs/api/effect-shadow-openapi.yaml`; the boundary and evidence ceiling are
documented in `docs/architecture/effect-shadow.md` and `docs/testing/gs9d-qualification.md`. This
batch does not activate runner v2, Go effect authority, routing, canary, production, release, or
TypeScript writer retirement.

## GS9-E1 budget operational contract mirror

The `budgetcontract` package embeds the byte-identical mirror of the TypeScript-owned
`workflow-budget-authority/v1` bundle. It validates closed account, reserve decision, provider
usage, settlement, ledger, exact receipt, and reconciliation records and replays the integer-only
token, `nano_usd`, and call folds. It is validator-only and cannot reserve, settle, authorize, or
persist a budget operation. Existing TypeScript floating-point cost estimates remain outside the
contract authority boundary.

GS9-E1 itself adds no migration, database repository, HTTP API, route, binary, container entry
point, runtime budget client, production worker configuration, runner-v2 delivery, routing, or
canary. GS9-E2 consumes the frozen mirror only inside its separate qualification process.

## Explicit GS9-E2 budget authority qualification mode

The image contains `/budget-authority-server`, but its default entry point remains `/server`.
Without `WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=local-qualification-v1`, the budget binary is
health-only and does not open PostgreSQL or register data routes. Explicit qualification requires:

```text
WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=local-qualification-v1
WORKFLOW_CONTROL_BUDGET_AUTHORITY_HTTP_BIND=127.0.0.1:8085
WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA=<64 lowercase hex>
WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256=<sha256 of bearer token>
WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID=<workspace id>
WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID=<caller id>
WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH=<positive integer>
WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH=<64 lowercase hex>
WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS=<canonical nonnegative int64>
WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD=<canonical nonnegative int64>
WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS=<canonical nonnegative int64>
```

The isolated store owns only qualification accounts, reservations, append-only ledger, exact
receipts, and reconciliation. Each durable record uses the Go-owned
`openslack.workflow_control_budget_durable_record.v1` companion envelope; its embedded frozen E1
record remains a non-authorizing TypeScript operational projection. The outer envelope binds the
qualification authority, writer, mode, build, E1 manifest, closed record kind, projection, and
projection domain hash while declaring `productionAuthority=false`. It locks and CAS-advances an
existing GS9-B running head while keeping account revision independent; it writes no Workflow
transition event and does not reuse the GS8 runner or GS9-C/D shadow tables. Same-key replay is
byte-identical, a different fingerprint conflicts, and an unprovable commit blocks the run through
durable reconciliation.
Because Runner v2 and its resume delivery are not present, this E2 qualification authority accepts
only `resumeGeneration=0`; a resumed run fails closed without creating budget evidence.
The account retains an immutable canonical genesis snapshot. Restart verification folds every
closed ledger kind from that anchor and requires byte/hash equality with the current account;
anchor or ledger drift, including a provider-attempt ledger/usage-receipt mismatch, fails closed.
Exact same-key replay is returned before active build and policy checks. Provider-outcome
reconciliation leaves its unresolved
reservation open and latches the run, while a settled reservation's `closedAt` equals its terminal
ledger timestamp. An open budget database-commit reconciliation also blocks the shared GS9-B run
writer, so another authority path cannot bypass ambiguity.

The closed API is frozen in `docs/api/budget-authority-openapi.yaml`. Architecture and qualification
requirements are in `docs/architecture/budget-authority.md` and
`docs/testing/gs9e-qualification.md`. The evidence ceiling is `GS9-E LOCAL_PASS / Go durable budget
qualification authority / Go production Workflow budget authority NOT_CLAIMED / Runner v2
NOT_DELIVERED / routing / canary / cutover NOT_ACTIVATED`. There is no production runtime budget
client, provider route, new-record canary, fallback, or TypeScript writer retirement.
The non-secret qualification seed initializes the first account only and is not accepted on the
HTTP wire. `WORKFLOW_BUDGET_PRODUCTION_INITIAL_POLICY_SOURCE NOT_DELIVERED` remains explicit.

## GS9-F2b runtime-delivery qualification

The `workflow-control-runner-v2-runtime-delivery-v1` profile requires schema 8, the existing v2
qualification switch, loopback network mode, and the separate runtime-delivery switch. It adds
durable authority-binding stage, resolution, event, receipt, control-delivery ACK, and
reconciliation records around the frozen runner-v2 and F2a bytes. The sealed TypeScript worker
remains the JavaScript, RunStore, checkpoint, effect, provider, and source-authority executor; Go
owns only runner lifecycle, the authority-binding coordinator, exact receipts, and the already
isolated E2 budget qualification ledger.

Checkpoint, effect, and resume events follow stage -> stage ACK -> source commit/point-read ->
resolution -> resolution ACK -> byte-identical runner event -> durable event receipt -> receipt ACK
-> optional decision -> decision ACK. Budget reserve and settle instead bind the exact prepared E1
request as resolution evidence, wait for the resolution ACK, commit/point-read the isolated E2
ledger, and only then emit the byte-identical runner event; the later reserve decision is checked
against that durable E2 result. An individual companion HTTP response loss is point-read with the
original idempotency key. Missing or drifted source evidence, lease/fence/head mismatch, process
loss with outstanding authority, or an unprovable control ACK latches reconciliation and never
chooses another key or locally replays a provider/effect.

This profile remains default-off and qualification-only. The default image entry point, production
v2 submission, new-record routing, canary, cutover, TypeScript writer retirement, release, and live
claims remain unchanged and outside GS9-F2b.

GS9-G adds an independently default-off new-record canary. Its authenticated binding endpoints expose
only non-secret workspace, caller, mode, epoch, build, capability, acceptance, and token-digest
bindings. Exact receipt replay remains available after new-record acceptance is disabled. Existing
Go-routed runs continue through their recorded active or drain epoch and never fall back to the
ordinary TypeScript writer. The TypeScript route journal is active-only bounded, retains sharded
closed replay evidence, quarantines damaged ordinary entries, and requires reconciliation for the
requested damaged run. This is canary qualification, not production activation or writer retirement.
