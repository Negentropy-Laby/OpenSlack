# GS8-B Runner Lifecycle

The explicit `runner-server` composes four closed layers:

```text
private admission API
  -> PostgreSQL runner job/attempt/lease/receipt store
  -> scheduler with CAS and monotonic fencing
  -> sealed process supervisor
  -> existing TypeScript workflow runner over canonical JSONL
```

At the GS8-B boundary, Go was the only writer for runner jobs, attempts, leases, cancellation
controls, process sessions, protocol events, receipts, and runner reconciliation records.
TypeScript was then the only JavaScript, RunStore, checkpoint/resume, effect-approval,
effect-execution, agent/provider, and budget writer. Those tables and responsibilities were
deliberately separate from the GS7-B observation namespace. The current GS9-I boundary is recorded
below without changing this frozen history.

GS9-A froze the future Workflow Control authority record but did not change that division. Its
run revision/CAS is independent from this runner attempt's lease and fencing token; neither can
substitute for the other. See
[`workflow-authority-contract-v2.md`](workflow-authority-contract-v2.md). GS9-A additionally
froze an 18-kind `openslack.workflow_runner.v2` vocabulary containing all 12 v1 kinds plus six
added authority kinds. GS9-F1 added a separate default-off qualification profile that negotiated v2,
persisted its foundation events and receipts, and invoked only injected qualification authority
ports. At that boundary, the default runtime still negotiated and executed the GS8 v1 lifecycle and
all production Workflow Control writes remained TypeScript-owned.

The scheduler allows one outstanding worker event. JavaScript starts only after the exact
`lease_accept` receipt is durable. A later fence rejects the old process. An expired unstarted
attempt can return to the queue only through durable exponential dispatch backoff, starting at
250 milliseconds and capped at 30 seconds. Launch failures, pre-execution crashes and lease
rejections share a five-failure ceiling; exhaustion becomes dead dispatch plus
`reconciliation_required`, never an infinite claim loop. An execution-started attempt is cancelled
and settled rather than automatically replayed. An open or unprovable effect boundary, or any
termination whose process exit cannot be proved, always converges to `reconciliation_required`.

Cancellation acknowledgement must bind the exact durable control record. A queued
`already_terminal` acknowledgement may follow its terminal event receipt, but it preserves the
receipt-proven terminal or reconciliation record; it cannot move that record back to cancelling.
Terminal events are accepted only from receipt-gated running or cancelling attempts.

The F1 v2 qualification worker used one FIFO receiptable lane. A heartbeat was emitted only while that
lane is idle. Cancellation aborts workflow execution immediately, queues its acknowledgement behind
any current event, and sends a sealed terminal only after the acknowledgement receipt. Uncertainty
delivering the terminal event's own receipt cannot overwrite a receipt-proven terminal; unresolved
domain authority or earlier control delivery remains reconciliation-required. Resume decisions mint
a new workflow resume identity while retaining the runner lease attempt on all envelopes.

The ordinary `server` binary and its image entry point remain shadow-only. The separately packaged
`runner-server` starts only with exact enablement and all workspace, token, build, database, bundle,
and filesystem bindings.

## GS9-F2a contract-only companion

The generated [authority-binding manifest](../../../../packages/workflows/contracts/workflow-runner-authority-binding/v1/manifest.json)
is the normative GS9-F2a boundary. It owns the closed operation facts, protocol sequence, source
locks, exact framing, and authority-ceiling inventories; this lifecycle document intentionally does
not duplicate them.

F2a did not alter this service's scheduler, worker, store, image entry point, active GS9-F1
profile, or source manifest. TypeScript remained the production Workflow authority, Go remained a
pure validator, and GS9-F2b was required to implement and qualify the manifest's not-delivered
runtime work.

## GS9-F2b default-off runtime delivery

Schema 8 adds the default-off qualification coordinator without changing the frozen runner-v1,
runner-v2, authority-v2, or F2a bytes. The normative ordering, replay, ACK deadline, cancellation,
source-evidence, expiry, and recovery rules live in the
[Workflow Control contract](../../../../docs/architecture/contracts/workflow-control.md#gs9-f2b-coordinator-delivery-boundary).
This service implements those rules but does not restate a second copy here.

Startup recovery validates the binding and ACK in one joined read, then bulk-CASes unfinished
bindings to reconciliation. Its examined/reconciled summary is consumed by the scheduler instead
of being discarded. Active owner-local journal evidence is indexed separately from closed replay
evidence; external identity drift forces a full validation before the cache is reused. GS9-G later
enabled explicit Go new-record routing. At the H boundary, GS9-H retired TypeScript new admission
while keeping the legacy implementation available only for authenticated drain/recovery pending the
separate GS9-I physical deletion below.

## GS9-I current execution boundary

GS9-I removes the runner-v1 TypeScript execution branch and the separate GS9-F1
qualification-only worker execution mode and environment. The packaged worker now starts only when
the complete runner-v2 runtime-delivery and Go run-authority bindings are present. It accepts only a
sealed descriptor whose immutable route is `go / workflow-control`; execute and resume both use the
Go recovery-projection store and authority-aware checkpoint, effect, and budget ports.

The public/full TypeScript RunStore writer and writer-shaped factory are removed. Ordinary readers
open only a bounded read-only view of TypeScript-historical evidence or Go recovery projections.
Frozen runner-v1 schemas, vectors, receipts, and old `ts-local` route records remain parseable
history through bounded compatibility parsers, but no worker, routing environment, or public API can
use them to mutate or resume a run.

This deletion adds no migration, converts no existing state, and activates no route or deployment.
Authenticated external regression, hosted exact-head qualification, review approval, merge,
production cutover, release, and live claims remain separate gates.
