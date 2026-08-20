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
added authority kinds. GS9-F1 adds a separate default-off qualification profile that negotiates v2,
persists its foundation events and receipts, and invokes only injected qualification authority
ports. The default runtime continues to negotiate and execute the GS8 v1 lifecycle. All production
Workflow Control writes remain TypeScript-owned.

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

The v2 qualification worker uses one FIFO receiptable lane. A heartbeat is emitted only while that
lane is idle. Cancellation aborts workflow execution immediately, queues its acknowledgement behind
any current event, and sends a sealed terminal only after the acknowledgement receipt. Uncertainty
delivering the terminal event's own receipt cannot overwrite a receipt-proven terminal; unresolved
domain authority or earlier control delivery remains reconciliation-required. Resume decisions mint
a new workflow resume identity while retaining the runner lease attempt on all envelopes.

The ordinary `server` binary and its image entry point remain shadow-only. The separately packaged
`runner-server` starts only with exact enablement and all workspace, token, build, database, bundle,
and filesystem bindings.

## GS9-F2a contract-only companion

GS9-F2 is split into two sequential batches. F2a freezes only the exact-byte
`openslack.workflow_runner_authority_binding.v1` companion family and its pure Go
`runnerbindingcontract` validator. F2b later composes durable staging, authority ports, recovery and
end-to-end runner delivery. F2a does not modify this scheduler, worker, store, profile, image entry
point or service source manifest.

The closed companion contains `stage`, `resolution`, `receipt`, and `error` records for six
operations: `checkpoint_commit`, `effect_authorize`, `effect_complete`, `budget_reserve`,
`budget_settle`, and `resume_advance`. A future runtime must complete `stage_event` before
the source authority commit or prepared authority evidence, then durably ACK the matching
`commit_authority` resolution before the worker sends the byte-identical frozen runner-v2 event.
Go then consumes that resolution while mutating the coordinator/global head and issuing the runner
event receipt. The phase receipts are distinct and bind exact phase bytes; neither a source
authority receipt nor a runner event receipt can stand in for the coordinator/global receipt.

The receipt union also closes the runner-to-control `control_delivery` ACK. It binds the exact
control event, kind, sequence and digest plus the active attempt/lease/fence. The runtime order is
stage ACK -> resolution ACK -> runner event -> event receipt -> delivery ACK -> optional decision
-> delivery ACK -> advance; any missing or cross-spliced ACK remains unresolved.

The coordinator/global revision deltas are `+1/0` for checkpoint commit, effect authorization,
budget reserve and budget settlement; `0/0` for effect completion; and `+1/+1` for resume advance,
expressed as `runRevision/resumeGeneration`. `sourceAuthority` expected and accepted heads remain a
separate revision plane. Every route/build/epoch, job, active attempt/lease/fence, event,
operation, source request/result and exact-byte hash must agree across the two phases.

F2a source-locks the six existing runner-v1, authority-v2 (including runner-v2), checkpoint,
effect-control, effect-shadow and budget manifest SHA-256 values plus both F1 migration `000007`
SQL hashes, but does not mutate them. The locks are contract-source identity, not runtime build
identity. The contract names `workflow-control-runner-v2-runtime-delivery-v1` for F2b but does not
register it. No migration `000008`, database, HTTP, scheduler, worker, checkpoint, effect,
budget, resume or provider adapter is delivered here. The service continues to select
`workflow-control-runner-v2-foundation-v1`; production v2 submission/routing and all F2 runtime
claims remain disabled or unclaimed until F2b. The evidence ceiling is
`GS9-F2A CONTRACT LOCAL_PASS / Go exact mirror validator only / runtime authority delivery
NOT_CLAIMED`. Hosted exact-head checks, authenticated external-host qualification, production Go
Workflow/checkpoint/effect/budget/provider/RunStore/read authority, new-record acceptance, canary,
cutover, TypeScript fallback or writer removal, Qoder, remote Connector, review resolution,
independent human approval, merge, release, live, tag, npm and production readiness remain separate
and are not claimed.
