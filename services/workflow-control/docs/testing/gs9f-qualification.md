# GS9-F1 Foundation and GS9-F2a Contract Qualification

GS9-F1 qualifies only the frozen Workflow Runner v2 admission/storage, negotiation, and
receipt-before-decision transport foundation plus a local opaque-call ordering seam. It
does not deliver the real checkpoint, TypeScript effect, budget, or resume adapters and does not
activate production v2 submission or routing.

GS9-F2a is the contract-only first half of the GS9-F2 umbrella. It freezes the exact-byte
`openslack.workflow_runner_authority_binding.v1` family with closed `_stage.v1`, `_resolution.v1`,
`_receipt.v1`, and `_error.v1` schemas and a pure Go validator mirror. It does not deliver the F2b
database, migration, HTTP, scheduler, worker,
checkpoint, effect, budget, resume, provider, recovery or runtime composition.

The reviewed local gate is:

```bash
bash scripts/go-check.sh services/workflow-control
```

The focused F2a local contract gates are:

```bash
bun run workflow:runner-authority-binding-golden -- --check
bunx vitest run packages/workflows/src/__tests__/workflow-runner-authority-binding-contract.test.ts
(cd services/workflow-control && go test -race ./runnerbindingcontract -count=1)
```

The service config must select
`workflow-control-runner-v2-foundation-v1`. Its mechanical repository gate is a strict superset of
GS7-B, GS8-B, and GS9-B/C/D/E and runs:

- frozen runner-v1 and authority-v2 parity checks without modifying their source bytes;
- exact ordered `[v1, v2]` negotiation, v2 selection, old-worker and capability rejection, and no
  downgrade;
- job/attempt/lease/fence plus route/build/epoch/run-revision/resume-generation foundation binding
  checks;
- event and exact receipt persistence plus receipt delivery before the later domain-decision
  boundary is exposed;
- exact replay, conflict, stale fencing, response loss, and PostgreSQL restart for the foundation
  records;
- local reserve-before-fetch and settle-after-receipt ordering around an opaque provider call,
  without propagating or binding provider/model/run identity into E authority;
- PostgreSQL restart using one retained qualification schema; and
- built-image evidence that the default `/server` process does not submit or route v2 work.

The hosted exact-head workflow runs the service exactly once through the workspace-wide
`go-check --all` verifier after the GS9-E budget gate. Windows additionally rebuilds the sealed
worker and runs the native descriptor, reparse-point, process-tree, worker, and session boundaries.

Because F2a changes a Red-zone workflow, its hosted exact-head contract gate separately locks three
ordered steps before the existing checkpoint/effect/runtime gates:

1. verify the authority-binding generated bundle with
   `bun run workflow:runner-authority-binding-golden -- --check`;
2. run the focused TypeScript contract suite; and
3. run `go test -race ./runnerbindingcontract -count=1` in `services/workflow-control`.

These steps prove closed schemas, canonical bytes, the six source-manifest plus two F1 `000007` SQL
locks, positive/negative vectors, operation/phase closure, independent coordinator and
source-authority heads, and TypeScript/Go parity. The six operations are `checkpoint_commit`,
`effect_authorize`, `effect_complete`, `budget_reserve`, `budget_settle`, and `resume_advance`;
every operation orders `stage_event` before
the source authority commit/prepared evidence and `commit_authority`. The frozen runner-v2 event
may be sent only after the exact resolution ACK; Go then consumes the resolution to mutate the
coordinator/global head. The coordinator/global deltas are `+1/0`, `+1/0`, `0/0`, `+1/0`, `+1/0`,
and `+1/+1`, respectively, for `runRevision/resumeGeneration`. A source authority receipt remains
evidence inside the binding and never substitutes for the coordinator/global receipt.

The receipt schema also closes `control_delivery` ACKs. Every ACK binds the exact control event,
kind, sequence, digest and active attempt/lease/fence. Golden and negative vectors lock the full
stage ACK -> resolution ACK -> event -> event receipt -> delivery ACK -> optional decision ->
delivery ACK -> advance sequence, including response loss and cross-splice rejection.

Passing these gates establishes at most:

```text
GS9-F1 FOUNDATION LOCAL_PASS
runner v2 admission/storage/negotiation transport foundation
runner v2 runtime delivery NOT_CLAIMED
checkpoint/effect/budget/resume adapters NOT_DELIVERED
production v2 submission NOT_ACTIVATED
production v2 routing / canary / cutover NOT_ACTIVATED
TypeScript production Workflow authority retained
```

Passing the F2a gates establishes at most:

```text
GS9-F2A CONTRACT LOCAL_PASS
TypeScript-owned exact authority-binding contract
Go exact mirror validator only; durable authority false
runtime profile and service source manifest remain GS9-F1
migration 000008 / database / HTTP / runner wiring NOT_DELIVERED
checkpoint/effect/budget/resume runtime adapters NOT_DELIVERED
runner v2 end-to-end runtime delivery NOT_CLAIMED
production v2 submission / routing / canary / cutover NOT_ACTIVATED
TypeScript production Workflow authority retained
```

It does not establish complete receipt-to-checkpoint/effect/budget/resume decision ordering,
crash-after-authority recovery, or Go production Workflow, checkpoint, effect, budget-policy,
provider, RunStore, or user-visible read authority. GS9-F2b must deliver those runtime adapters and
their exit gates. In particular, F2b must add durable recovery/replay and result disambiguation for a
staged authority event; F1 keeps that state fail-closed and cancellation cannot manufacture
clearance. F2b must also measure the current 250 ms silent-session cancellation polling load and
latency before production routing. Authenticated external-host, Qoder, remote Connector, live,
release, tag, npm, and production readiness also remain outside this evidence. Hosted checks,
review-thread resolution, independent human approval and merge state are separate gates and cannot
be inferred from local contract parity.
