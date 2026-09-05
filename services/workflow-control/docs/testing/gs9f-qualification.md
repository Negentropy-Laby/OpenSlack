# GS9-F1 Foundation, GS9-F2a Contract, and GS9-F2b Runtime Qualification

This file retains the reviewed GS9-F qualification gates as historical exact-head evidence. GS9-I
does not rewrite the frozen runner-v1, runner-v2, authority-v2, or F2a contract artifacts.

At the F1 boundary, GS9-F1 qualified only the frozen Workflow Runner v2 admission/storage, negotiation, and
receipt-before-decision transport foundation plus a local opaque-call ordering seam. It
does not deliver the real checkpoint, TypeScript effect, budget, or resume adapters and does not
activate production v2 submission or routing.

GS9-F2a is the contract-only first half of the GS9-F2 umbrella. Its generated
[authority-binding manifest](../../../../packages/workflows/contracts/workflow-runner-authority-binding/v1/manifest.json)
is the normative source for contract identity, operation facts, source locks, framing, and the
complete authority ceiling.

The reviewed local gate is:

```bash
bash scripts/go-check.sh services/workflow-control
```

The focused F2a local contract gates are:

```bash
bun run workflow:contract-families -- --check
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

Because F2a changes a Red-zone workflow, hosted exact-head CI runs the registry-driven Workflow
contract-family check once, includes the binding TypeScript suite in the reviewed
`workflow-runner*.test.ts` set, and includes the Go mirror in `go-check.sh --all`. The registry,
generated shell inventory, and generated Workflow Control `.dockerignore` marker are checked as one
closed inventory; no dedicated GS9-F2a step may drift from that inventory.

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

Passing the F2a gates establishes exact TypeScript/Go contract parity only. The manifest's
`notDelivered`, `notActivated`, `notClaimed`, and `separateGates` arrays are the complete,
machine-checked ceiling; qualification prose must not maintain a second negative-claim list.
GS9-F2b must deliver recovery/replay, result disambiguation, runtime adapters, and its measured
cancellation gate before any of those entries can change.

The budget-decision repair vectors additionally prove that an accepted E1 reserve result is the
only source of a sequence-4 budget authorization: `reserved` carries the requested amounts,
`rejected` carries zero, and both bind the exact Go durable-receipt envelope, its E1 operational
projection, and the accepted run revision. An E1
database-unknown receipt instead produces a reconciliation-required event receipt and no budget
decision. Cross-spliced prepared requests, decisions, ledgers, receipts, statuses, amounts, hashes,
or revisions must be rejected identically by TypeScript and Go.

## GS9-F2b runtime-delivery gate

The F2b service profile is `workflow-control-runner-v2-runtime-delivery-v1`. Its local gate is a
strict superset of F1/F2a and additionally requires the exact named `TestGS9F2*` tests, PostgreSQL
schema-8 migration guards, restart recovery, race execution, and the default-off image smoke. The
TypeScript gate covers the real worker composition in addition to contract/session fakes:

```bash
bun run test -- \
  packages/workflows/src/__tests__/workflow-runner-authority-binding-runtime.test.ts \
  packages/workflows/src/__tests__/workflow-runner-v2-effect-authorization.test.ts \
  packages/workflows/src/__tests__/workflow-runner-v2-session.test.ts \
  packages/workflows/src/__tests__/workflow-runner-worker.test.ts
(cd services/workflow-control && go test -race ./internal/runnerstore/postgres ./internal/runnerscheduler ./cmd/runner-server -count=1)
bash scripts/go-check.sh services/workflow-control
```

Qualification must cover all six binding operations, first resume `0 -> 1`, exact budget reserve
source-result point-read, settle evidence, event-receipt and decision ACK response loss, restart,
process crash after source commit, cancellation before/after the event receipt, lease/fence/route/
revision/generation drift, cross-binding splice, and downgrade rejection. No named test may be
missing or skipped.

The ACK gate must also prove notification-before-registration recovery, database point-read after a
lost notification, an ACK that arrives after thirty seconds but before the lease/job hard deadline,
and true hard-deadline expiry. Startup recovery must report and consume its examined/reconciled
summary, use a query count independent of the number of recovered bindings, and preserve exact
replay of closed evidence. Admission request/receipt schema and golden parity are generated in the
authority-binding family and replayed by both TypeScript and Go.

Passing establishes at most:

```text
GS9-F2b RUNTIME DELIVERY LOCAL_PASS
default-off checkpoint/effect/budget/resume authority adapters delivered
TypeScript production Workflow authority retained
production v2 submission and routing NOT_ACTIVATED
routing / canary / cutover / writer retirement NOT_ACTIVATED
authenticated external / release / live NOT_CLAIMED
```

PostgreSQL 18, built-image, hosted exact-head CI, review-thread resolution, and independent human
approval remain distinct evidence. A local older PostgreSQL run or a credential-free source test
must not be reported as those gates.

## GS9-G new-record canary gate

GS9-G adds a separate default-off `new-record-canary-v1` authority mode. Qualification must prove
the authenticated runner/authority binding preflight before any route receipt or accept side effect,
exact receipt replay after acceptance is disabled, active and drain epoch conflict classification,
and response-loss point-read. The worker must reject a Go descriptor in qualification-only mode and
reject a TypeScript descriptor in Go-authority mode.

The route journal counts only active explicit routes toward its 4,096 bound. Qualification covers
flat-v1 migration, atomic publish, terminal close, closed replay, quarantine isolation, damaged-target
reconciliation, identity drift, and audit-first repair. Recovery tests must prove that a missing local
projection is rebuilt only for safe created/running authority heads, that paused/resuming state remains
operator-visible in the same route-aware namespace, and that terminal/output ambiguity never re-runs
workflow or effect code. Real PostgreSQL restart, Windows ACL/reparse behavior, and the built image are
hosted exact-head gates.

## GS9-H TypeScript read-only recovery gate

GS9-H required the public package, CLI, TUI, rehearsal scripts, and authenticated runner HTTP surface
to reject TypeScript create/resume/control composition before a descriptor, route, or store mutation.
The former rollback configuration must fail closed. A non-initializing receipt lookup must leave flat,
damaged, and partitioned journal evidence untouched. Go inspection may report authority state only from
an authenticated durable head that agrees with the immutable receipt; local recovery projections are
drift evidence only. At the H boundary, legacy worker/parser code remained temporarily for
drain/recovery pending GS9-I.

## GS9-I TypeScript writer deletion gate

GS9-I source and package gates must prove all of the following:

- the package root exposes neither the full `RunStore` writer and its writer options nor a
  writer-shaped workflow projection factory;
- ordinary CLI/library readers receive only `openWorkflowRunReadOnly`, and attempted directory,
  write, append, or atomic-replacement operations fail before changing local evidence;
- direct TypeScript execute/resume composition is absent; the internal execution adapters require a
  Go recovery-projection store plus checkpoint and effect authority ports;
- the packaged worker has no runner-v1 execution branch and no GS9-F1 qualification-only execution
  mode; retired enablement variables cannot activate either path;
- the only executable worker configuration requires complete runner-v2 runtime-delivery and Go run
  authority bindings, and accepts only `go / workflow-control` descriptors; and
- old `ts-local` receipts remain parseable as historical evidence while new TypeScript route commits,
  resume, or writer selection fail closed.

The focused TypeScript regression covers the public source boundary, read-only RunStore adapter,
routing config, execution client, Go projection, worker configuration, and run/resume behavior. The
existing frozen-contract and Go runner suites remain required because deletion must not change their
contract bytes, bounded compatibility parsers, or Go authority behavior.

Passing these local gates establishes only physical TypeScript writer deletion for the tested head.
It performs no migration or data conversion, selects no routing epoch, and activates no deployment.
Authenticated external regression, hosted exact-head checks, review approval, merge, production
cutover, release, and live status remain separate evidence.
