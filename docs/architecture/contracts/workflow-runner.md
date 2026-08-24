---
schema: openslack.document.v1
id: contract-workflow-runner
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-08-22
sources:
  - design/cdd/workstreams/workflow-runtime/README.md
  - docs/architecture/components/workflow-runtime.md
  - docs/architecture/contracts/workflow-control.md
  - docs/architecture/ts-to-go-migration-roadmap.md
---

# Workflow Runner Protocol Contract

Status: GS8-B local implementation plus the GS9-F1 default-off runner-v2 foundation, GS9-F2a
authority-binding contract freeze, and GS9-F2b default-off runtime-delivery qualification. GS8-A
remains the immutable `openslack.workflow_runner.v1` bidirectional TypeScript/Go contract. The
normal CLI/TUI route and production Workflow authority remain unchanged.

## Purpose

The protocol is the boundary between a Go Workflow Control scheduler and the existing
JavaScript/TypeScript workflow runner. It permits Go to own runner jobs, attempts, leases, fencing,
cancel requests, and durable message receipts while TypeScript continues to execute workflow code,
call agents, enforce workflow policy, and own all GS9-deferred run state.

GS8-A validation or successful replay of a golden vector proves only cross-language agreement
about the wire contract. GS8-B adds the runtime implementation, but its evidence remains a local,
default-off runner-lifecycle qualification and does not establish a Workflow Control authority
cutover.

## Authority boundary

| Object or action                           | GS8 owner                    | Constraint                                                                                            |
| ------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Runner job and attempt                     | Go scheduler                 | TypeScript cannot create or mutate their durable scheduling state.                                    |
| Lease, expiry, takeover, and fencing token | Go scheduler                 | A worker can accept, reject, or report; it cannot grant, extend, or increment a lease.                |
| Cancel request                             | Go scheduler                 | TypeScript can acknowledge and apply it only after binding the exact job, attempt, lease, and fence.  |
| Worker event and receipt                   | Go receipt store             | A receipt records durable protocol acceptance; it is never workflow approval or effect success.       |
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
input. The TypeScript worker resolves that reference only through its sealed, owner-only descriptor
catalog; neither Go nor a wire field supplies raw arguments or selects executable code. GS8-B
rejects runtime imports, re-exports, dynamic imports, `require()`, and direct Node `process`/global
module-loader references before lease acceptance. This dependency-closure check supplements the
reviewed, hash-bound source and sealed process environment; it is not an independent JavaScript
sandbox. The established CLI loader is outside this restriction and remains unchanged.

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

## GS8-B implementation and evidence ceiling

GS8-A continues to prove the frozen contract. GS8-B additionally implements:

- PostgreSQL-backed runner jobs, attempts, leases, monotonic fencing, cancel controls, immutable
  events and durable receipts;
- response-loss recovery and reconciliation for unprovable submission or event commits;
- durable exponential dispatch backoff with a five-failure ceiling for launch, pre-execution crash,
  and lease-rejection loops;
- a sealed direct-argv process supervisor with Linux parent-death and Windows Job Object process
  trees;
- an externally hash-anchored, exact closed bundle containing one copied Node executable, one
  self-contained JavaScript entrypoint and its manifest, plus owner-only TypeScript execution
  descriptors;
- exact recomputation of `runnerBuildHash` from the entrypoint bytes and rejection of extra bundle
  paths, links, reparse points, dependency drift, or workflow-source runtime imports;
- canonical JSONL negotiation, one outstanding event, receipt-gated execution and terminal exit;
- exact cancel-control acknowledgement, terminal-state preservation for a queued
  `already_terminal` acknowledgement, and rejection of terminal events before receipt-gated
  execution;
- cooperative cancellation through workflow, agent, fan-out, pipeline, and effect boundaries; and
- a private bearer-authenticated, single-workspace admission/read API in
  `services/workflow-control/docs/api/runner-openapi.yaml`.

The implementation is off unless `WORKFLOW_RUNNER_CONTROL_ENABLED=1` and every sealed workspace,
bundle, build, token, and database binding is present. The default service image entry point and
all existing CLI/TUI/MCP run paths remain unchanged. GS8-B cannot claim RunStore, checkpoint,
resume, effect-approval, effect-execution, budget, or user-visible read authority; authenticated
Qoder Desktop, remote Connector, release, live use, and production readiness also remain outside
its evidence.

## Later gates

GS8-B qualification requires negotiation, duplicate/replay, lease expiry/takeover, stale fencing,
response loss, Go/PostgreSQL restart, process crash, whole-workflow timeout, cancellation at every
execution boundary, effect reconciliation, owner-only descriptor behavior, Windows process trees,
sealed worker command selection, and exact TypeScript/Go parity. Repository tests may report only
`LOCAL_PASS`; hosted exact-head checks, review state and independent approval remain separate.

GS9-A is a distinct contract freeze, not a cutover. It freezes the future new-record Workflow
Control state: revisioned RunStatus/control transitions, checkpoint commit, resume generation,
effect-approval v2, legacy run-gate separation, cumulative budget arithmetic, and immutable
authority epoch. Its run revision/CAS is independent from this GS8 protocol's attempt, lease, and
fencing token. The frozen runner v1 messages remain unchanged and still carry no approval or budget
decision. GS9-A freezes a complete 18-kind `openslack.workflow_runner.v2` vocabulary containing
the 12 retained v1 kinds plus six added kinds: `checkpoint_commit`, `budget_reserve_request`,
`budget_usage_report`, `budget_authorization`, `effect_authorization`, and `resume_offer`. Their
closed leased identity includes `routingEpoch`, `runRevision`, `resumeGeneration`, `attemptId`,
`leaseId`, and `fencingToken`. The v2 `hello` advertises the exact ordered `[v1, v2]` pair, and a
v2-required `hello_ack` selects v2 without downgrade, but there is no v2 scheduler negotiation,
delivery, or execution path.

GS9-B and later work must separately qualify shadow/differential, reads, routing, durable
acceptance, response loss, restart, duplicate/conflict, recovery, canary, and higher-epoch rollback
before any new record can move. GS8-A/GS8-B and `GS9-A LOCAL_PASS` cannot be used as evidence that
Go Workflow Control authority exists.

## GS9-F1 default-off runner v2 foundation

GS9-F1 consumes the already frozen `openslack.workflow_runner.v2` vocabulary without changing the
runner-v1 bundle, manifest, golden vectors, idempotency prefixes, or generated Go mirror. It adds
only the admission/storage foundation, exact `[v1, v2]` negotiation skeleton, and the
receipt-before-decision transport boundary. A foundation job pins protocol v2, the exact
route/build/epoch, run revision, resume generation, and required capabilities; a v1-only worker,
missing capability, or binding drift is rejected with no downgrade.

The foundation can persist and bind a worker event to the current job/attempt/lease/fence and
run/revision/generation/route, create the exact runner receipt, and require receipt delivery before
a later decision adapter may advance. It does not implement the GS9-C checkpoint, GS9-D TypeScript
effect, GS9-E budget, or resume adapters, and therefore does not claim end-to-end runtime delivery,
checkpoint/effect/budget decision completion, or crash-after-authority recovery. Those remain the
GS9-F2 umbrella: F2a freezes the missing companion contract and F2b owns integration delivery.

Within the foundation session, all receiptable events share one FIFO lane. Heartbeat never
preempts a budget, effect, checkpoint, cancel acknowledgement, or terminal event; cancellation may
abort execution immediately, but its acknowledgement drains behind the event already awaiting a
receipt and ahead of the sealed terminal event. A receipt-proven terminal is immutable even when
delivery of that terminal event's own receipt is uncertain. Domain authority uncertainty and
uncertain earlier control delivery still latch reconciliation. A `resume_offer.newAttemptId` is a
new workflow resume identity and must differ from the existing runner lease `attemptId`; the
envelope and receipt continue to use the unchanged lease attempt identity.

The path is qualification-only and default-off. It does not enable production v2 job submission,
new-record routing, canary or cutover; it does not make Go the Workflow state-machine, checkpoint,
effect-approval, effect-execution, budget-policy, or user-visible read authority. TypeScript remains
the production Workflow authority, and the default image continues to start `/server` without v2
submission or routing.

## GS9-F2a authority-binding companion contract freeze

The generated [GS9-F2a authority-binding manifest](../../../packages/workflows/contracts/workflow-runner-authority-binding/v1/manifest.json)
is the normative record for this contract-only batch. It closes the four-schema bundle, protocol
sequence, operation facts, source-lock identities, exact framing, and every not-delivered,
not-activated, not-claimed, or separately gated capability. The runner contract does not duplicate
those inventories.

F2a adds no runtime producer or consumer of the companion frames. GS9-F2b must compose durable
staging, domain adapters, recovery, scheduler/worker integration, and end-to-end qualification
without widening the manifest boundary.

The operation facts also freeze receipt-hash selection per control kind. Budget authorization binds
the exact canonical durable receipt bytes; effect authorization and resume offer bind the
domain-separated authority receipt; other kinds carry no authority-receipt hash. Both mirrors now
validate those facts from the generated bundle, share strict parsing within each language, and cache
each prepared request and durable receipt for one validation call. These changes address structural
fragility and test coverage only; no live Go behavior divergence was found or claimed.

The `budget_authorization` ACK is checked against a post-event durable E1 result. An accepted
reserve receipt plus its exact reserve decision and ledger entry determines `reserved` with the
requested amounts or `rejected` with zero amounts, the accepted run revision, and the SHA-256 of
the canonical Go durable-receipt envelope after its writer, mode, build, E1 manifest, record kind,
projection, and projection hash are revalidated. A database-unknown reserve has no accepted revision and therefore
uses the reconciliation-required event receipt to stop the attempt; it must not emit a sequence-4
budget decision. The authority-v2 reconciliation status remains part of the frozen vocabulary for
future evidence that can prove an accepted revision, but current E1 database-unknown evidence is
not such proof.

At the F2a boundary, the active runtime profile and service source manifest still described
GS9-F1. F2a itself left TypeScript as the production Workflow authority and the Go mirror as a
validator with durable authority false; the qualification-only F2b profile below is the separately
reviewed runtime composition that supersedes those F1 profile/manifest facts.

## GS9-F2b authority-binding runtime delivery

F2b activates the F2a companion only inside an explicit default-off qualification profile. The
sealed worker determines initial versus resume from durable RunStore state, stages the future exact
runner event, obtains and ACKs its companion resolution around the existing C/D/E source, and then
sends the byte-identical event. Go verifies the exact resolution, advances the independent global
head, persists the exact event receipt, and requires a distinct control-delivery ACK before sending
any effect, budget, or resume decision.

Checkpoint commit, effect authorize/complete, budget reserve/settle, and resume advance retain
their original single-writer source boundaries. The E2 budget result is independently point-read by
Go and bound into the same event transaction; Go never re-reserves on behalf of the TypeScript
adapter. Recovery preserves the original binding/key and latches unknown outcomes. F2b does not
activate production v2 submission, new-record routing, canary, cutover, or TypeScript writer
retirement; those remain later independently reviewed batches.
