# GS8-B Runner Lifecycle

The explicit `runner-server` composes four closed layers:

```text
private admission API
  -> PostgreSQL runner job/attempt/lease/receipt store
  -> scheduler with CAS and monotonic fencing
  -> sealed process supervisor
  -> existing TypeScript workflow runner over canonical JSONL
```

Go is the only writer for runner jobs, attempts, leases, cancellation controls, process sessions,
protocol events, receipts, and runner reconciliation records. TypeScript is the only JavaScript,
RunStore, checkpoint/resume, effect-approval, effect-execution, agent/provider, and budget writer.
Those tables and responsibilities are deliberately separate from the GS7-B observation namespace.

GS9-A freezes the future Workflow Control authority record but does not change this division. Its
run revision/CAS is independent from this runner attempt's lease and fencing token; neither can
substitute for the other. See
[`workflow-authority-contract-v2.md`](workflow-authority-contract-v2.md). GS9-A additionally
freezes an 18-kind `openslack.workflow_runner.v2` vocabulary containing all 12 v1 kinds plus six
added authority kinds. Its `hello` / `hello_ack` negotiation is contract-only; this runtime still
negotiates and executes only the GS8 v1 lifecycle. All Workflow Control writes remain
TypeScript-owned.

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

The ordinary `server` binary and its image entry point remain shadow-only. The separately packaged
`runner-server` starts only with exact enablement and all workspace, token, build, database, bundle,
and filesystem bindings.
