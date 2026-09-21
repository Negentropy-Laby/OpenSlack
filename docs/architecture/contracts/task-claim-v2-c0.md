---
schema: openslack.document.v1
id: architecture-task-claim-v2-c0
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: github-task-loop
updated: 2026-09-21
sources:
  - design/cdd/modules/github-task-loop.md
  - docs/architecture/control-manifest.md
---

# Task Claim v2 — C0 Contract and Migration Boundary

## Status and Separation

**PLANNED: C0 specification only. Implementation and qualification: NOT_RUN.**
This independent workstream selects Go/PostgreSQL as the future claim
authority. It does not change the existing GitHub Task Loop writers, deploy a
service, create a database or migrate records in PR #418. Earlier Git-backed
strong-claim proposals are historical alternatives, not this target design.

The Permit-only cleanup broker does not depend on Claim v2 completion. Its
task reference identifies the administrator-approved scope; it is not evidence
of a current claim, claimant or unexpired lease. Neither a task ref nor a
well-formed legacy comment can be relabeled as a v2 ownership attestation.

## C0 Contract Deliverables

- Pin repository numeric identity, Issue identity and task identity; define a
  versioned task-definition digest over requirements, execution scope,
  capabilities and risk. Label/heartbeat timestamps remain separate lifecycle
  projections. Changing substantive requirements invalidates the binding;
  normal lifecycle projection updates do not.
- Bind every claim to a non-reusable claim epoch, authenticated principal
  (registry/runtime/run/provider), task digest, state, lease deadline and
  monotonic revision. Distinguish claim ID, lease epoch, record revision and
  authority generation; none substitutes for another. Define active and
  terminal states explicitly.
- Specify transactionally enforced one-winner claim and exact epoch/revision
  preconditions for heartbeat, release, expiry and repair. A stale owner cannot
  renew or terminate another epoch; expired leases cannot be resurrected by a
  retry. Database time and ownership validation belong to the authority.
- Specify idempotency keys and durable request/outcome observations. After
  ambiguous responses, reconcile the original operation before further writes;
  do not retry a destructive transition against a newly observed epoch.
- Define terminal records and retention so release/expiry cannot erase the
  evidence needed to distinguish later claims. A projection cannot overwrite
  authoritative state. Unknown version, missing identity or unavailable
  authority fails closed.
- Define the read-only observer separately from mutation endpoints. Its
  evidence binds task, subject, epoch/revision and observed lease validity;
  it is not a permanent execution ticket. Consumers revalidate at their own
  authority boundary and retain cross-system race limitations.

C0 records exact API/schema/error contracts and migration acceptance criteria
before a later implementation task starts. This document establishes required
semantics, not a shipped wire protocol or approved SQL migration.

## Proposed v2 Record and Operation Contract

The C0 candidate record schema is `openslack.task_claim.v2`. Objects are closed:
unknown fields, duplicate JSON keys, missing required fields and malformed
Unicode are errors. Integers that can grow over a service lifetime are canonical
non-negative decimal strings, never JavaScript numbers. Epoch and revision
start at `"1"`; leading zeros and numeric JSON representations are rejected.

| Required field | Contract |
| --- | --- |
| `claimId` | Authority-generated unique identifier for this acquisition; never reused. |
| `task` | Workspace ID, provider `github`, host, stable repository ID, Issue node ID/number, task ID, definition schema and full SHA-256 definition digest. |
| `holder` | Authenticated principal ID, runtime UID and run ID, derived from the service session and compared with request expectations. |
| `authority` | Backend `go`, activation generation and routing epoch. A restored database alone cannot activate a generation. |
| `claimEpoch` | Persistent task-slot reassignment counter; increases on each new acquisition, not heartbeat. |
| `revision` | Monotonic task-slot transition counter; increases on every accepted transition, including heartbeat and terminal state. |
| `state` | `active`, `closing`, `completed`, `released`, `expired` or `revoked`. |
| `phase` | `executing`, `awaiting_review` or `awaiting_dependency`; review phase is not human approval. |
| `issuedAt`, `renewedAt`, `expiresAt` | Authority UTC timestamps; request timestamps cannot extend validity. Expiry is exclusive. |
| `policyRevision`, `lastOperationId` | Exact governing policy revision and last committed transition identity. |

The stable task slot and its epoch/revision survive terminal transitions and
reacquisition. They are not deleted when a claim is released. Immutable claim
versions, operation receipts, events, execution reservations and projection
outbox entries belong to the same PostgreSQL transaction as the slot change.

All mutation requests bind an operation ID before sending, the task identity,
definition digest, authority generation/routing epoch and expected slot
revision. Operations on an existing lease additionally bind claim ID, epoch
and holder. Authentication supplies the actual holder; body fields cannot
create it. Acquisition also supplies the expected terminal/empty-slot state.

| Operation | Required condition and effect |
| --- | --- |
| `acquire` | Eligible task and authorized session; empty/terminal slot with no unresolved operation. New claim ID and epoch; one winner. |
| `heartbeat` | Exact live active claim and revision; renew within authority policy TTL. No revival of expired/revoked claims. |
| `set_phase` / `submit` | Exact active lease, allowed phase transition and artifact binding; no implicit human approval. |
| `release` / `complete` | Exact current claim and settled operations; completion additionally requires policy delivery evidence. Write terminal state. |
| `expire` | Authority time at/after expiry and expected unchanged revision; heartbeat racing it cannot also win. |
| `revoke` | Authorized administrator, expected current generation/slot revision; outstanding execution is frozen for reconciliation. |
| `repair` | Rebuild projections from authoritative records or reconcile operation receipts; never mint ownership from comments. |
| `observe` / `get_operation` | Authenticated read of current state or original receipt; no mutation and no reusable execution authorization. |

Same operation ID and canonical request digest returns the original receipt;
same ID with different request returns `OPERATION_CONFLICT`. It does not
revalidate and perform a second mutation. Distinct operations against a stale
revision return `REVISION_CONFLICT`. Additional closed error codes are
`UNAUTHENTICATED`, `SUBJECT_MISMATCH`, `TASK_INELIGIBLE`,
`DEFINITION_CHANGED`, `CLAIM_NOT_CURRENT`, `LEASE_EXPIRED`, `CLAIM_REVOKED`,
`AUTHORITY_NOT_ACTIVE`, `UNSETTLED_OPERATION`, `EVIDENCE_UNAVAILABLE` and
`RECONCILIATION_REQUIRED`. Clients do not convert any of these to a legacy
write or retry against a newly observed revision automatically.

## Definition Digest and Execution Admission

Retain `issue_task_snapshot.v1` unchanged as the observation/reread snapshot.
Introduce `openslack.task_definition.v1` with an explicit closed projection:
stable task/repository/Issue identity, Issue title, requirement prose, parsed
manifest goal/scope/acceptance/output contract, required capabilities and risk
constraints, allowed/forbidden paths, and substantive labels. Include unknown
non-lifecycle labels conservatively; do not ignore all labels.

The manifest's lifecycle `status`, owner/heartbeat observations, comments and
Issue `updated_at` are excluded from this definition. Only the exact governed
lifecycle-label set is excluded: `openslack:ready`, `openslack:claimed`,
`openslack:running`, `openslack:review`, `openslack:done`, `openslack:blocked`.
Their current values and Issue open/closed state are still checked separately
for admission. Manifest parsing must use the existing strict task parser;
ambiguous multiple fences or unsupported fields fail closed. C1 must freeze
shared TS/Go canonical-byte fixtures before implementing hash production; C0
does not silently replace the current hash helper.

Meaningful definition changes invalidate new execution admission and require
review/replanning. They do not silently rebind the old lease to changed work.
The authoritative policy decides whether an operation needs Permit alone or
Permit plus Claim. Having a valid Claim never grants cleanup permission.

The execution broker checks the live claim and permit, records a one-use
execution reservation, and fences stale claim/authority generations at the
side-effect boundary. External credentials remain there, not in workers.
Database atomicity covers this authority's records only, not a GitHub ref or
Permit service transaction. A possibly sent operation cannot be released for
re-execution; it must first reconcile its external result. A child agent needs
an explicit delegated identity/scope, not the parent's run ID.

## Implementation Sequence and Ownership

1. C1: Pure state kernel, injected clock, canonical fixtures and operation receipts.
2. C2: `services/task-control/` PostgreSQL transactions and authenticated sessions;
   reuse service transaction/outbox patterns, not unauthenticated caller headers.
3. C3: Broker admission, reservations, credential confinement and stale-worker fencing.
4. C4: Migrate tick, watch, heartbeat, review, completion, repair, CLI and Graph/TUI.
5. C5: Concurrent acquisition, ABA, lost responses, expiry, restart and backup recovery.
6. C6: Single-repository cutover with old-writer denial proven before new admission.
7. C7: Independently reviewed old-write retirement, historical reads retained.

GitHub remains authoritative for task business facts; Go/PostgreSQL alone owns
the admitted lease slot. Local `FileClaimBroker` retains its local purpose and
does not become remote evidence by relabeling its records. Restoring a backup
requires a fresh authority activation; old leases/consumed permits cannot
become executable merely because an old database says `active`.

## Migration and Writer Fence

Inventory claim/heartbeat/release/expire/repair producers, automated tick and
watch clients, CLI lifecycle operations, task synchronization and observers.
The migration plan must name the authority for each admitted scope and the
administrator-controlled fence that prevents old binaries or credentials from
writing that scope. A new reader or a version warning is not a writer fence.

Before cutover: stop old admission, drain or explicitly reconcile admitted
work, establish and negatively test the old-writer fence, then enable a bounded
new scope. No simultaneous Git and PostgreSQL authoritative writes and no
silent legacy-comment conversion or historical digest reinterpretation.
Legacy records remain separately identified and read-only to v2 consumers.

Rollback closes new admission first, drains/reconciles in-flight operations,
preserves v2 records and read-only observation, and leaves the old writer
fenced. Deleting v2 fields, reverting to unconditional ref writes or clearing
terminal evidence is not a rollback procedure. Destructive migrations and
deployment changes require a separate reviewed implementation deliverable.

## QA Layers and Required Future Evidence

All rows are **PLANNED / NOT_RUN** for Claim v2; legacy regression success is
not v2 evidence.

| Layer / classification | Required cases and evidence |
| --- | --- |
| Contract / API | Strict schema, unsupported versions, principal/task/digest mismatch, missing authority and bounded error vocabulary; explicit zero mutation on rejected observations. |
| Auth / Permission | Forged comments/refs cannot mint ownership; stale epoch/run cannot heartbeat/release/repair; old writer credentials cannot modify the newly admitted scope. |
| Workflow / Concurrency | Concurrent claim has one winner; expiry versus heartbeat is atomic; duplicates preserve one operation; lost response reconciles without taking over a new epoch. |
| Data / Migration | Normal label changes do not drift task definition; real requirement changes do; old records unchanged; no dual writers; terminal history retained; restart restores exact state. |
| Ops / Recovery | Authority/database restart, unavailable database, expired credentials, interrupted cutover, close-admission/drain rollback and repair of unknown outcomes. |
| Hosted compatibility | Same candidate Linux/Windows consumer checks and Go/PostgreSQL integration; old-client refusal without field stripping. |
| Isolated qualification | Administrator-provisioned principals and writer fence, actual concurrent clients, durable evidence and restart/rollback observations. Local fixtures do not prove this layer. |
| Governance | Independent contract/security review, effective human approval and PRMS delivery, each reported separately from CI and release. |

Evidence must identify candidate SHA, schema/configuration versions, operation
and claim epoch/revision, redacted state transitions and test layer. Do not
record credentials or raw sensitive task content. C0 is complete only when its
contracts, producer/consumer inventory, migration/fencing protocol and QA plan
are independently reviewed; this does not mark the v2 implementation complete.
