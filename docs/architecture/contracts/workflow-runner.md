---
schema: openslack.document.v1
id: contract-workflow-runner
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-08-03
sources:
  - design/cdd/workstreams/workflow-runtime/README.md
  - docs/architecture/components/workflow-runtime.md
  - docs/architecture/contracts/workflow-control.md
  - docs/architecture/ts-to-go-migration-roadmap.md
---

# Workflow Runner Protocol Contract

Status: GS8-A contract freeze only. This batch defines the closed
`openslack.workflow_runner.v1` bidirectional TypeScript/Go message contract, exact-byte rules, ownership
boundary, and differential vectors. It adds no worker process, scheduler, lease store, database,
HTTP route, CLI route, cancellation behavior, or runtime authority.

## Purpose

The protocol is the future boundary between a Go Workflow Control scheduler and the existing
JavaScript/TypeScript workflow runner. It permits Go to own runner jobs, attempts, leases, fencing,
cancel requests, and durable message receipts while TypeScript continues to execute workflow code,
call agents, enforce workflow policy, and own all GS9-deferred run state.

GS8-A is deliberately executable-contract work rather than a runtime cutover. Validation of a
message or successful replay of a golden vector proves only cross-language agreement about the
wire contract.

## Authority boundary

| Object or action                           | GS8 owner                    | Constraint                                                                                            |
| ------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Runner job and attempt                     | Future Go scheduler          | TypeScript cannot create or mutate their durable scheduling state.                                    |
| Lease, expiry, takeover, and fencing token | Future Go scheduler          | A worker can accept, reject, or report; it cannot grant, extend, or increment a lease.                |
| Cancel request                             | Future Go scheduler          | TypeScript can acknowledge and apply it only after binding the exact job, attempt, lease, and fence.  |
| Worker event and receipt                   | Future Go receipt store      | A receipt records durable protocol acceptance; it is never workflow approval or effect success.       |
| Workflow source and JavaScript execution   | TypeScript worker            | Go cannot load workflow modules, embed a JavaScript runtime, or accept an arbitrary command/path/URL. |
| Agent/provider call and effect execution   | TypeScript worker            | Go cannot call a provider or execute an effect.                                                       |
| RunStore status, checkpoint, and resume    | TypeScript through GS8       | GS9 alone may transfer new-record authority after separate qualification.                             |
| Legacy run-gate and effect approval v2     | TypeScript through GS8       | A protocol intent or receipt cannot approve, reject, or apply an effect.                              |
| Budget policy and accounting               | TypeScript through GS8       | Usage on the wire is bounded observation only, not a Go budget decision.                              |
| GS7-B shadow observation                   | Isolated Go shadow namespace | It cannot be reused as a runner job, lease, or receipt record.                                        |

No object has two writers. A later runtime must persist its own side of a transition before it
reports acceptance across the process boundary.

## Transport and closed envelope

The frozen logical transport is UTF-8 JSON Lines over a child process standard input and output.
Every message is one closed JSON object with exactly these envelope fields:

```text
protocolVersion
kind
workspaceId
jobId
workflowRunId
attemptId
leaseId
fencingToken
sequence
eventId
correlationId
sentAt
payload
```

The schemas reject unknown fields, malformed Unicode, non-canonical timestamps, unsafe identity
characters, negative or unsafe integer values, duplicate semantic identities, unknown message
kinds, and values beyond the frozen byte/depth/node/string limits. IDs are opaque bindings, not
commands or filesystem paths. The protocol carries full lowercase 64-hex SHA-256 values only.
Before a job exists, `hello` and `hello_ack` carry JSON `null` for `jobId`, `workflowRunId`,
`attemptId`, `leaseId`, `fencingToken`, and `sequence`; they never use an empty string or zero
sentinel. `workspaceId`, `eventId`, `correlationId`, and `sentAt` remain bound. From `lease_offer`
onward, the runtime identities are non-empty and the fence and sequence are positive safe integers.
Standard output is protocol-only. Future bounded, redacted diagnostics may use standard error, but
standard error is never parsed as a protocol message or persisted as workflow evidence. A future
process launcher must use direct argument-vector execution with no shell and a sealed executable;
wire fields cannot select a command, module path, working directory, or URL.

The message kinds and directions are closed:

| Kind             | Direction        | Meaning                                                                                         |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `hello`          | TypeScript to Go | Offers one exact protocol/build/runtime capability set.                                         |
| `hello_ack`      | Go to TypeScript | Accepts the exact supported version and sealed worker identity.                                 |
| `lease_offer`    | Go to TypeScript | Offers one job attempt under an exact lease, fence, expiry, and descriptor hash.                |
| `lease_accept`   | TypeScript to Go | Accepts only the exact offered bindings after local descriptor validation.                      |
| `lease_reject`   | TypeScript to Go | Rejects with a closed, non-sensitive reason code.                                               |
| `heartbeat`      | TypeScript to Go | Reports liveness and bounded progress; it cannot renew its own lease.                           |
| `effect_intent`  | TypeScript to Go | Reports an exact effect hash before the existing TypeScript approval/effect boundary.           |
| `effect_outcome` | TypeScript to Go | Reports the bounded result after TypeScript has decided and, when allowed, executed the effect. |
| `cancel_request` | Go to TypeScript | Requests cancellation for one exact active attempt and unexpired control.                       |
| `cancel_ack`     | TypeScript to Go | Reports whether that exact request was observed and applied.                                    |
| `terminal`       | TypeScript to Go | Reports one closed terminal outcome and evidence hashes.                                        |
| `event_receipt`  | Go to TypeScript | Binds durable acceptance, duplicate recovery, or reconciliation to one exact event.             |

Pause, resume, approval-decision, budget-decision, arbitrary command, module path, provider payload,
prompt, raw argument, transcript, credential, and generic extension messages are not in v1.

## Negotiation and sequencing

Only the exact v1 version is accepted. Negotiation cannot silently select a lower version or add
capabilities, and `hello_ack` binds the control build for that process session. A new process or
build must negotiate again. Within that session, the lease offer binds the workspace, job,
workflow run, attempt, lease, positive fencing token, descriptor/job/source/manifest/input hashes,
and expiry. All later messages must preserve those identities.

The lease offer carries an opaque safe-ID `executionDescriptorRef`, never a path. Independent full
hashes bind the execution descriptor, job specification, workflow source, workflow manifest, and
input. The TypeScript worker resolves that reference only through a future sealed, owner-only
descriptor catalog; neither Go nor a wire field supplies raw arguments or selects executable code.

Sequences are monotonic within the direction and attempt defined by the generated schemas and
vectors. An event ID is allocated and durably retained before first transmission. A retry reuses
the same event ID, sequence, and exact bytes. Reusing an identity with different bytes is a
conflict, never an update.

The future scheduler may treat a heartbeat as evidence that the worker is alive, but the worker
cannot infer a renewal, new expiry, takeover, or fence from its own heartbeat. Once a higher fence
exists, every message at an older fence fails as stale even if its lease time has not elapsed.

### Response and advancement matrix

The v1 acknowledgement state machine is closed even though GS8-A does not execute it:

| Sent message     | Required response                            | Advancement rule                                                                                                      |
| ---------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `hello`          | `hello_ack`                                  | No durable receipt. The runner remains pre-lease until the exact version/build/capabilities are accepted.             |
| `hello_ack`      | none                                         | It is not receiptable and cannot itself start a job.                                                                  |
| `lease_offer`    | exactly one `lease_accept` or `lease_reject` | The offer is not receiptable. The response must preserve the exact job/attempt/lease/fence/correlation binding.       |
| `lease_accept`   | `event_receipt`                              | The worker must not begin workflow code until the receipt is `accepted` or `duplicate`.                               |
| `lease_reject`   | `event_receipt`                              | The worker returns to negotiated idle only after `accepted` or `duplicate`.                                           |
| `heartbeat`      | `event_receipt`                              | A later worker event cannot advance past this sequence until `accepted` or `duplicate`.                               |
| `effect_intent`  | `event_receipt`                              | TypeScript cannot request approval or execute the effect before durable intent acceptance.                            |
| `effect_outcome` | `event_receipt`                              | The worker cannot continue beyond the effect boundary until durable outcome acceptance.                               |
| `cancel_request` | `cancel_ack`                                 | The request is not receiptable. TypeScript applies the exact unexpired control and returns the bound acknowledgement. |
| `cancel_ack`     | `event_receipt`                              | Go cannot mark the control durably observed/applied until the acknowledgement receipt is accepted.                    |
| `terminal`       | `event_receipt`                              | The worker can report a successful process exit only after `accepted` or `duplicate`.                                 |
| `event_receipt`  | none                                         | A receipt is never receipted.                                                                                         |

Only `lease_accept`, `lease_reject`, `heartbeat`, `effect_intent`, `effect_outcome`, `cancel_ack`,
and `terminal` are receiptable. A `reconciliation_required` receipt stops normal advancement for
the attempt; it is not a retry signal. V1 permits only one unreceipted worker event at a time, so a
sequence cannot be skipped, reordered, or advanced speculatively.

A valid `cancel_request` is the only control message that may preempt a worker waiting for an event
receipt. TypeScript evaluates its expiry when the request is received, applies cancellation
immediately, and queues `cancel_ack` behind the already outstanding worker event. If the request
was applied before expiry, that queued acknowledgement remains evidence of the applied control even
when its send time is later than the request expiry. It does not authorize a new control action.

## Exact bytes, hashes, and receipts

The TypeScript bundle under
`packages/workflows/contracts/workflow-runner/v1/` is the exact-byte authority. It contains closed
JSON Schemas, a manifest locking every artifact SHA-256, and positive and negative golden vectors.
The Go `runnerprotocol` package consumes a generated exact mirror and must reproduce the same
validation, canonical JSON, message bytes, hashes, idempotency keys, request fingerprints, and
receipt bindings.

Canonical message bytes are canonical JSON encoded as UTF-8 followed by exactly one line feed.
There is no byte-order mark, leading whitespace, carriage return, blank line, or second trailing
line feed. Separate domain-bound hashes identify workflow source, workflow manifest, input, job
specification, event, output, and effect; one hash cannot substitute for another.

An idempotency key is derived from the exact canonical message bytes under its frozen domain. The
request fingerprint additionally binds direction, kind, protocol version, workspace, job, run,
attempt, lease, fence, sequence, and exact body. Same key and same fingerprint return the original
receipt. Same key with a different fingerprint returns an idempotency conflict.

An `event_receipt` binds the originating identities, event digest, durable status, commit time,
and service build. `accepted` and `duplicate` prove the same durable event record. An unknown commit
outcome that cannot be recovered by exact key becomes `reconciliation_required`; it is never
reported as accepted and never authorizes replay of a possibly executed effect.

## Effects and crash boundary

The reviewed order is:

```text
effect_intent durable receipt
  -> existing TypeScript effect approval v2 decision
  -> TypeScript effect execution when approved
  -> effect_outcome durable receipt
```

The intent receipt is not approval. The outcome message is not durable acceptance until its exact
receipt is recovered. If an effect may have happened but the outcome receipt cannot be proven,
the attempt enters reconciliation and the effect must not be replayed automatically.
Effect outcomes are closed to `executed | rejected | failed | reconciliation_required`; every
outcome carries a full hash of the corresponding execution, exact effect-approval v2 rejection,
bounded failure evidence, or reconciliation record. The message has no retry flag and its hash does
not grant replay authority.

## Cancellation and terminal behavior

GS8 v1 freezes cancellation as the only control message. A request is valid only for the exact
active attempt, lease, current fence, correlation, and bounded control expiry. The acknowledgement
reports observation/application; it does not by itself prove that every child agent or process has
stopped. GS8-B must separately qualify cooperative abort, timeout, process-tree termination, and
Windows behavior before claiming cancellation works.
The closed request reasons are `operator | lease_expired | shutdown | superseded | timeout`.
`budget_exceeded` is intentionally absent because budget policy and accounting remain TypeScript
authority through GS8.

An acknowledged `timeout` request terminates as `timed_out / timeout`. An acknowledged
`operator | lease_expired | shutdown | superseded` request terminates as
`cancelled / cancelled_by_control`. A worker-process crash terminates as
`failed / process_crash`. If any of those paths crosses an effect or commit boundary whose outcome
cannot be proven, reconciliation takes precedence over the ordinary terminal mapping.

Terminal outcomes are closed to `completed`, `failed`, `cancelled`, `timed_out`, and
`reconciliation_required`. A future worker can exit successfully only after the matching terminal
receipt is durably `accepted` or `duplicate`. Protocol, scheduler, and workflow/provider failures
remain separate code domains.

Terminal reasons are separately closed: `completed` has no reason; `failed` uses
`workflow_failed | process_crash`; `cancelled` uses `cancelled_by_control`; `timed_out` uses
`timeout`; and `reconciliation_required` uses `commit_outcome_unknown`. Only `completed` carries a
result hash. Other outcomes carry no raw or hashed result that could be mistaken for success.

## Closed protocol errors and dispositions

The v1 contract freezes these protocol/API error codes:

```text
WORKFLOW_RUNNER_UNSUPPORTED_VERSION
WORKFLOW_RUNNER_INVALID_MESSAGE
WORKFLOW_RUNNER_UNKNOWN_FIELD
WORKFLOW_RUNNER_LIMIT_EXCEEDED
WORKFLOW_RUNNER_IDENTITY_MISMATCH
WORKFLOW_RUNNER_HASH_MISMATCH
WORKFLOW_RUNNER_IDEMPOTENCY_CONFLICT
WORKFLOW_RUNNER_SEQUENCE_CONFLICT
WORKFLOW_RUNNER_LEASE_EXPIRED
WORKFLOW_RUNNER_STALE_FENCE
WORKFLOW_RUNNER_CONTROL_EXPIRED
WORKFLOW_RUNNER_PROCESS_CRASH
WORKFLOW_RUNNER_TIMEOUT
WORKFLOW_RUNNER_COMMIT_OUTCOME_UNKNOWN
WORKFLOW_RUNNER_RECONCILIATION_REQUIRED
```

There is deliberately no generic `error` wire message. The codes are local validator, transport,
scheduler, and supervisor results; a peer must not invent an unregistered kind to carry them.
Only `WORKFLOW_RUNNER_COMMIT_OUTCOME_UNKNOWN` and
`WORKFLOW_RUNNER_RECONCILIATION_REQUIRED` may appear in the closed `event_receipt.errorCode`, and
only when that receipt status is `reconciliation_required`.

| Failure class                                                     | Wire response                                                                                     | Fail-closed disposition                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid/unknown/oversize handshake or unsupported version         | none                                                                                              | The detecting side records a bounded local diagnostic and closes the pre-lease stream; no job is started.                                                   |
| Invalid lease offer                                               | none                                                                                              | It is not a semantic `lease_reject`; the worker exits non-zero without executing workflow code.                                                             |
| Invalid worker event, identity/hash/idempotency/sequence conflict | no receipt                                                                                        | Go terminates the offending worker. Before accepted execution it may fail the attempt; after execution begins it enters reconciliation.                     |
| Expired lease or stale fence                                      | no receipt                                                                                        | The stale process is terminated and ignored. A durably superseded old attempt may close as cancelled; any unresolved effect boundary enters reconciliation. |
| Invalid or expired control message at the worker                  | no acknowledgement                                                                                | TypeScript does not apply the control. A malformed active control stream exits non-zero; Go applies the process-crash/reconciliation rules.                 |
| Worker process crash                                              | none                                                                                              | Go records `failed / process_crash` only when no effect outcome is ambiguous; otherwise it records reconciliation.                                          |
| Whole-workflow timeout                                            | valid `cancel_request` when possible                                                              | Cooperative completion uses `timed_out / timeout`; forced termination uses reconciliation if an effect outcome is ambiguous.                                |
| Valid event with unknown durable commit outcome                   | `event_receipt` with `reconciliation_required` when that reconciliation receipt itself is durable | Normal advancement stops and the event/effect is not replayed automatically.                                                                                |

These errors do not encode raw provider failures, prompts, outputs, approval reasons, commands,
credentials, or stack traces.

## GS8-A evidence ceiling

GS8-A can claim only:

- closed TypeScript schemas and validators;
- exact-byte manifest and positive/negative vectors;
- a pure importable Go mirror with cross-language parity;
- consumer import and contract generation checks; and
- explicit single-writer and GS9 exclusion documentation.

It cannot claim a running worker, process isolation, scheduling, durable lease, cancellation,
PostgreSQL receipt store, response-loss recovery, checkpoint/approval/budget cutover, Qoder
qualification, release, live use, or production readiness.

## Later gates

GS8-B may implement the default-off worker/scheduler path only after this contract is reviewed. It
must qualify negotiation, duplicate/replay, lease expiry/takeover, stale fencing, response loss,
Go/PostgreSQL restart, process crash, whole-workflow timeout, cancellation at every execution
boundary, effect reconciliation, owner-only local spool behavior, Windows process trees, sealed
worker command selection, and exact TypeScript/Go parity.

GS9 is a distinct cutover. It alone may move the new-record Workflow Control record: revisioned
RunStatus/control transitions, checkpoint and resume cursor, effect-approval v2 state, and durable
budget accounting. Legacy run-gate approvals remain TypeScript compatibility state and never
become effect approval. The cutover requires revision/CAS, differential, recovery, concurrency,
fencing, rollback, and durable-acceptance evidence. GS8-A and GS8-B cannot be used as evidence that
GS9 is complete.
