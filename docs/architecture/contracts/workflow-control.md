---
schema: openslack.document.v1
id: contract-workflow-control
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
  - docs/architecture/ts-to-go-migration-roadmap.md
  - memory_bank/t2_execution/workflow_contract.md
---

# Workflow Control Contract

Status: GS7-A contract freeze plus the merged, exact-head-qualified GS7-B PostgreSQL observational
shadow, GS8 runner lifecycle, the GS9-A Workflow Control authority v2 contract freeze, the GS9-C
checkpoint/resume differential, the GS9-D effect-control seam plus default-off parity shadow, and
the GS9-E1 budget operational bundle plus GS9-E2 default-off durable qualification authority,
the GS9-F1 runner-v2 foundation, the GS9-F2a authority-binding companion contract freeze, and the
GS9-F2b default-off runtime-delivery qualification profile.
TypeScript remains the sole production workflow writer, runner, approval, budget, effect, resume,
and user-visible read authority. D1 freezes the closed bundle, D2 enforces the owner-local decision
and one-time claim, and D3 observes only the three credential-free decision/audit projections. E1
freezes validation and fold semantics; E2 persists only isolated qualification records.

## Authority boundary

`@openslack/workflows` continues to own the JavaScript/TypeScript DSL and runner, workflow and agent
calls, permission and trust checks, human decisions, effect execution, local RunStore writes,
resume behavior, and CLI/TUI/MCP views. The pure `services/workflow-control` Go module accepts only
the closed, bounded contract record, validates it, checks declared status transitions, and produces
a deterministic credential-free read model for differential qualification. GS7-B may durably
record that observation in a separate PostgreSQL namespace, but its result cannot alter a RunStore
write, workflow result, approval, budget, effect, resume, or user response.

The cross-language record never carries raw workflow arguments, prompts, phase results, approval
details, capabilities, decision evidence, provider payloads, transcripts, commands, credentials, or
tokens. Full SHA-256 values and bounded counts are evidence; truncated or message-derived identity
is not.

## Frozen current semantics

The v1 bundle freezes the four execution modes and the ten RunStore status names. Its current
transition table is:

| State                     | Allowed next state                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `created`                 | `previewed`, `confirmed`, `running`                                                 |
| `previewed`               | `confirmed`, `running`                                                              |
| `confirmed`               | `running`                                                                           |
| `running`                 | `paused`, `paused_waiting_approval`, `resuming`, `completed`, `failed`, `cancelled` |
| `paused`                  | `running`                                                                           |
| `paused_waiting_approval` | `resuming`, `cancelled`                                                             |
| `resuming`                | `running`, `failed`, `cancelled`                                                    |
| `completed`               | none                                                                                |
| `failed`                  | none                                                                                |
| `cancelled`               | none                                                                                |

This table records the reviewed RunStore behavior; it is not yet a cross-process CAS state
machine. Production initialization currently starts at `running`. The `created`, `previewed`, and
`confirmed` names have no normal production writer, and workflow control code can still bypass the
RunStore transition method. These facts keep `authorityEligible` false.

Phase checkpoints freeze only the current `completed | failed | skipped` evidence surface and
export result/cache hashes instead of content. Legacy run-gate approvals freeze only their
`pending | approved | rejected` compatibility shape and aggregate counts. They are not Workflow
effect approvals.

`openslack.workflow_effect_approval.v2` remains the only normative effect-decision record. It binds
the exact run, workflow, input, effect, capability, correlation, expiry, revision, decision, and
audit projection. The GS7 read model may summarize its status, but cannot make or apply a decision.

Budget evidence freezes configured limits, cumulative counters that are actually supplied to the
contract, and threshold/exceeded warning counts. It does not claim that the current runtime durably
preserves budget across resume, retry, restart, or parallel execution.

## Exact-byte bundle

The TypeScript authority bundle is under:

```text
packages/workflows/contracts/workflow-control/v1/
```

It contains closed JSON Schemas, a manifest with SHA-256 artifact locks, and positive and negative
golden vectors. The Go module consumes an exact generated mirror. Drift in schema bytes, vectors,
constants, projection output, transition decisions, or manifest hashes fails qualification.

The independent GS7-B transport bundle is under:

```text
packages/workflows/contracts/workflow-control-shadow/v1/
```

Its exact canonical envelope includes the TypeScript observation and TypeScript projection plus a
workspace/run/source-sequence binding. The body has exactly one trailing LF. Its idempotency key is
derived from the exact body; the request fingerprint additionally binds method, path, authority,
workspace, run, and sequence. It never changes the GS7-A bundle bytes.

## GS7-B observational store

The private Go surface is intentionally closed to six routes: observation ingest, matched
projection, live, ready, version, and metrics. It has no workflow control, worker, scheduler, lease,
cancel, approval, budget, effect, routing, or generic command route. Network binding is loopback by
default and accepts only IP literals; explicit internal mode permits only loopback, private,
link-local, or wildcard container addresses.

PostgreSQL persists immutable observations and receipts plus one CAS-updated per-run head.
TypeScript alone issues a contiguous source sequence. A semantically valid projection or evolution
difference is committed as `mismatched`: it advances the observed source sequence but not the
matched head. Same-key/same-fingerprint replay returns the original receipt, while a different
fingerprint conflicts. An unknown transaction outcome is looked up by key and otherwise becomes a
durable `reconciliation_required` receipt; it is never treated as accepted and never triggers a
workflow mutation retry.

The TypeScript port is default-off and fail-open. Its owner-only journal is independent from the
RunStore and may replay only shadow observations after restart. Existing paths are verified rather
than silently hardened: POSIX paths require owner modes and no-follow opens, while Windows paths
must be owned by the current SID, use a protected ACL with only that SID and SYSTEM as allowed
principals, and not be reparse points. Every new journal directory, lock, entry, and state temporary
or target file is hardened and then reverified. Missing full manifest hashes or incomplete legacy
approval, agent-token, effect-approval, or budget evidence cause a bounded diagnostic and skipped
observation; the port must not fabricate evidence, pad a legacy hash, block a workflow, or resume an
execution.

## Explicit GS7-A gaps

The contract marks the read model ineligible for authority while any of these remain true:

- RunStore status, checkpoint, control, and legacy approval writes have no shared revision or CAS;
- there is no workflow lease, heartbeat, expiry, takeover, fencing token, or stale-writer rejection;
- pause and stop do not durably abort the running workflow body;
- budget accounting is not a durable, monotonic record across resume and restart;
- resume does not yet prove exactly-once phase continuation from a durable checkpoint;
- control paths can write status outside the frozen transition method; or
- the strict v2 effect approval is not an exactly-once runtime pause/decision/resume boundary.

The reviewed `workflow-control-shadow-v1` Go gate requires and invokes named qualification tests
against PostgreSQL. Those tests check the private handler and durable receipt path,
seeds state, restarts the exact database container, verifies replay from a new process, starts the
built image, and calls its observation, projection, and version APIs. These are gate definitions;
their hosted result remains evidence for the exact reviewed GS7-B head only.

GS7-B has passed its exact-head hosted PostgreSQL, response-loss, restart, concurrency, corruption,
OpenAPI, Prometheus, distribution, image-smoke, cross-language, review-thread, and independent
human-approval gates and is merged. It remains an observational shadow and does not gain runtime
authority from those results.

## GS9-A Workflow Control authority v2 freeze

The independently versioned GS9-A source bundle is under:

```text
packages/workflows/contracts/workflow-control-authority/v2/
```

It contains closed authority-state, authority-message, prepared-message, and durable-receipt
schemas, a locked manifest, and positive/negative golden vectors. The generated Go mirror is under
`services/workflow-control/authoritycontract/generated/v2/`. GS9-A references the existing
Workflow Control v1 and workflow-effect approval v2 semantics; it changes neither bundle.

The v2 contract freezes these independent dimensions:

- run `revision` and its expected value provide semantic RunStatus/control/checkpoint CAS;
- the GS8 runner attempt, lease, and fencing token reject stale processes but do not satisfy the
  run CAS, and a valid run revision does not authorize a runner process;
- the immutable per-record authority route binds backend, authority owner, positive routing epoch,
  and service build before record creation; a higher epoch may route only future records;
- legacy run-gate state and `openslack.workflow_effect_approval.v2` are separate approval planes;
- a checkpoint with exact `commitPoint: after_phase_work` commits only when its canonical mutation
  has a durable accepted or duplicate authority receipt, never when a callback, file write, or
  runner event merely occurs;
- monotonic `resumeGeneration` is distinct from run revision and runner attempt ordinal and binds
  the last committed checkpoint plus manifest/source/input/route/build identities; and
- every durable budget quantity is a canonical non-negative decimal string bounded by signed
  64-bit `BIGINT`; money is integer `nano_usd` at scale 9 and non-negative decimal conversion uses
  `half_up_nonnegative`, never binary floating point.

Same idempotency key and fingerprint replay the exact original receipt. Same key with a different
fingerprint conflicts without mutation. An outcome that remains unknown after bounded exact
receipt lookup becomes `reconciliation_required`; it is not permission to retry with a new
identity. These are future authority rules represented and differentially validated by GS9-A, not
implemented PostgreSQL behavior.

TypeScript remains the sole writer for every current and new workflow record. GS9-A adds no
PostgreSQL authority migration, HTTP mutation or user-visible read route, v2 runtime negotiation or
delivery, effect execution, budget enforcement, checkpoint/resume runtime, active routing epoch,
canary, rollback, old-record migration, or TypeScript writer deletion. It does freeze an 18-kind
`openslack.workflow_runner.v2` vocabulary: all 12 v1 kinds remain, six authority kinds are added,
and v1 bytes remain unchanged. The detailed service boundary and qualification ceiling are
recorded in
`services/workflow-control/docs/architecture/workflow-authority-contract-v2.md` and
`services/workflow-control/docs/testing/gs9a-qualification.md`.

Organization Graph normalization and dynamic Scenario graph loading remain independent work and
are not evidence for GS9-A.

The six added v2 kinds are exactly `checkpoint_commit`, `budget_reserve_request`,
`budget_usage_report`, `budget_authorization`, `effect_authorization`, and `resume_offer`. Their leased identity binds
`routingEpoch`, `runRevision`, `resumeGeneration`, `attemptId`, `leaseId`, and `fencingToken` under the
kind-specific closed schema. A message is not its own durable receipt and cannot claim that the
future mutation, authorization, or resume action occurred. The v2 `hello` advertises the exact
ordered `[v1, v2]` pair, and a v2-required `hello_ack` selects v2 without downgrade; no runtime
negotiates or delivers v2. The independent receipt
operations are `run_transition`, `checkpoint_commit`, `budget_reserve`, `budget_settle`,
`effect_authorize`, and `resume_advance`.

GS8-A separately freezes runner protocol v1 and GS8-B owns its default-off
scheduler/lease/cancellation implementation. GS9-A freezes, but does not activate, the separate
Workflow Control authority contract and runner protocol v2 extension. GS9-B and later stages must
still add shadow/differential, reads, immutable new-record routing, PostgreSQL durable acceptance,
v2 runtime delivery, recovery, canary, and explicit higher-epoch rollback.
None of those later stages is implied by a GS7 shadow receipt, GS8 protocol validation, or the
GS9-A local contract pass.

## GS9-B default-off PostgreSQL authority spine

GS9-B implements only the run-status/revision spine represented by the frozen v2 contract. The
separate `workflow_control_*` namespace stores an immutable qualification epoch, one current run
head, append-only transition events and exact receipts, a transactional outbox, and unresolved
reconciliation evidence. It does not add authority columns to `workflow_runner_*`; Workflow
revision/CAS remains independent from runner job revision, attempt, lease, and fencing token.

The private `/authority-server` is health-only unless
`WORKFLOW_CONTROL_AUTHORITY_MODE=local-qualification-v1` is set with one exact loopback workspace,
caller, routing epoch, service build, and bearer binding. In that explicit mode, accept and
transition use strict canonical JSON, deterministic idempotency/fingerprint bindings, ordered
advisory locks, receipt point-read, `SELECT ... FOR UPDATE`, exact expected-head CAS, and one
transaction for event, run head, accepted receipt bytes, and outbox. Same-key replay returns the
original receipt bytes unchanged. A different fingerprint, stale revision, route drift, or invalid
transition conflicts without mutation.

After a lost commit response the repository first point-reads the original receipt by exact
fingerprint. An unresolved primary outcome records `reconciliation_required` without a run head,
accepted revision, transition event, or outbox; if that reconciliation commit also cannot be
proved, the stable non-2xx result is
`WORKFLOW_CONTROL_AUTHORITY_COMMIT_OUTCOME_UNKNOWN`. Outbox acknowledgement is not a synchronous
transition precondition in this batch.

The default image entry point remains the GS7-B shadow server. The authority binary is packaged
only for explicit qualification, and `/health/version` continues to report
`authority: typescript`, `routingActivated: false`, and `acceptNewRecords: false`. No TypeScript
RunStore, CLI, TUI, MCP, Qoder, or runner-v2 client calls this service. Checkpoint/resume,
approval/effect, budget, active routing, canary, rollback, old-record migration, and writer cutover
remain GS9-C and later work. Passing the reviewed PostgreSQL, race, restart, image-default-off,
OpenAPI, migration, and exact-replay gates supports only `GS9-B LOCAL_PASS / Go authority
NOT_CLAIMED`.

## GS9-C checkpoint and resume differential

GS9-C adds a separate TypeScript-owned checkpoint control head rather than promoting the legacy
`ctx.phase()` entry marker. A workflow commits phase evidence only through an awaited
`ctx.checkpoint.commit(...)` after phase work. The bounded artifact is persisted and verified
locally; only its reference and SHA-256 cross the shadow boundary. The control head binds exact
workflow-source, manifest, input, job, attempt, lease, fence, correlation, and runner-build
identities.

Resume advances a monotonic generation under the same TypeScript control lock and emits an
explicit `resume_advance` observation. The opaque execution binding can be created only by the
runner session after an advancing GS8 `lease_accept` receipt. It is not accepted by public execute
or resume options. Before the first checkpoint, a new accepted lease resumes at exactly
`phase-0` with a null prior checkpoint; further new leases may repeat that pre-checkpoint resume
until one commits phase 0. Afterward, resume advances from the latest committed checkpoint. A new
attempt and lease with a higher fence may resume; reuse, drift, missing artifact, corrupt control,
and phase gaps fail closed before new evidence is committed.

The credential-free shadow contract is frozen under:

```text
packages/workflows/contracts/workflow-checkpoint-shadow/
```

It contains closed observation, envelope, control, artifact, accepted receipt, reconciliation
receipt, and golden-vector schemas. `checkpoint_commit` and `resume_advance` are discriminated
operations with an independent per-run source sequence. Runner protocol v1 bytes remain unchanged;
the observation is delivered through a separate default-off loopback HTTP port.

The public `WorkflowRuntime.checkpoint` capability is optional and absent from ordinary runtimes.
Only the accepted sealed-runner path receives the stronger runner-only runtime with a required
checkpoint capability. Checkpoint canonical data is bounded to depth 64; control, artifact JSON,
and ordinary run metadata use their own 8 MiB, 6 MiB, and 256 KiB read bounds respectively.

The Go service writes only `workflow_control_checkpoint_shadow_*`. It validates the canonical
envelope, recomputes parity, advances only a contiguous matched prefix, returns byte-identical
accepted receipt replay, and persists ambiguous outcomes as reconciliation. Mismatch, outage, and
reconciliation cannot change TypeScript state or authorize resume. GS9-B
`workflow_control_runs` and GS8 `workflow_runner_*` remain separate namespaces.

The reviewed contract, PostgreSQL race/restart/response-loss, OpenAPI, image-default-off, and
cross-language gates cap the result at `GS9-C LOCAL_PASS / Go authority NOT_CLAIMED`. Approval and
budget authority, runner-v2 delivery, routing, canary, rollback, old-record migration, and
TypeScript writer retirement remain GS9-D and later work.

## GS9-D D1 effect-control contract freeze

GS9-D closes the approval-to-effect seam before any Workflow writer transfer. D1 freezes a closed
schema/manifest/golden-vector bundle only. It adds no production runtime port, store mutation, Go
table, HTTP route, runner message, qualification result, or authority claim. D2 consumes this
bundle to implement the TypeScript runtime and store; D3 later consumes its observer projection to
implement Go parity. TypeScript remains the sole writer of the v2 approval, execution claim,
effect result, RunStore, and user-visible result.

The bundle has exactly six semantic artifact variants:

| Variant                       | Meaning                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect_intent`               | Binds one stable effect occurrence to the exact run, workflow, input, operation, capability, effect ID, and effect hash.                    |
| `effect_approval_pending`     | Binds the occurrence to one newly created or exact-replayed `openslack.workflow_effect_approval.v2` pending record and expiry.              |
| `effect_decision_committed`   | Records the terminal approved or rejected v2 decision, decision revision/hash, and independently authenticated human channel.               |
| `effect_audit_recorded`       | Records the later audit projection without changing the terminal decision or becoming an authorization prerequisite.                        |
| `effect_execution_claim`      | Atomically consumes one exact approved decision for one `executionId`; its substate is `claimed`, `executed`, or `reconciliation_required`. |
| `legacy_run_gate_observation` | Records legacy pause/cancel/continue state with `effectDecisionAuthority:false` and no effect grant.                                        |

All six variants bind a versioned schema, workspace, run, stable occurrence ID, canonical
timestamp, and exact hashes required by that artifact. The v2 approval chain also binds the exact
business correlation; the normalized legacy projection deliberately does not fabricate one. The effect occurrence ID
distinguishes two intentional executions with identical operation and detail in one run. Raw detail
is never the occurrence identity and an approval for one occurrence cannot authorize another.

The authority sequence is intent, pending approval, terminal decision, and at most one execution
claim. A rejected decision creates no claim. An approved revision-1 decision whose audit is still
pending or the same decision's revision-2 audit-recorded projection may be consumed; audit-sink
success is evidence, not a precondition for effect authorization. The claim binds an exact
`executionId`, immutable decision revision/hash, and one-time substate. D1 deliberately does not
bind runner job, attempt, lease, or fence; the foundation bindings belong to GS9-F1 and the real
domain adapters remain GS9-F2b work after the F2a contract freeze.
Every terminal decision must name the same workspace as its enclosing artifact. An approved claim
must begin after the decision and before the approval expires. Once that claim has begun, its
proved completion or reconciliation record may be committed after approval expiry, but never
before `claimedAt`; expiry prevents a new claim and does not erase an already-consumed decision.
The current runner descriptor expiry is an attempt-only claim condition, not part of the durable
occurrence identity. A newly accepted lease can therefore resume the same occurrence, but an
expired lease cannot claim or execute it. The authority persists an immutable occurrence anchor
before its mutable head; missing, one-sided, or hash-divergent evidence requires reconciliation.

An expired pending approval advances to a deterministic next generation instead of failing the
run. Generation zero preserves the original approval ID; each later generation has a distinct
derived ID and an atomic current-generation anchor. Old decisions, attestations, and views are
immutable history and cannot authorize the current generation. The default TTL is 15 minutes and
trusted composition may select a value from one minute through 24 hours.

`openslack.workflow_effect_approval.v2` is the only human effect-decision authority. Its pending
record binds the exact run, approval, business correlation, workflow ID/version/hash, manifest and
input hashes, effect ID/hash, required capability, creation time, and expiry. The terminal decision
uses expected-revision CAS and a fresh, separately authenticated human channel bound to the
workspace, principal, capability, decision, reason hash, correlation, approval expiry, and bounded
attestation lifetime. Authorization revalidates the exact decision and expiry under the same
owner-safe lock used to create the claim. A later audit projection cannot alter the decision or
mint a second claim.

Legacy `pending-approvals.json`, its TUI resolution, an `onConfirm` callback, preapproved manifest,
and `allowUnattended` remain run-continuation or admission gates only. They may pause, cancel, or
allow an old TypeScript run to continue evaluating, but they have no effect-decision authority.
Their only cross-boundary semantic form is `legacy_run_gate_observation`, which is explicitly
non-authorizing. A legacy run that reaches a governed effect must still obtain the exact v2
decision and win the one-time claim.

After `effect_execution_claim:claimed`, exact replay may read the claim but cannot invoke the
effect again. A proved terminal result advances the same claim to `executed`; a timeout, process
stop, response loss, or unknown commit advances it to `reconciliation_required`. Neither resume,
restart, a Go receipt, nor another human decision creates retry authority. Recovery requires an
explicit reconciliation operation that proves what happened before any successor action.
Successful results are stored out of line as owner-only canonical JSON replay artifacts, limited
to 256 KiB and bound to the execution claim by reference and SHA-256. Missing, changed, or
oversize result evidence after a side effect becomes reconciliation, never retry authority.
Deterministic replay preserves the original occurrence/source-sequence identity. Manifest
`approvedEffects` is admission metadata and never substitutes for the exact v2 decision.

The six semantic artifacts are not six Go approval-shadow operations. D3 exposes exactly three
credential-free observer operations: `approval_created`, `approval_decided`, and `audit_recorded`,
derived respectively from `effect_approval_pending`, `effect_decision_committed`, and
`effect_audit_recorded`. `effect_intent`, `effect_execution_claim`, and
`legacy_run_gate_observation` never become Go approval-shadow operations. Go may receive only
bounded IDs, revisions, timestamps, status/mismatch codes, and hashes. It must never receive raw
effect or audit detail, workflow input, arguments, prompts, provider request/response, effect
payload/result, human reason, attestation nonce, credential, bearer, keychain reference, endpoint,
transcript, stack, command, or local path.

The Go implementation remains optional, default-off, observer-only, and fail-open to TypeScript
authority. Go cannot create a decision or claim, and its outage, mismatch, reconciliation, receipt,
or audit-sink failure cannot approve, claim, execute, retry, pause, resume, roll back, or otherwise
change a TypeScript effect result.

Runner protocol v1 schemas, bytes, kinds, idempotency, receipts, and process lifecycle remain
frozen. D1-D3 do not deliver runner-v2 `effect_authorization` and do not reinterpret a v1 runner
message or durable receipt as approval. GS9-F2b must use the F2a companion plus a separately negotiated v2 session and
preserve v1 unchanged.
The six runner/authority/checkpoint manifest and golden SHA values in the bundle are source locks,
not deployment identity. Runtime receipt validation receives the expected `controlBuildHash` from
trusted composition context and never accepts the receipt's own value as proof of the control
build that produced it.

### D2 TypeScript exit gates

D2 may be reported complete only when the production TypeScript effect boundary consumes the D1
bundle, requires the exact active v2 decision, and atomically creates the one-time execution claim
before invoking an effect. Tests must prove pending, rejected, expired, stale-CAS, identity, hash,
capability, correlation, occurrence, `executionId`, and claim-substate mismatches fail closed;
concurrent claim has one winner; restart and resume cannot replay a claim; both approved revision 1
and its revision-2 audit projection authorize the same single claim; audit-sink failure does not
revoke a valid decision; and ambiguous outcomes latch reconciliation. Source-boundary tests must
prove public execute/resume callers cannot inject an authorization grant or claim store, and that
legacy approval, `onConfirm`, manifest approval, and unattended mode never substitute for v2
authorization. Human-attestation and CLI/MCP tests must prove the decision tool records only the
exact decision and never executes the effect or exposes raw reason or attestation nonce.

The D2 implementation keeps both capabilities module-private. An advancing runner-v1
`lease_accept` receipt mints a nominal lease authority; only that authority can compose the effect
authorization port used by the worker. Public `executeRun`, `executeResume`, `RuntimeOptions`, CLI
admission callbacks, manifests, and unattended flags contain no grant or claim-store injection
surface. The TypeScript owner store uses:

```text
.openslack.local/workflows/effect-approvals/  canonical workflow_effect_approval.v2 records
.openslack.local/workflows/effect-authority/  intent lineage, decision WAL, execution claims, locks
```

The owner store persists an accepted runner-v1 intent before creating the exact pending approval,
revalidates the complete occurrence and human decision while holding the claim lock, and publishes
the first claim with create-if-absent semantics. The authority record carries a second durable
execution high-watermark, so deleting or rolling back the claim file cannot silently recreate
execution authority. A caught pending or reconciliation error is latched at run scope: the current
runner-v1 boundary is closed, no successor effect may start, and the run cannot report completion.
Pending becomes `paused_waiting_approval`; any post-claim uncertainty becomes
`WORKFLOW_EFFECT_RECONCILIATION_REQUIRED` and requires explicit recovery.
Owner-safe atomic writes use identifiable temporary files. Recovery completes a temporary only
after its canonical bytes, target hash, file identity, containment, and authority lineage validate;
conflicting or unknown evidence remains fail-closed. On Windows,
`openslack collaboration workflow approvals repair-security` audits legacy DACLs, while `--apply`
rebuilds exact owner-plus-SYSTEM ACLs only after complete canonical lineage validation.

The public workflow run/resume, profile-sync run, and TUI execution routes use the strict loopback
Workflow Runner client. It seals a descriptor, submits a hash-only JobSpec, polls JobView, and
checks the completed result hash against RunStore. Every resume has a new job/descriptor and the
same workflow run ID. No transport configuration means no execution; there is no direct-call
fallback. The runner remains admission/lease/fence authority, while D2 remains the sole effect
decision and execution authority.

### D3 observer exit gates

D3 may be reported complete only when a separate default-off, credential-free Go observer consumes
the three observer operations from an owner-only durable journal, recomputes parity, and returns
exact receipts without entering the authorization path. Cross-language qualification must cover
duplicate replay, fingerprint conflict, concurrency, restart, response loss, journal and record
tamper, stale approval/decision identity, audit pending versus recorded, bounded capacity,
default-off composition, and Go unavailable or mismatched while TypeScript behavior remains
unchanged. Passing those gates supports only
`GS9-D LOCAL_PASS / Go effect authority NOT_CLAIMED`.

The frozen observer transport is exactly:

```text
POST /v1/shadow/workflow-control/effect-events
Idempotency-Key: openslack.workflow-effect-control-shadow.v1.<sha256>
operations: approval_created | approval_decided | audit_recorded
```

The route is registered only by `effect-shadow-server` in `local-qualification-v1` mode with an
exact loopback workspace, caller, build, bearer hash, and `127.0.0.1:8084` bind. Disabled mode is
health-only. Migration `000005_create_workflow_control_effect_shadow` creates a fifth isolated
namespace, `workflow_control_effect_shadow_*`; it does not alter the GS8 runner, GS9-B authority,
or GS9-C checkpoint tables.

An accepted receipt is immutable and replayed byte-for-byte. The observer advances matched parity
only for a contiguous semantically matching source prefix. Fingerprint conflict, identity or
revision drift, tamper, expiry, and capacity failures are observer errors; a semantic mismatch is
durable parity evidence; an ambiguous commit is durable reconciliation evidence. None of these
conditions is authorization, retry permission, or a signal to roll back TypeScript. Raw human
attestation and reason, effect or audit detail, input, payload/result, provider data, credentials,
endpoints, transcripts, commands, and local paths are excluded from both wire and database.

The read-only decision/audit outbox is traversed by an opaque `(recorded_at,event_id)` keyset
cursor that preserves PostgreSQL timestamp precision. The TypeScript publisher keeps failed
entries durable, validates the closed remote error contract, retries only explicit transient
classes with delay capped at 30 seconds, and parks deterministic client failures until restart. A
202 receipt is immutable; an internal observer-only resolve route records separate accepted
closure evidence before the publisher removes its journal entry. Receipt `committedAt` is the
database transaction's acceptance timestamp, not a claim about post-COMMIT external visibility.
None of these recovery mechanics turns observer availability into effect authority.

## GS9-E1 budget operational contract freeze

GS9-E1 adds the TypeScript-owned `workflow-budget-authority/v1` exact-byte bundle and a Go exact
mirror whose role is validator-only. The closed contract covers the account, reserve request and
decision, provider usage evidence, settlement, ledger entry, exact receipt, and reconciliation.
Tokens, `nano_usd`, and calls use canonical non-negative signed-int64 decimal strings; operational
folds use integer arithmetic and never promote the existing local `costUsd` estimate to authority.
The frozen GS9-A authority v2 and Runner v1 bundles remain source-locked and byte-identical.

Provider evidence is bounded and hash-only. Each billable provider turn is distinct from a whole
agent invocation and binds its model, turn, usage, reservation, and call identity without storing
the prompt, response, endpoint, credential, or transcript. Missing, untrusted, unknown, or
overrun usage produces provider-outcome reconciliation and cannot silently release a reservation.
That condition remains distinct from a future database commit-unknown reconciliation.

The adapter treats `total_tokens` as the required authoritative quantity. Optional prompt and
completion splits are included only when present values are valid non-negative safe integers and,
when both are present, sum to the total. An invalid split or inconsistent pair omits both while the
exact total remains chargeable. Budget failure
therefore precedes later choice, finish-reason, or tool-shape errors for the same provider response.
The v1 account and run revisions are intentionally retained as two lockstep fields, and settlement
must not present revisions earlier than the reservation's opened revisions.

E1 itself has no database, migration, repository, HTTP API, route, server, runtime authority client,
production worker wiring, canary, or routing change. Its pure Go mirror cannot reserve, settle,
authorize, or persist anything. E2 consumes that mirror only inside a separately configured
qualification service.

## GS9-E2 durable budget qualification authority

GS9-E2 adds migration `000006_create_workflow_control_budget_authority` and five isolated
`workflow_control_budget_*` tables for account heads, semantic provider-turn reservations,
append-only ledger entries, exact receipts, and reconciliation evidence. It does not reuse or
modify the GS8 runner, GS9-B transition event, GS9-C checkpoint, or GS9-D effect tables. Existing
service profiles accept schema 6 while retaining their original minimum; the budget profile accepts
exactly schema 6.
The account head also stores an immutable canonical genesis account/hash. Recovery folds every
closed ledger kind from that anchor and must reproduce the current canonical account exactly.

The frozen E1 records remain non-authorizing operational projections with their original
TypeScript writer and `validator_only` Go role. E2 never stores or serves one as a standalone Go
authority record. Instead, every durable record is the canonical Go-owned companion envelope
`openslack.workflow_control_budget_durable_record.v1`, binding `workflow-control`,
`workflow-control/budget-authority-server`, `local-qualification-v1`,
`productionAuthority=false`, the exact E1 manifest SHA-256, trusted authority build hash, a closed
record kind, the embedded E1 projection, and its domain hash. Database columns and HTTP responses
must agree with both layers; cross-splicing either layer is an integrity failure.

The first reserve may create an account only from `expectedAccountRevision=0`. Reserve, durable
rejection, and settlement lock the GS9-B run head plus account/reservation rows in stable order,
validate the immutable route and `running` state, then advance the global run revision and the
independent account revision by one. The append-only budget ledger is the source for that run
revision, so no Workflow transition event is emitted. Ledger, receipt, and any known provider
reconciliation commit together.

An account/run revision mismatch caused by another run writer is a conflict, not an integrity
alarm, and E2 does not rebase it; GS9-F2b must coordinate the real future running-run revision
writers after the F1 transport foundation.

That first account is initialized only from a fixed, non-secret `BudgetSeed` in the
`local-qualification-v1` process composition: policy hash plus token, nano-USD, and call limits.
The seed is not part of the HTTP wire and is not a production initial-policy source.

Exact receipt point-read precedes state mutation. The same idempotency key and fingerprint returns
the original response bytes before active build or policy checks and without adding ledger
evidence; a different fingerprint conflicts.
Semantic uniqueness on reservation, call, and provider attempt rejects a duplicate provider turn
under a new key. An ambiguous database commit first recovers the exact receipt and otherwise records
an immutable database reconciliation only after rereading the request-bound run head under the
shared lock. That transaction advances the run once to `reconciliation_required` while leaving the
receipt's accepted revisions null; run drift or a second unknown recovery commit leaves no
unproved latch. Provider-outcome reconciliation remains a distinct, known transaction result.
It keeps the unresolved reservation open and latches the run. A settled reservation's close time
must equal its terminal ledger time. The shared GS9-B run writer checks an open budget
database-commit reconciliation under the same run lock, preventing another authority path from
bypassing ambiguity.
Restart rebuild also requires every provider-attempt ledger row to agree with the exact
provider-usage receipt bound by that row; drift is an integrity failure.

The standalone `/budget-authority-server` is health-only unless an exact loopback
`local-qualification-v1` binding fixes PostgreSQL, bearer, workspace, caller, routing epoch, and
service build. Its data surface is closed to reserve, settle, account, reservation, and receipt
operations. The default image entry point remains `/server`.

The qualification harness proves that a cache hit creates no budget mutation, provider execution
starts only after durable reserve, and cache visibility follows durable settlement. These are
qualification invariants only: GS9-E2 adds no production budget client or provider routing.
E2 also rejects every nonzero `resumeGeneration` without mutation; Runner v2 owns future resumed-run
budget delivery and is not part of this authority.

Its exact evidence ceiling is `GS9-E LOCAL_PASS / Go durable budget qualification authority / Go
production Workflow budget authority NOT_CLAIMED / Runner v2 NOT_DELIVERED / routing / canary /
cutover NOT_ACTIVATED`.
`WORKFLOW_BUDGET_PRODUCTION_INITIAL_POLICY_SOURCE NOT_DELIVERED` remains a separate non-claim.

## GS9-F1 runner v2 transport foundation

GS9-F1 adds only the default-off admission, storage, negotiation, and receipt-before-decision
transport foundation for the frozen authority-v2 runner messages. It does not mutate the frozen
runner-v1 or authority-v2 source bundles. The v2-required job binding fixes the authority
route/build/epoch, run revision, resume generation, and capability set before a lease is offered;
negotiation is exact and cannot downgrade to v1.

The store can bind an admitted event to the current job/attempt/lease/fence and
run/revision/generation/route, persist the event and exact runner receipt, and hold a later decision
boundary until that receipt is delivered. The local provider seam orders reserve before fetch and
settlement after the returned receipt around an opaque call; it does not propagate or bind
provider, model, or provider-run identity into the E authority contract. GS9-F1 does not call or complete the real GS9-C
checkpoint, GS9-D effect, GS9-E budget, or resume adapters, and it does not establish complete
runtime delivery or crash-after-authority recovery. GS9-F2b owns those adapters and exit gates
after F2a freezes their companion binding.

The F1 worker reserves the remaining total-token budget while independently bounding provider
output by the smaller output limit; settlement continues to charge prompt plus completion usage.
Its single receipt lane orders heartbeat, domain events, cancel acknowledgement, and terminal
without allowing a timer-driven heartbeat to create a fatal sequence collision. Resume advancement
mints a workflow resume identity distinct from the runner lease attempt; it does not rewrite the
lease identity carried by later envelopes and receipts. Receipt transport uncertainty for an
already persisted terminal cannot replace that terminal with reconciliation.

The service profile is `workflow-control-runner-v2-foundation-v1`. Its mechanical gate remains a
strict superset of the earlier GS7-B, GS8-B, and GS9-B/C/D/E repository checks, but its evidence
ceiling is only `GS9-F1 FOUNDATION LOCAL_PASS / runtime delivery NOT_CLAIMED`. Production v2
submission/routing, new-record acceptance, canary, TypeScript fallback removal, release, live,
Qoder, tag, npm, and production remain unclaimed or not activated.

## GS9-F2a authority-binding coordinator contract

The generated [GS9-F2a manifest](../../../packages/workflows/contracts/workflow-runner-authority-binding/v1/manifest.json)
is the normative authority-boundary record. Its operation table is the single source for target
kinds, coordinator deltas, source planes, source deltas, source receipt schemas, and the receipt-hash
algorithm for each deliverable kind; its protocol,
source-lock, framing, evidence, and closed boundary inventories are likewise authoritative. Other
architecture documents must link to that record rather than duplicate its matrices or
`NOT_CLAIMED` list.

F2a contributes the exact TypeScript contract and pure Go validator. The GS9-F1 runner store used a
narrow subset of that proof to validate the exact durable budget-receipt bytes, their SHA-256,
operation/status, reservation identity, and accepted budget source-run revision on fresh,
response-loss, and stored replay paths. F1 did not persist the full F2a source result or compose the
remaining domain adapters, scheduler/worker recovery, or future profile. TypeScript remains the
production Workflow authority; the F2b section below implements and qualifies the runtime
capabilities that the F2a manifest listed as not delivered.

A budget decision delivery is a post-event contextual proof, not a projection of the pre-event
resolution ACK. For `budget_reserve`, the control-delivery validator consumes the same exact E1
prepared request together with the durable accepted budget receipt, reserve decision, and ledger
entry. `reserved` authorizes the requested amounts; `rejected` authorizes zero. The control message
envelope binds the runner-global accepted revision, while `payload.committedRunRevision` binds the
independent budget source-run revision from the exact durable receipt; equality between those CAS
planes is neither required nor accepted as substitute evidence. The message also binds the SHA-256
of the exact canonical Go durable-receipt envelope,
whose operational projection is that same E1 receipt and whose manifest, build, writer, mode,
record kind, and projection hash are revalidated. An E1
`database_reconciliation_required` receipt has no accepted revision or durable result, so it closes
the runner boundary through a reconciliation-required event receipt and cannot generate a budget
authorization decision. This rule does not remove the frozen authority-v2 vocabulary; it prevents
the current E1 database-unknown evidence from being promoted into a fabricated committed revision.

Hash selection is kind-bound rather than caller-selected: `budget_authorization` uses SHA-256 of
the exact canonical durable receipt bytes, while `effect_authorization` and `resume_offer` use the
binding receipt domain hash. Kinds without an authority-receipt payload declare no algorithm. The
TypeScript and Go validators consume the same generated operation facts and one validation-session
cache, so this hardening removes structural drift and repeated parsing. The F2a live Go runner-store
check described above remains intentionally narrower; migration `000008` and the F2b recovery
protocol below persist and reconstruct the full decision/ledger source-result proof.

## GS9-F2b coordinator delivery boundary

F2b persists the companion stage, stage ACK, source resolution, resolution ACK, runner event,
event receipt, control-delivery ACK, optional decision, and decision ACK as one ordered binding
lifecycle. Global revision changes are operation-specific and independent from checkpoint/effect/
budget source revisions and from runner attempt/lease fencing. A source receipt cannot substitute
for the matching global-head CAS, and a durable event receipt cannot substitute for its worker ACK.

The worker consumes receipt, decision, and cancel controls through one serial inbound lane. Only an
accepted event receipt advances the persisted global revision; a decision validates that accepted
head and cannot overwrite it. Cancellation may use the operation's declared completion control
kind only at the next legal companion position. A non-contiguous or earlier cancel is acknowledged
as `reconciliation_required` on the existing receipt path and no second conflicting decision ACK is
written. Every ACK wait returns either `accepted` or `reconciliation_required`; the coordinator
must not send a dependent decision after the latter.

There is no independent 30-second ACK correctness deadline. The hard bound is the earlier of the
lease expiry and whole-job deadline. An in-process notification wakes the common wait path, while a
database point-read before and after waiter registration remains the durable fact and closes the
notification race. Explicit rejection, uncertain persistence, process cancellation, or expiry of
that hard bound latches reconciliation. A slow but successful ACK before the hard bound does not.

Exact-key replay is evaluated before current-attempt admission, so an initial `lease_accept` may
replay its original bytes after the attempt becomes running. Fresh, response-loss, and stored
replay paths revalidate the same binding/source evidence, sequence, revision, payload identity, and
durable receipt hash. The runtime-delivery profile admits only `go/workflow-control` v2 jobs;
`ts-local` submissions fail before they can remain queued. Checkpoint evidence is selected by the
requested phase index, budget decisions remain coupled to their durable source result, and effect
grants expire at the earliest of approval expiry, descriptor expiry, and sixty seconds after the
decision, with checks both before claim and immediately before the side effect.

The Go scheduler quarantines staged, resolved, runner-committed, or unacknowledged binding state
after process loss or lease expiry, discards its in-memory delivery view, and does not replay or
continue the TypeScript-owned source mutation. The binding remains reconciliation-required. An
explicit owner-local TypeScript recovery mode may point-read the original immutable source and
companion receipts under the same idempotency key; it never changes that key or invents a source
outcome. Cancellation may take a decision position only when its sequence remains valid; ambiguous
ordering is reconciliation-required. This is a qualification coordinator only: TypeScript remains
production Workflow state-machine and source authority, and GS9-G remains the first batch allowed
to route new production records to Go.

### GS9-G new-record routing and recovery

The ordinary TypeScript execution path remains the default and does not publish a durable route
receipt. An explicit process-immutable Go canary or higher-epoch TypeScript rollback first derives the
final backend, constructs exactly one matching descriptor, and then commits the descriptor-bound route
receipt. The policy stores only `backend`; `authority` is derived exhaustively as `workflow-control`
for Go and `typescript` for TypeScript while the existing receipt wire shape remains unchanged.

Every retry, resume, status read, and terminal replay point-reads the run's active or closed receipt.
Its correlation, selection time, policy hash, hashes, route epoch, and build remain immutable. A Go
receipt without its exact authenticated authority/runner composition is a configuration failure, not a
TypeScript fallback. Disabling `accept-new-records` or removing the current routing mode affects future
records only; active and drain epochs continue to read and transition records already accepted there.

Before a fresh Go receipt or authority accept is written, the composition compares authenticated CLI,
runner, and Workflow Control bindings for workspace, caller, modes, epochs, builds, origins, and token
digests. Tokens never enter the receipt or public status. Exact receipt replay is checked under the
repository lock before fresh-accept policy, so disabling acceptance cannot break idempotent recovery.
Stored bytes are validated before an epoch mismatch is classified as conflict; route drift is never
misreported as store corruption.

The owner-only journal has `active`, sharded `closed`, `quarantine`, `policies`, and `locks` partitions.
The 4,096 bound applies only to simultaneously active explicit routes. Terminal evidence may close a
receipt atomically; unknown or damaged requested evidence stays reconciliation-required. The repair
command is audit-first and never deletes an unproved active receipt. Go recovery projections are
authority-derived caches: safe nonterminal heads may be reconstructed or advanced by the dedicated
transition policy, while terminal/output ambiguity propagates a typed reconciliation error. Projection
repair never reruns a workflow effect.
