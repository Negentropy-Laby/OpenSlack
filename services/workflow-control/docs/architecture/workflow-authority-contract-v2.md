# GS9-A Workflow Authority Contract v2

GS9-A freezes the future Workflow Control authority record without moving that authority. The
current TypeScript RunStore, control paths, checkpoint/resume implementation, legacy run-gate
approval store, workflow-effect approval v2 store, effect execution path, and budget accounting
remain the sole writers and user-visible source. The Go service may validate and project the
exact-byte contract only. It has no GS9 PostgreSQL authority tables, write API, routing activation,
approval decision, budget decision, checkpoint commit, or resume authority in this batch.

Organization Graph normalization and Scenario graph loading are outside GS9-A. This contract is
only about Workflow Control state and its future TypeScript-runner-to-Go-control handoff.

## Independent concurrency identities

The v2 contract keeps three identities separate:

| Identity                                        | Scope                                                              | Meaning                                     |
| ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| Run `revision`                                  | one Workflow Control record                                        | CAS for semantic run-state mutations        |
| Runner `attemptId` / `leaseId` / `fencingToken` | one GS8 runner attempt and lease                                   | rejects stale worker processes and messages |
| Authority `routingEpoch`                        | future record admission policy plus one immutable per-record route | selects the writer before a run is created  |

A current runner fence does not satisfy `expectedRevision`, and a matching run revision does not
authorize a runner process. Heartbeats and lease renewal do not advance the run revision. Every
future runner-authored mutation must bind both the immutable authority route and the current
attempt/lease/fence, then independently win the run-record CAS.

The authority route is fixed before the first durable run record. A higher routing epoch may
select a different backend only for records that do not yet exist. It cannot move an existing run
between TypeScript and Go, and no request may fall back to another writer after an error or
timeout. GS9-A freezes this shape but activates no Go route; all current and new runs remain
TypeScript-authoritative.

## Two approval planes

The legacy run-gate plane and workflow-effect approval v2 remain different records:

- the legacy run gate controls whether a paused workflow may continue and retains its compatibility
  vocabulary;
- `openslack.workflow_effect_approval.v2` binds one exact effect, capability, workflow/run/input,
  business correlation, expiry, human decision, reason hash, revision, and audit projection.

Neither plane can be inferred from the other, from aggregate counts, from a runner message, or
from an event receipt. A future Go authority must persist and CAS them independently. A durable
effect decision is still not permission to execute until the exact decision is converted into a
separately bound execution grant and acknowledged at the runner boundary. GS9-A freezes that
`openslack.workflow_runner.v2` message shape and its exact-byte TypeScript/Go parity, but provides
no runtime negotiation, delivery, scheduler handling, or effect execution.

## Runner protocol v2 extension

The v1 bundle remains byte-stable. The v2 vocabulary contains 18 kinds: it retains all 12 v1
kinds and adds exactly these six closed kinds:

```text
checkpoint_commit
budget_reserve_request
budget_usage_report
budget_authorization
effect_authorization
resume_offer
```

Every leased v2 message binds `routingEpoch`, `runRevision`, `resumeGeneration`, `attemptId`,
`leaseId`, and `fencingToken` according to its closed schema. A `checkpoint_commit` message is a
request for the future authority commit; despite its name, it does not become committed until the
independent durable receipt is accepted or replayed as a duplicate. Likewise, authorization and
resume messages are inert contract records in GS9-A. The v2 `hello` / `hello_ack` negotiation
shape is part of the exact-byte freeze: `hello` advertises exactly ordered `[v1, v2]`, and a
v2-required `hello_ack` selects v2 without downgrade. The existing scheduler does not negotiate or
deliver v2.

The independent durable-receipt operation vocabulary is:

```text
run_transition
checkpoint_commit
budget_reserve
budget_settle
effect_authorize
resume_advance
```

Receipt validation and golden parity do not persist or apply any operation in GS9-A.

## Checkpoint commit point

A phase callback, checkpoint message, file write, or worker event is not itself a committed
checkpoint. The future commit point is the durable accepted or duplicate authority receipt for
one canonical checkpoint mutation whose `commitPoint` is exactly `after_phase_work`. That mutation
binds:

- workspace, run, immutable authority route, expected run revision, and resume generation;
- manifest, workflow source, input, phase identity, and phase ordinal;
- exact runner attempt, lease, fencing token, event identity, and request fingerprint; and
- bounded result/cache evidence hashes, never raw results, prompts, credentials, or provider data.

The checkpoint advances state `revision` exactly once. Same idempotency key and same fingerprint
must replay the original receipt; the same key with a different fingerprint conflicts without a
state change. A timeout near commit cannot be treated as permission to send the checkpoint again
under a new identity. If exact receipt lookup cannot prove the outcome, the record must stop in
`reconciliation_required`.

## Resume generation

`resumeGeneration` is a monotonic Workflow Control identity, not the GS8 attempt ordinal or fencing
token. A future resume claim binds the last committed checkpoint and run `revision`, the immutable
authority route, manifest/source/input identities, and the current runner attempt/lease/fence.
Winning that CAS increments the generation once; stale generations cannot checkpoint, decide,
consume budget, or complete the run.

Only a contiguous committed checkpoint prefix is resumable. Manifest, source, input, route, or
build drift fails closed. An open or unprovable effect, an unsettled budget reservation, an
ambiguous checkpoint, or an unknown terminal commit blocks automatic resume. The existing
TypeScript force-resume path remains outside the future Go authority and is not evidence of v2
resume correctness.

## Budget arithmetic

Budget authority is cumulative across worker restart and resume. Every durable budget quantity is
a canonical non-negative decimal string in the signed 64-bit range
`0..9223372036854775807`, matching a future PostgreSQL `BIGINT` without exposing a JSON number.
Money uses integer `nano_usd` at scale 9. Conversion from a non-negative decimal USD value uses
`half_up_nonnegative`; rounding occurs at the frozen conversion boundary, not by accumulating
binary floating-point values. Binary floating point is never a durable authority or
request-fingerprint input.

The future authority model separates reservation from settlement. A worker must receive a durable
reservation receipt before starting a budgeted provider call, and settlement must bind that exact
reservation plus usage evidence. Parallel reservations contend under the run CAS so their total
cannot exceed the remaining budget. A lost or ambiguous provider outcome cannot silently refund a
reservation; it remains conservatively charged or requires reconciliation according to the frozen
v2 rule. A rejected or reconciliation-required authorization carries zero authorized tokens, cost,
and calls, so it can never be interpreted as permission to spend. GS9-A validates these calculations
only and does not gate a provider call.

## Evidence ceiling

`GS9-A LOCAL_PASS` means only that the TypeScript-owned exact-byte v2 artifacts, generated Go
mirror, strict validators, transition/arithmetic functions, and golden vectors agree in local
qualification. It does not establish:

- a Go Workflow Control writer, PostgreSQL authority schema, durable acceptance, or user-visible
  Go read path;
- runner-protocol v2 runtime negotiation or delivery, checkpoint application, approval decision
  application, budget enforcement, or resume execution;
- new-record routing, canary, rollback activation, old-record migration, or TypeScript writer
  deletion; or
- authenticated Qoder Desktop, remote Connector, live effects, release, production readiness,
  review closure, or independent human approval.

GS9-B must add an isolated shadow and differential evidence before any read or write cutover. A
later new-record cutover must prove real PostgreSQL response loss, exact duplicate/conflict
behavior, restart/resume, checkpoint, approval/effect, budget, fencing, audit outbox, and explicit
higher-epoch rollback while preserving one writer per record.
