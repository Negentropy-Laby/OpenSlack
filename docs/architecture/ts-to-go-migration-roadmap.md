---
schema: openslack.document.v1
id: architecture-ts-to-go-migration-roadmap
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-07-30
sources:
  - docs/architecture/architecture.md
  - docs/architecture/adr/adr-0002-multi-go-service-workspace.md
  - docs/architecture/contracts/organization-graph.md
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

### GS2 — Projector Shadow

The Go Software Delivery projector consumes the same typed source snapshot as
the TypeScript authority and compares canonical bytes, identities, integrity,
completeness, and warnings. Contract-to-Delivery follows only after Software
Delivery parity is stable. The shadow cannot independently read GitHub,
Workflow, CRM, or ERP authority.

### GS3 — Organization Graph Read Cutover

MCP first mirror-reads TypeScript and Go while returning TypeScript results.
Then a bounded scenario or tenant canary selects Go without per-request
fallback. Finally Go owns Graph head, query, and explain reads while TypeScript
continues producing Snapshots through durable ingest receipts.

The `12 / 16 / 17` MCP profiles, tool names, schemas, result envelope, Skill,
and approval boundaries remain unchanged. Cursor issuer changes use an epoch
and TTL drain, not implicit cursor translation.

### GS4–GS6 — Governance Control

Freeze the runtime governed-plan contract under
`.openslack.local/operator/governed-plans`, shadow plan and confirmation state,
then move Qoder mutation acceptance to Go receipts. The project Memory Bank is
not part of the runtime plan store and grants no mutation authority to the Go
service.

### GS7–GS9 — Workflow Control

Move durable run, checkpoint, lease, approval, and budget state to Go while the
JavaScript/TypeScript runner remains responsible for workflow code and agent
calls. The worker protocol is versioned and reports effects through durable
receipts.

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
