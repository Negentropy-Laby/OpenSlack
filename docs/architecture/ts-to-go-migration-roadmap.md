---
schema: openslack.document.v1
id: architecture-ts-to-go-migration-roadmap
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-08-04
sources:
  - docs/architecture/architecture.md
  - docs/architecture/adr/adr-0002-multi-go-service-workspace.md
  - docs/architecture/contracts/organization-graph.md
  - docs/architecture/contracts/governance-control.md
  - docs/architecture/contracts/qoder-mcp.md
  - design/cdd/workstreams/organization-graph/README.md
  - design/cdd/workstreams/qoder-work/README.md
  - memory_bank/t2_execution/go-service-standard.md
---

# TypeScript-to-Go Durable Services Migration Roadmap

## Purpose

This roadmap moves selected durable backend responsibilities from the
TypeScript monorepo into independently qualified Go services. It does not
replace the OpenSlack product architecture, convert every package to Go, or
upgrade any release, Desktop, live, or approval claim.

The target split is:

```text
TypeScript
  Qoder Skill
  CLI and TUI
  Operator planner
  JavaScript Workflow DSL and runner
  provider adapters

Go
  Organization Graph durable store and query
  Repository Observer
  Governance Control
  Workflow Control
  Agent Execution Supervisor
  remote MCP Gateway
```

Local TypeScript STDIO MCP remains supported. A future Go Streamable HTTP MCP
Gateway is a separate remote productization path.

## Invariants

1. Every durable object has one authority writer in each routing epoch.
2. Shadow results cannot affect user responses, authoritative state, approval
   state, or external side effects.
3. A process boundary returns success only after durable acceptance is proven.
4. Ambiguous mutation completion enters reconciliation instead of blind retry.
5. Scenario Packs remain declarative; executable implementations are registered
   by a sealed host catalog.
6. Pack discovery remains bounded and process-lifetime cached; file hot reload
   is outside this roadmap.
7. OpenSlack confirmation, Workflow effect approval, Qoder permission, and
   GitHub human review remain distinct decisions.
8. Local qualification, authenticated Qoder Desktop qualification,
   `QODER_VERIFIED`, live deployment, release, and human approval remain
   separate evidence levels.
9. Removing a TypeScript writer, migrating existing state, and switching
   production authority are separate reviewed changes.

## Migration Gates

| Gate                          | Purpose                                           | Required exit evidence                                                                                         |
| ----------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| G0 Contract Freeze            | Freeze the current authority contract             | Schemas, state machine, errors, canonical/hash algorithms, limits, golden vectors, and authority owner         |
| G1 Go Shadow                  | Compute or store the same input without authority | Isolated namespace and proof that shadow output cannot affect users or writes                                  |
| G2 Differential Qualification | Compare authoritative and shadow behavior         | Historical, failure, randomized, and boundary fixtures with no blocking difference                             |
| G3 Read Cutover               | Move read-only surfaces first                     | Stable parity, explicit routing epoch, bounded canary, and tested rollback                                     |
| G4 New-record Routing         | Route only newly created records                  | Persisted `backend`, `routing_epoch`, and `authority`; old records remain on their original writer             |
| G5 Durable Acceptance         | Transfer mutation ownership                       | Transactional receipt; the previous writer stops after accepting that receipt                                  |
| G6 Canary                     | Exercise a bounded authority slice                | Restart, duplicate, conflict, response-loss, database-failure, credential-rotation, and version-drift evidence |
| G7 TS Read-only Recovery      | Retire routine writes                             | TypeScript retains only inspect, import, reconcile, and recovery paths                                         |
| G8 Delete TS Writer           | Remove superseded mutation code                   | Authenticated external qualification plus separate state-migration and production-cutover evidence             |

Hash, identity, cursor, state-machine, error-code, receipt, CAS, or audit
differences block advancement. Per-request silent fallback is forbidden because
it hides authority drift; rollback selects an explicit prior routing epoch.

## Delivery Sequence

### GS0 — Governance and Verification Foundation

1. Adopt the independent-module workspace ADR.
2. Register the T2 Go service standard and update technical preferences.
3. Add root `go.work`, the containerized module verifier, and isolated CI in a
   separate Red Zone change.

GS0 changes no runtime authority and does not modify the 0.2.0 release gates.

### GS1 — Organization Graph Shadow Service

The first Go service freezes and mirrors the existing Organization Graph
canonical JSON, identity, integrity, cursor, query, explain, Snapshot, and
Delta contracts.

GS1-A adds a tested pure Go parity library and generated contract mirrors.
GS1-B adds an isolated PostgreSQL shadow store. Canonical payload bytes are
stored as `bytea`; optional `jsonb` indexes are rebuildable and never become
hash authority. Snapshot and Delta rows are immutable, and head movement uses
an expected-cursor plus revision CAS. TypeScript commits remain authoritative
and non-blocking; same-process stores serialize publication per root/scenario,
while the bounded HTTP adapter idempotently retries only transition-order
`404`/`409` races within one total timeout.

GS1-C qualifies duplicate, conflict, response-loss, restart, rollback,
corruption, size-bound, and schema-version behavior. Throughout GS1 the
TypeScript projector and `LocalGraphStore` remain the only user-visible
authorities.

The GS1-C gate drives the production HTTP composition against PostgreSQL for
initial Snapshot, duplicate replay, full-Snapshot CAS, Delta, and bounded query
readback. It also injects a successful commit whose response is lost, verifies
durable receipt recovery, restarts the PostgreSQL container while retaining its
volume, reconnects through a new pool, and proves the same receipt and head
survive. Negative qualification covers incompatible migration rows, corrupted
canonical bytes and metadata, same-cursor/different-byte conflicts, transaction
rollback, and an exact 10,000-node/25,000-edge graph plus an over-limit request.
Query cursors support one bounded previous verification secret during rotation;
only the active secret signs newly emitted cursors. Versioned
`openslack.graph_shadow_observation.v2` backlog observations report the actual
TypeScript dispatch queue or `unknown`, never an invented zero or unchecked
caller-supplied number.
These gates do not create a Go read authority, a Qoder cutover, or a release,
live, or production claim.

### GS2 — Projector Shadow

GS2-A freezes the TypeScript Software Delivery projector as the calculation
authority and generates a closed, exact-byte contract bundle containing the
typed source schema, historical and deterministically randomized inputs, valid
results, and fail-closed error results. The pure Go shadow consumes only those
typed source bytes, recomputes the full Snapshot, and compares canonical bytes,
integrity, node and edge identities, completeness, and warnings. Missing,
incomplete, and `demo_fixture` classifications remain observable rather than
being promoted to current authority.

The generated contract manifest binds the schema, vectors, limits, algorithms,
and authority declaration by SHA-256. TypeScript and Go tests independently
replay the same checked-in mirror, so drift in either implementation or in the
generated files fails qualification. GS2-A does not add an HTTP route, a store
write, a Qoder path, or any user-visible read cutover; TypeScript remains the
only calculation and local read authority.

GS2-B follows the merged GS2-A parity gate and freezes the TypeScript
Contract-to-Delivery composite projector as the calculation authority. Its
closed bundle embeds the frozen Software Delivery source schema and adds the
typed `demo_fixture` business batches, 16 deterministic randomized inputs,
promotion boundaries, unresolved-bridge degradation, ordering, exact
per-family bounds, and fail-closed errors. The pure Go shadow first validates
and projects the nested Software Delivery source through the already-qualified
Go package, then recomputes the composite Snapshot and compares canonical
bytes, integrity, node and edge identities, completeness, warnings, and error
metadata against 43 TypeScript-generated vectors.

GS2-B adds no HTTP route, store writer, Scenario catalog entry, MCP routing, or
Qoder read path. TypeScript remains the sole calculation and user-visible read
authority. No GS2 shadow independently reads GitHub, Workflow, CRM, ERP, the
environment, or the wall clock; every input remains composition-injected.

### GS3 — Organization Graph Read Cutover

MCP first mirror-reads TypeScript and Go while returning TypeScript results.
Then a bounded scenario or tenant canary selects Go without per-request
fallback. Finally Go owns Graph head, query, and explain reads while TypeScript
continues producing Snapshots through durable ingest receipts.

The `12 / 16 / 17` MCP profiles, tool names, schemas, result envelope, Skill,
and approval boundaries remain unchanged. Cursor issuer changes use an epoch
and TTL drain, not implicit cursor translation.

GS3 is split into three independently reviewed changes:

1. **GS3-A mirror-read** is implemented as an explicit CLI composition option. After a successful
   local TypeScript query or explanation, MCP sends the same canonical input to the fixed Go HTTP
   read route, compares all bounded result fields, appends a digest-only Collaboration observation,
   and still returns the isolated TypeScript result. The mirror is off by default, accepts only an
   exact loopback origin unless private/link-local `internal` mode is explicitly selected, and has
   closed timeout, response-size, strict-JSON, content-type, redirect, and difference-code bounds.
   Cursor presence or token drift is a mismatch, not an accepted translation. Audit, transport,
   response, or parity failure never changes the returned result.
2. **GS3-B canary** is implemented as a default-off, process-immutable CLI policy. It binds the
   canonical workspace/tenant, at most 16 exact scenario-instance IDs, one positive routing epoch,
   a maximum seven-day expiry, and exactly one backend. `go` additionally binds an exact
   credential-free loopback/private origin and 64-hex service build on every request. A selected Go
   timeout, HTTP error, invalid response, stale snapshot, policy expiry, build/epoch drift, or audit
   failure blocks the read and never falls back to TypeScript. The Go envelope's snapshot time must
   pass the same bounded freshness gate as the TypeScript path before the result or served audit is
   released. Rollback is a new explicit policy using
   `backend=ts-local` and a higher epoch. Go query cursors remain five-minute HMAC tokens; canary
   tokens use v2 and bind the routing epoch, while v1, expired, or cross-epoch tokens return explicit
   mismatch/expired errors without translation. Unselected scenarios remain TypeScript-authoritative.
3. **GS3-C read authority** is implemented as a separate, explicit process policy after the merged
   mirror and canary gates. It selects every canonical scenario for one tenant, positive routing
   epoch, bounded expiry, exact Go origin, and service build. TypeScript remains the deterministic
   projector but reports publication success only after the dedicated authority ingest route returns
   an exact durable `accepted` or `duplicate` receipt. `202 reconciliation_required`, transport,
   conflict, or malformed receipt fails publication closed. Go owns the durable Graph head and all
   MCP query/explain reads while the policy is active; those routes use v2 epoch-bound cursors and
   require a redacted Collaboration audit before releasing a result. Mirror, bounded canary, and
   global authority cannot be composed together. Rollback is a new global `ts-local` policy with a
   higher epoch, not a per-request fallback. Authority publication never dual-writes the local
   recovery store: operators must reproject current bounded source evidence into that store and
   verify fresh local reads before activating the higher epoch. Missing or stale recovery evidence
   remains blocked and audited rather than being served as a rollback.

GS3-B transfers read authority only for the exact selected scenario instances while its policy is
active. It adds no Go write authority, default or full read cutover, Graph-head ownership transfer,
implicit cursor translation, authenticated Desktop evidence, remote Connector, release, live, or
production claim.

GS3-C transfers only the local Organization Graph projection head/query/explain authority under an
explicit activation policy. It does not transfer projector calculation, Scenario Pack execution,
source-system mutation, Qoder identity, workflow approval, GitHub review, remote Connector, live,
release, or production authority.

### GS4–GS6 — Governance Control

GS4 freezes the runtime governed-plan contract under
`.openslack.local/operator/governed-plans`. GS5 adds a separate PostgreSQL Go
shadow for TypeScript-authored record, confirmation, and audit observations.
Its closed envelope binds `authority: typescript`, workspace, plan, and a
TypeScript-issued `sourceSequence`; exact canonical bytes determine the
idempotency key and a method/path/source/body binding determines the request
fingerprint. Confirmation observations carry only the presented token hash and
current binding hashes. Raw confirmation capabilities never cross the shadow
boundary.

The GS5 shadow recomputes state, confirmation, audit, and correlation parity,
persists immutable observations and receipts, survives PostgreSQL and process
restart, and exposes bounded internal health, version, metrics, observation,
and projection routes. Its result is observational: shadow failure, mismatch,
or reconciliation cannot change the TypeScript response, runtime record,
approval state, audit decision, or action effect. `@openslack/operator` remains
the only writer, compiler, confirmation authority, execution claimant, mutation
dispatcher, and audit emitter for the legacy route.

GS6 adds the first durable writer transfer, limited to newly created governed
plans whose immutable route is exactly `go / governance-control`. Missing
route remains the legacy `ts-local / typescript` authority. The route persists
`backend`, positive safe-integer `routingEpoch`, and `authority`; one record
never changes route. A higher epoch can select the new-record policy, including
`ts-local`, while previously accepted Go records continue to drain through Go.
Go origin, build, caller, and read transport therefore remain available during
rollback; rollback does not make TypeScript a second writer for old Go records.
The Go host defaults to `accept-new-records=false`. Activation explicitly selects
one active epoch and may list bounded older drain epochs. Only the active epoch
with `accept-new-records=true` accepts a new record; authority read, receipt,
transition, and audit operations may use active or drain epochs only when the
request matches the record's persisted route. Rollback disables new acceptance
before adding the former active epoch to the drain allowlist.

TypeScript continues compiling the canonical plan, validating the one-time
token and current bindings, dispatching reviewed actions, and projecting audit.
Go alone accepts and transitions a Go-routed record with expected-revision CAS.
TypeScript stops local durable writes for that record only after validating an
exact accepted or duplicate receipt. Timeout, response loss, malformed receipt,
or an unproven commit enters reconciliation and never falls back to the local
writer or replays an effect blindly.

The GS6 contract is separate from GS4 governed-plan v1 and GS5 shadow v1. It
freezes exact accept and per-transition paths, canonical LF request bytes,
body-only idempotency, path/header/body request fingerprints, immutable route,
durable success receipts, unknown-outcome receipts, and authority reads. A
success receipt carries the committed record. An unknown receipt carries only
the requested target revision/state/hash and a reconciliation token; it cannot
invent a committed revision or record.

The GS6 hosted cross-language gate runs the production agent-bound MCP command
and composition over the official SDK against a real Go authority backed by an
isolated pinned PostgreSQL instance. Preview, confirmation, terminal Go read,
immutable route evidence, the exact 16-tool catalog, and zero local
governed-plan records must all appear in one strictly decoded closed receipt.
This proves the new-record single-writer handoff at the local/hosted integration
boundary; it does not broaden the authority or evidence levels below.

Each GS6 Go mutation commit also creates one pending audit delivery in the same transaction. Go
allows at most one pending delivery per plan, binds it to the current authority-head revision, and
blocks the next transition until that delivery is recorded. Restart recovery never asks Go for an
unbounded queue: it scans the bounded local immutable route sidecars, strictly reads the current
plan, then point-reads the exact current revision through
`GET /v1/governance/plans/{planId}/authority-events/{revision}:pending`. The strict response omits
the record and state, binds only pending status, original authority mutation operation, route,
record hash, workspace/plan/revision, and service build, and is sufficient to reconstruct the
reviewed audit event from the separately validated record. Missing or already recorded delivery is
the same `404`; route drift and invalid bindings fail closed. A later revision therefore cannot
hide an older pending delivery, making the current-revision point read complete. This closes
process-stop recovery without a second plan writer, blind acknowledgement, or new list authority.

The project Memory Bank remains outside every runtime plan store. GS6 does not
establish authenticated Qoder Desktop, `QODER_VERIFIED`, remote Connector or
OAuth, live deployment, release, production activation, old-record migration,
or TypeScript writer deletion.

### GS7–GS9 — Workflow Control

Move durable run, checkpoint, lease, approval, and budget state to Go while the
JavaScript/TypeScript runner remains responsible for workflow code and agent
calls. The worker protocol is versioned and reports effects through durable
receipts.

GS7-A first freezes a closed, bounded Workflow Control contract and exact-byte
golden bundle. TypeScript remains the sole RunStore writer, runner, approval and
effect authority, resume implementation, and user-visible read source. A pure,
importable Go module may validate records, evaluate the frozen RunStore status
table, and project a credential-free read model; it has no store, HTTP route,
database, worker, lease, command, approval, effect, or routing authority.

The contract records current limitations rather than converting them into
promises. In particular, production runs currently initialize at `running`,
some control paths bypass the RunStore transition method, status and checkpoint
writes have no shared revision/CAS, pause and stop do not durably abort the
workflow body, budget is not durably cumulative across resume, and there is no
workflow lease or fencing implementation. Raw arguments, prompts, results,
approval details, capabilities, decision evidence, transcripts, credentials,
commands, and provider payloads cannot cross the parity boundary.

GS7-B adds a separate PostgreSQL observational shadow without changing the GS7-A
bytes or the TypeScript authority. A default-off TypeScript port emits a closed,
credential-free observation and its TypeScript projection into an owner-only
journal after an authoritative write. The Go service recomputes the projection,
records exact-body idempotency receipts and semantic mismatch evidence, advances
only its observation sequence on mismatch, and exposes private observation,
matched-projection, health, version, and low-cardinality metrics routes. Unknown
commit outcomes become durable reconciliation receipts rather than success or a
workflow retry. Legacy/truncated manifest identities and incomplete effect or
budget evidence are skipped with bounded diagnostics rather than fabricated.

GS7-B adds no worker, scheduler, lease, cancellation, approval decision, budget decision, effect
execution, routing epoch, user-visible read source, or authority cutover. Its final exact head has
passed hosted PostgreSQL, response-loss, restart, concurrency, corruption, OpenAPI, Prometheus,
distribution, cross-language, review-thread, and independent-human-approval gates and is merged.
Those results qualify the observational shadow only; they do not promote it to runtime authority.

GS8-A freezes the closed `openslack.workflow_runner.v1` JS runner protocol, exact-byte schemas,
message/idempotency/receipt algorithms, cross-language vectors, object ownership, and GS9
exclusions. GS8-B implements the default-off lifecycle path: Go owns runner job admission,
attempts, leases, fences, cancellation controls, process supervision, and durable protocol
receipts; the sealed TypeScript child still owns JavaScript execution, agents, effects, and every
GS9-deferred record. Its closed bundle contains exactly the manifest, a copied Node executable and
one self-contained JavaScript entrypoint whose bytes define `runnerBuildHash`. Accepted workflow
source is also a closed single-file execution unit: runtime imports are rejected in this GS8 path
without changing the existing CLI loader. The private runner API is a separate binary, requires
exact workspace and bearer bindings, and is absent from normal CLI composition. Jobs contain only
descriptor and content hashes; neither the wire nor HTTP can choose a command, module path, raw
arguments, URL, or environment. Unknown effect outcomes stop in reconciliation and are never
replayed automatically. Pre-execution launch, crash, and lease-rejection failures use a durable
bounded backoff and a five-failure dead/reconciliation ceiling; an unproven process termination is
also reconciliation evidence, not permission to requeue.

GS9-A first freezes a separate Workflow Control authority v2 contract and exact-byte TypeScript/Go
mirror. Run-record revision/CAS remains independent from GS8 runner attempt/lease/fencing;
authority routing epoch remains independent from both. The freeze also keeps legacy run-gate and
`openslack.workflow_effect_approval.v2` as separate approval planes, defines the durable receipt as
the checkpoint commit point, introduces a monotonic resume generation, and locks cumulative budget
decimal/rounding semantics without using binary floating point as authority input. The exact-byte
freeze includes an 18-kind `openslack.workflow_runner.v2` vocabulary: all 12 v1 kinds remain and
the six additions are `checkpoint_commit`, `budget_reserve_request`,
`budget_usage_report`, `budget_authorization`, `effect_authorization`, and `resume_offer`. Durable
budget quantities are canonical non-negative decimal strings bounded by signed 64-bit `BIGINT`;
money is integer `nano_usd` at scale 9 with `half_up_nonnegative` conversion. The v2 `hello` /
`hello_ack` negotiation contract is frozen, but no runtime negotiation or delivery exists.
TypeScript remains the sole writer, so `GS9-A LOCAL_PASS` does not claim Go authority.

GS9-B adds the default-off PostgreSQL authority spine but does not transfer a real record. The
qualification-only service fixes one loopback workspace, caller, epoch, build, and bearer; its
immutable epoch/run route, expected-head CAS, append-only event and exact receipt, transactional
outbox, response-loss lookup, and reconciliation record are isolated from `workflow_runner_*`.
Same-key replay preserves the original receipt bytes. Unknown commit cannot advance the head, and
an unprovable reconciliation commit fails with a stable non-2xx error. The normal image remains on
the observational server and reports TypeScript authority with routing and new-record acceptance
disabled.

GS9-C adds the first post-phase checkpoint/resume differential without transferring Workflow
authority. The legacy `ctx.phase()` remains a phase-entry marker; a new awaited checkpoint commit
persists bounded artifact bytes and a TypeScript-owned canonical control head before journaling a
credential-free observation. Resume generation advances only under that control head and only for
an opaque attempt/lease/fence binding produced after an advancing GS8 lease receipt. Separate
`checkpoint_commit` and `resume_advance` observations carry hashes and bounded identities but no
artifact, input, prompt, provider, approval, credential, transcript, or path content.

The v1 resume form includes the pre-checkpoint case: the prior checkpoint is null and the next
phase is exactly `phase-0`. New accepted leases may repeat this state until phase 0 commits; later
resume observations remain bound to the latest committed checkpoint.

The default-off Go service uses a fourth isolated namespace,
`workflow_control_checkpoint_shadow_*`, to recompute parity and retain exact receipts and
reconciliation. It never writes the TypeScript head, participates in resume, extends runner v1, or
reuses the GS8 runner or GS9-B authority tables. Qualification must cover response loss, restart,
duplicate replay, fingerprint conflict, concurrency, phase order, repeated resume, stale fence,
source/manifest/input drift, artifact corruption, mismatch latch, and default-off composition.
The evidence ceiling remains `GS9-C LOCAL_PASS / Go authority NOT_CLAIMED`.

GS9-D and later stages may transfer only new Workflow Control records after approval/effect,
cumulative budget, runner-v2 delivery, immutable routing, durable acceptance, canary, and explicit
higher-epoch rollback gates. Existing TypeScript records continue to drain under TypeScript; an
existing record never changes writer and there is no per-request fallback. A runner message or
durable receipt is never itself an approval decision.

### GS10–GS13 — Platform Runtime

1. Repository Observer owns webhook and poll intake, normalization, dedupe,
   cursor, and outbox while GitHub mutations and PRMS remain TypeScript.
2. Remote MCP Gateway adds Streamable HTTP, OAuth, tenant binding, rate limits,
   and correlation without owning Graph or Workflow state.
3. Agent Execution Supervisor owns process and worktree leases, timeouts,
   cancellation, resource enforcement, transcript transport, and health while
   model adapters remain workers.
4. Repository Governance is migrated only if measured authority-split costs
   justify its elevated GitHub and approval risk.

## Batch and PR Governance

Each GS sub-batch starts from the latest merged `main`, uses one feature branch
and one bot-authored PR targeting `main`, and records risk zone, validation,
rollback, and evidence ceiling. Stacked branches cannot substitute for a merged
dependency.

Every push is verified against the remote branch SHA, PR head SHA, and checks
head. Unresolved review conversations, CODEOWNER rules, and PRMS remain
independent gates. Agents never approve their own work. Human approval is
required wherever repository policy requires it.

## Completion Evidence

The migration is complete only when every selected service has:

- a frozen and versioned contract;
- differential evidence appropriate to its behavior;
- one durable authority writer per record;
- explicit routing and rollback epochs;
- restart, duplicate, conflict, response-loss, and dependency-failure evidence;
- independent module and deployment qualification;
- authenticated external evidence where the service crosses that boundary;
  and
- a separately reviewed TypeScript writer retirement.

`LOCAL_PASS` or green CI alone cannot prove authenticated Desktop, live,
release, or human-approval completion.
