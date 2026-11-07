---
schema: openslack.document.v1
id: architecture-task-claim-v2-c0
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: github-task-loop
updated: 2026-11-07
sources:
  - design/cdd/modules/github-task-loop.md
  - docs/architecture/control-manifest.md
  - docs/architecture/adr/adr-0005-task-claim-v2-single-host.md
  - docs/reference/vectors/task-claim/task-claim-v2-c0-vectors.json
  - docs/reference/schemas/task-claim/task-claim-v2-c0.schema.json
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

The 2026-11-03 amendment is a **review candidate**, not acceptance of
[ADR-0005](../adr/adr-0005-task-claim-v2-single-host.md). It implements no C1
kernel, Go service, database migration, registered action or writer cutover.
Its data-only vectors freeze proposed bytes; they do not establish TS/Go
implementation parity. C0 remains incomplete until the exact candidate receives
independent architecture/security recommendations and the required decision
acceptance. No old review or merged document supplies that acceptance.

## First-Version Authentication and Delegation

The first authority is Linux/WSL2, one host, one activated authority, PostgreSQL
and a pathname Unix domain socket. TCP, remote clients, native Windows authority
and automatic failover are out of scope. Consumer compatibility tests on Windows
do not qualify a Windows server. The authority runs as a dedicated service UID;
the Agent and cleanup Broker have different dedicated UIDs and principals.

The kernel's `SO_PEERCRED` identifies the connecting process credentials, not a
run, a current task lease or a cryptographic delegation. An administrator-owned,
immutable session table binds host/boot/UID, runtime UID, principal, run,
session ID, session generation, validity and revocation. Admission verifies that
table and the current activated generation on every mutation. Request subject
fields are expectations only. A header, local identity file, caller-supplied PID
or JSON object cannot create a session. C2 must specify and test process-birth
and connection lifetime checks, bounded framing and shutdown before deployment.

An execution UID cannot be reassigned until the old run's processes and open
connections are proved gone. Reconfiguration requires closed admission and a
new activation; an old connection cannot inherit a new run. Session sockets
and credentials must not be inherited by untrusted children or passed to other
agents. A child/delegate needs its own scoped session; copying a parent's run
ID grants nothing. This is not containment against root, a process with the
same authorized UID, or access to the Docker socket/sudo. Actual OS separation
and process supervision remain independent qualification requirements.

An Agent acquires/renews its own Claim through its own session. A cleanup Broker
authenticates as a **service** principal, not the Agent principal. An authority-
stored delegation/reservation must bind that service, the Agent session,
task/definition, exact Claim/epoch/revision, policy, Permit, action, resource,
generation and deadline. The Broker presents its opaque reference; the
authority loads and verifies the original binding. `body.agent` plus a trusted
Broker UID is not delegation. Delegation cannot expand scope or survive its
parent session/Claim revocation. It does not lend the Agent a deletion token.

## Proposed v2 Record and Operation Contract

The C0 candidate record schema is `openslack.task_claim.v2`. Objects are closed:
unknown fields, duplicate JSON keys, missing required fields and malformed
Unicode are errors. Integers that can grow over a service lifetime are canonical
non-negative decimal strings, never JavaScript numbers. Epoch and revision
start at `"1"`; leading zeros and numeric JSON representations are rejected.

| Required field                       | Contract                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claimId`                            | Authority-generated unique identifier for this acquisition; never reused.                                                                                    |
| `task`                               | Workspace ID, provider `github`, host, stable repository ID, Issue node ID/number, task ID, definition schema and full SHA-256 definition digest.            |
| `holder`                             | Authenticated principal ID, runtime UID, run ID, session ID and session generation, derived from the service session and compared with request expectations. |
| `authority`                          | Backend `go`, activation generation and routing epoch. A restored database alone cannot activate a generation.                                               |
| `claimEpoch`                         | Persistent task-slot reassignment counter; increases on each new acquisition, not heartbeat.                                                                 |
| `revision`                           | Monotonic task-slot transition counter; increases on every accepted transition, including heartbeat and terminal state.                                      |
| `state`                              | Lifecycle vocabulary: schema `$defs.state`; transition meaning below.                                                                                        |
| `closingReason`                      | Null for active; `release` or `complete` for closing; preserved as terminal history.                                                                         |
| `phase`                              | Work phase: schema `$defs.phase`; review phase is not human approval.                                                                 |
| `issuedAt`, `renewedAt`, `expiresAt` | Authority UTC timestamps; request timestamps cannot extend validity. Expiry is exclusive.                                                                    |
| `policyRevision`, `lastOperationId`  | Exact governing policy revision and last committed transition identity.                                                                                      |

The stable task slot and its epoch/revision survive terminal transitions and
reacquisition. They are not deleted when a claim is released. Immutable claim
versions, operation receipts, events, execution reservations and projection
outbox entries belong to the same PostgreSQL transaction as the slot change.

All mutation requests bind an operation ID before sending, the task identity,
definition digest, authority generation/routing epoch and expected slot
revision. Operations on an existing lease additionally bind claim ID, epoch
and holder. Authentication supplies the actual holder; body fields cannot
create it. Acquisition also supplies the expected terminal/empty-slot state.

| Operation                   | Required condition and effect                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acquire`                   | Eligible task and authorized session; empty/terminal slot with no unresolved operation. New claim ID and epoch; one winner.                              |
| `heartbeat`                 | Exact live active claim and revision; renew within authority policy TTL. No revival of expired/revoked claims.                                           |
| `set_phase` / `submit`      | Exact active lease, allowed phase transition and artifact binding; no implicit human approval.                                                           |
| `begin_close`               | Exact live active lease; store release/complete intent, reject new effects and preserve unsettled operations.                                            |
| `release` / `complete`      | Exact live closing claim, matching close intent and settled operations; completion additionally requires policy delivery evidence. Write terminal state. |
| `expire`                    | Authority time at/after expiry and expected unchanged revision; heartbeat racing it cannot also win.                                                     |
| `revoke`                    | Authorized administrator, expected current generation/slot revision; outstanding execution is frozen for reconciliation.                                 |
| `repair`                    | Rebuild projections from authoritative records or reconcile operation receipts; never mint ownership from comments.                                      |
| `observe` / `get_operation` | Authenticated read of current state or original receipt; no mutation and no reusable execution authorization.                                            |

Same operation ID and canonical request digest returns the original receipt;
same ID with different request returns `OPERATION_CONFLICT`. It does not
revalidate and perform a second mutation. Distinct operations against a stale
revision return `REVISION_CONFLICT`. The closed error vocabulary is defined by the schema's
[`$defs.error`](../../reference/schemas/task-claim/task-claim-v2-c0.schema.json#/$defs/error).
Clients do not convert a failure into a legacy write or automatically retry
against a newly observed revision.

### Closed schema and validation/error order

The [candidate JSON Schema](../../reference/schemas/task-claim/task-claim-v2-c0.schema.json) is normative for exact
nested keys, required/null fields, per-operation payloads, receipts, observations
and errors. It is data only, not an enabled API. Use
[`$defs.mutationRequest`](../../reference/schemas/task-claim/task-claim-v2-c0.schema.json#/$defs/mutationRequest)
for the closed mutation fields, and `$defs.state`/`$defs.phase` for lifecycle
vocabularies. The authenticated `actor` and expected Claim `holder`
are distinct: a service cannot establish a holder by sending these fields.
`acquire` requires holder equal to its authenticated Agent actor. Service/admin
operations additionally require administrator policy/session role; request
shape cannot grant that role. `observe`/`get_operation` use the separate query
schema and cannot mutate, expire a lease or acquire an execution reservation.

Validate in this order, with no fallback and no implicit JSON coercion:

1. Authenticate kernel peer against the fixed session/current generation.
   Missing session returns `UNAUTHENTICATED`. This step does not read or compare
   supplied actor fields before bounded decoding.
2. Bound and decode raw UTF-8/JSON. Size, BOM, duplicate decoded keys, lone
   surrogate, JSON number or malformed JSON returns `REQUEST_INVALID`.
   Unsupported discriminator/domain returns `UNSUPPORTED_VERSION`. Then validate
   closed schema and semantic integer/calendar/ordering constraints. Rejection
   vector reasons such as `DUPLICATE_KEY` are bounded codec diagnostics, not
   extra API errors; their API code is `REQUEST_INVALID`. Unknown-field detection
   precedes missing-field diagnostics, followed by field-type/value validation.
   Then compare decoded actor with the authenticated session (SUBJECT_MISMATCH)
   and check role/task scope (PERMISSION_DENIED), before reserving an operation ID.
3. Only authenticated, schema-valid and task-scope-authorized requests can claim
   an operation ID. IDs are unique for the workspace across tasks and actors.
   Same ID/digest/actor returns its original receipt; another digest or actor
   returns `OPERATION_CONFLICT` without disclosing the stored request/receipt.
   Canonical request bytes are retained exactly, not reserialized from jsonb.
4. In a transaction, lock/create the unique task slot, then sample authority
   time. Check activation generation, expected revision/slot/Claim/holder,
   stored definition binding and the **operation-specific** state/time/reservation conditions
   in the transition table. Return respectively `AUTHORITY_NOT_ACTIVE`,
   `REVISION_CONFLICT`/`CLAIM_NOT_CURRENT`/`SUBJECT_MISMATCH`,
   `DEFINITION_CHANGED`, `CLAIM_REVOKED`/`LEASE_EXPIRED`/`CLAIM_NOT_CURRENT`,
   `UNSETTLED_OPERATION`, then `PHASE_TRANSITION_INVALID`/`TASK_INELIGIBLE`/
   `EVIDENCE_UNAVAILABLE`. A counter beyond its 78-digit schema bound returns
   `COUNTER_EXHAUSTED`, never wraps or resets. An oversized incoming integer is
   REQUEST_INVALID at step 2; COUNTER_EXHAUSTED concerns incrementing an otherwise
   valid stored counter. The bound is not a capacity measurement. No-unsettled
   applies to acquire/release/complete. It is not a global guard: begin_close,
   expire and revoke preserve/freeze unsettled reservations, and repair may
   reconcile them. Service expiry/revocation uses its own time condition rather
   than the holder-only live-lease rule. Thus pending work cannot block its own
   revocation or reconciliation. Heartbeat/phase/submit preserve existing
   reservations without creating new execution admission.
   Current business-definition freshness is required for acquire, heartbeat,
   phase/submit, completion and new effect admission. Existing-Claim requests
   always bind the original stored task/digest. Nonexecuting begin_close,
   release, expiry, revocation and repair validate that exact retained binding,
   not a newly fetched GitHub definition. A changed/unavailable business source
   therefore cannot block freezing, abandoning or reconciling the old exact
   Claim, and those operations never regrant execution. Reacquire instead binds
   the newly authorized current definition while preserving terminal history.
5. Commit immutable request/decision/receipt and any slot version/event/outbox
   in one transaction. A valid new operation rejected by step 4 gets a durable
   rejected receipt with unchanged before/after state. Steps 1–3 and unavailable
   storage return only `openslack.task_claim_error.v1`, `recorded:false`, never a
   fabricated receipt. Storage outcome unknown is `RECONCILIATION_REQUIRED`;
   query that operation, do not resend a mutation.
   `recorded:false` describes this error frame: it is not an authoritative
   durable receipt. In an unknown database-commit outcome it does **not** assert
   that the original operation failed to commit. Preserve that uncertainty and
   query its receipt; absence in an old restored backup is not nonexecution proof.

No state transition precedes the unique operation-key reservation. Empty-slot
acquire uses atomic unique-slot creation/locking; an empty query followed by an
unconditional insert is insufficient. C2 must qualify that transaction. Request
digest covers every schema field including actor/session, holder, task,
authority, expected state and payload. Reads use access control without entering
the mutation namespace. Historical access does not revive a revoked session.

### Deterministic transition relation

Accepted transitions of an existing Claim keep its epoch and authority
generation, and increase slot revision by one. Fresh acquire/reacquire instead
binds the **currently activated** generation/routing epoch while retaining prior
Claim versions and monotonically increasing the slot epoch/revision. A retained
terminal Claim from an older generation is not relabeled or reactivated.
Terminal states are
completed/released/expired/revoked. A terminal state is immutable except new
acquisition or privileged repair that never changes lease semantics. Rejections
do not advance slot revision. Acquisition chooses a fresh Claim ID, increments
retained epoch/revision, sets active/executing, null close reason and issued/
renewed/expiry from one authority time observation. With a new slot starting at
epoch/revision 1/1 and at least one terminal transition before every reacquire,
reachable records satisfy revision >= 2\*claimEpoch-1. Validate this integer
invariant without JS numeric coercion. Codec-only vectors need not be reachable
states; full Claim/operation transition vectors must be.

### Observer proof invariants

An observation is a point-in-time read, never an effect ticket. It performs no
read-triggered expiry mutation. Its task/definition facts must be freshly
observed through the authority's reviewed business-fact reader; unavailable
inputs cannot be replaced by an old valid-looking lease. `definitionObservation`
binds the current definition digest, v1 source-snapshot digest and observation
time. Consumers compare all task identity fields, definition schema/digest,
current generation/routing epoch and holder/session evidence, not a boolean alone.

| Status          | Required proof relationships                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| current_valid   | Non-null authority/claim/definitionObservation/observedAt; strongClaimProven=true, reason=null. Claim active, issuedAt <= renewedAt <= observedAt < expiresAt; fresh definition digest equals Claim task definition; stable task and authority fields exactly equal the outer observation/current authority. Session unrevoked and policy current at observation. |
| not_current     | strongClaimProven=false, non-null authority/time, non-null stable reason. Claim may be retained historical data, never permission. Expired active record reports LEASE_EXPIRED; revoked reports CLAIM_REVOKED; changed definition reports DEFINITION_CHANGED.                                                                                                     |
| legacy_observed | claim=null, authority=null, definitionObservation=null, observedAt=null, strongClaimProven=false, reason=CLAIM_NOT_CURRENT. Do not mint a v2 record or trusted authority time from legacy data.                                                                                                                                                                   |
| unavailable     | claim=null, authority=null, definitionObservation=null, observedAt=null, strongClaimProven=false, reason=EVIDENCE_UNAVAILABLE or AUTHORITY_NOT_ACTIVE. No cached proof.                                                                                                                                                                                           |

The schema encodes simple status/null/proof constraints; timestamp ordering,
source freshness and cross-object equality remain explicit semantic validation.
The request's task identity and actual authenticated access scope also have to
match. A consumer receiving contradictory observation fields rejects evidence
as EVIDENCE_UNAVAILABLE, never ignores the contradiction or reads true as a
grant. Historical receipt access does not turn this observation into execution.

| Operation   | Required state/time and actor                                                                             | Exact next state / fields                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| acquire     | Authorized Agent; expected absent/terminal slot; current definition/eligibility, no unsettled reservation | New Claim as above. First epoch/revision 1; absent differs from retained terminal revision.                                                      |
| heartbeat   | Holder Agent, active, time strictly before expiry                                                         | Same state/phase; renewedAt=time, expiresAt=time+bounded policy duration; no epoch change.                                                       |
| set_phase   | Holder Agent, live active                                                                                 | Change between distinct executing/awaiting_review/awaiting_dependency; self-change is PHASE_TRANSITION_INVALID. No renewal.                      |
| submit      | Holder Agent, live active, executing or awaiting_dependency; exact accepted artifact                      | awaiting_review; state active; no renewal/human approval. Already awaiting_review is PHASE_TRANSITION_INVALID.                                   |
| begin_close | Holder Agent, live active                                                                                 | closing with payload reason release/complete; phase/expiry retained; prior reservations may only finish/reconcile.                               |
| release     | Holder Agent, live closing, reason release, settled operations                                            | released; phase, reason and timestamps retained.                                                                                                 |
| complete    | Holder Agent, live closing, reason complete, settled operations; policy verifies completion digest        | completed; preserve history. Caller digest alone is not completion evidence.                                                                     |
| expire      | Authority service, active/closing, time at/after expiry                                                   | expired; preserve epoch/phase/history. Before expiry TASK_INELIGIBLE. Unsettled reservations still block reacquire.                              |
| revoke      | Administrator session, active/closing, any expiry                                                         | revoked; unresolved reservations frozen for reconciliation.                                                                                      |
| repair      | Maintenance service, exact current state/revision, authority-owned inspection ID/digest                   | Same state/phase/expiry/epoch; revision increments for event/outbox or settled reconciliation. Never adopt caller evidence or regrant execution. |

Holder-only operations on wrong terminal/current Claim return CLAIM_NOT_CURRENT
(revoked returns CLAIM_REVOKED). Live-state expiry returns LEASE_EXPIRED before
phase checks; wrong close reason is PHASE_TRANSITION_INVALID. Service/admin
operations check their own actor role, not forged holder fields. Already terminal
expire/revoke returns CLAIM_NOT_CURRENT. Same-operation replay returns the original
receipt without a second transition. Process termination or target absence alone
cannot settle an external effect. C3 cannot bypass unsettled state.

The receipt schema candidate is `openslack.task_claim_operation.v1`: operation
ID, canonical request digest/domain, authenticated actor/session, task identity,
authority generation/routing epoch, before/after Claim identity and revision,
decision (`accepted`, `rejected`, `reconciliation_required`), stable error code
or null, database observation time and projection-outbox ID or null. No token,
prompt, arbitrary task body or private provider reply belongs in a receipt.
One operation's immutable request and receipt are committed with its transition;
replay returns those original bytes and does not renew a lease. Authentication
and receipt access control still apply to replay. Session validity is required
for writes; authorized historical reads do not require a still-live Claim.

Acquire distinguishes an empty slot from revision `"0"`; the empty-slot token is
the explicit literal `absent`, never a missing precondition. Rejected operations
are also durably bound to their request and result. An ID cannot be reused for
a corrected request. An unavailable database returns no fabricated receipt;
query the original operation after recovery. Wire framing is UTF-8 JSON with a
64 KiB mutation request, 128 KiB receipt and 1 MiB definition projection limit.
These conservative first-version bounds prevent unbounded single-host admission;
they are not measured capacity claims. Identifiers are nonempty ASCII strings
of at most 128 bytes with no controls; numeric IDs and counters use the decimal
rules above. Authority timestamps are UTC `YYYY-MM-DDTHH:mm:ss.ffffffZ` (six
fractional digits), compared as database instants without lossy JS Date
round-trips. Lease durations must be positive and within administrator policy;
C2 reviews SQL types, isolation level, lock ordering and policy bounds before
enabling endpoints.

### Authority time and recovery

Sample PostgreSQL authority time **after** acquiring the task-slot lock, then
compare the exclusive expiry boundary (`time < expiresAt`). Transaction-start
`now()`/`CURRENT_TIMESTAMP` cannot decide validity after a lock wait. A heartbeat
queued before expiry but admitted after expiry is rejected; it never revives
the Claim. C1 uses an injected authority clock; C2 must reproduce this property
against PostgreSQL `clock_timestamp()` and the actual lock order. Keep a single
sample for the transition and receipt, with finite policy TTL bounds.

Clock rollback/uncertainty closes new admission rather than extending a lease.
Store restored from an older backup cannot enable writes by reading its own
old `active` generation. Administrator-controlled fresh activation, preserved
generation history and unresolved-operation reconciliation are required; old
leases, delegations and execution reservations stay nonexecuting. Missing
generation history or time evidence fails closed. No automatic failover.

## Definition Digest and Execution Admission

Retain `issue_task_snapshot.v1` unchanged as the observation/reread snapshot.
Introduce `openslack.task_definition.v1` with an explicit closed projection:
stable task/repository/Issue identity, Issue title, requirement prose, parsed
manifest title/type, execution scope, success criteria/output contract,
required capabilities and risk constraints, allowed/forbidden paths, and substantive labels. Include unknown
non-lifecycle labels conservatively; do not ignore all labels.

The manifest's lifecycle `status`, owner/heartbeat observations, comments and
Issue `updated_at` are excluded from this definition. Only the exact governed
lifecycle-label set is excluded: `openslack:ready`, `openslack:claimed`,
`openslack:running`, `openslack:review`, `openslack:done`, `openslack:blocked`.
Their current values and Issue open/closed state are still checked separately
for admission. The existing v1 parser currently selects the first matching
fence, and its root schema is not closed. It does **not** already establish
these v2 guarantees. The new definition projector must add exactly-one-fence,
duplicate-key and closed-field checks before calling the unchanged v1 parser;
ambiguous input fails closed. Neither the v1 parser nor the v1 observation hash
is redefined by this amendment.

The closed definition and shared task identity fields are specified by
[`$defs.definition`](../../reference/schemas/task-claim/task-claim-v2-c0.schema.json#/$defs/definition)
and `$defs.taskIdentityFields`; numeric IDs are decimal strings.
`prose` is the exact body outside the unique complete manifest fence, retaining
all remaining whitespace, line endings and Unicode. Remove exactly the opening
fence line (with its LF or CRLF), enclosed manifest bytes and the closing three
backticks; preserve bytes after those backticks, including the following line
terminator. The v2 canonical source requires one column-zero `openslack-task`
fence. A second task fence or schema-bearing YAML task fence is ambiguous;
other prose/code is not silently interpreted as another task. Do not trim or
normalize text; unsupported legacy fence shapes require an explicit reviewed
definition update, not reinterpretation of v1 history.
The manifest projection's retained fields are specified by
[`$defs.manifest`](../../reference/schemas/task-claim/task-claim-v2-c0.schema.json#/$defs/manifest),
which references the pinned canonical v1 properties except for the declared
lease representation and set constraints.
`status` and `linked_pr` are lifecycle-only exclusions. Unknown manifest keys
are rejected, not silently dropped. Optional absent fields stay absent; empty
arrays/strings are distinct and remain subject to the field's validation.
The lease keys `ttl_minutes` and `heartbeat_minutes` become canonical positive
decimal strings while retaining the pinned v1 numeric ranges and unchanged
parser input contract.

`labels`, `required_capabilities`, `allowed_paths`, `forbidden_paths`,
`output_contract` and `human_approval_required_for` are exact-string sets:
reject duplicates, sort by UTF-16 code units, no case folding or path rewriting.
`success_criteria` retains order. Reordering an ordered acceptance list changes
the definition; reordering a set does not. A substantive label removal or an
unknown label addition changes the definition. Lifecycle exclusions still
participate in separate current task-eligibility checks.

### Frozen candidate byte profile

R6 keeps the candidate schema ID and runtime v1 parser unchanged. The machine
authorities live under Reference; unchanged manifest properties reference the
canonical v1 schema. The vector header pins its path, schema ID and raw-byte
SHA-256. A source-schema edit requires explicit re-review and re-pinning.
`docs:verify` checks this binding, strict codec bytes/digests, all schema-bearing
examples, rejection layers and static example references on every invocation.
It reports codec-only cases separately from schema cases. Projection and
transition examples receive static consistency checks; execution by independent
C1 TS/Go state machines remains NOT_RUN. R5 recommendations apply only to the
[retained R5 revision](https://github.com/Negentropy-Laby/OpenSlack/tree/5683d1a7843a8f3b0fbea1383d3054ff083f0058),
not to these revised bytes.

Use restricted RFC 8785 JCS: UTF-8 without BOM/trailing LF, recursive UTF-16
property ordering, exact array order, JSON escaping, no Unicode normalization,
no lone surrogates or duplicate decoded keys. JSON numbers are forbidden in
the projected definition and operation bytes; counters, IDs and durations use
canonical decimal strings. No implementation may round a large numeric ID.
Domain-separated digest input is UTF-8(domain), one NUL byte, then canonical
bytes. Domains are `openslack.task_definition.v1`,
`openslack.task_claim_request.v2`, `openslack.task_claim.v2` (version bytes) and
`openslack.task_claim_operation.v1` (receipt bytes) and
`openslack.task_claim_observation.v1` (read-only observation bytes); digest display is `sha256:` plus 64 lower-case
hex characters. Reject unsupported domains/versions before comparison.

[Data-only vectors](../../reference/vectors/task-claim/task-claim-v2-c0-vectors.json) contain raw UTF-8/base64 input,
expected canonical bytes/base64, length and digest, plus explicit rejection
cases. They freeze the proposal, not a service implementation. C1 must execute
the same accepted/rejected vectors in independently implemented TS and Go,
including astral UTF-16 key ordering, escaped duplicate keys, large counters,
and composed/decomposed text. C0 does not introduce a hash producer.

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

### First Claim-required consumer (future C3 only)

Reserve the name `pr.cleanup_branch_claimed.v1` for a separate future action.
It requires a valid precise Permit **and** the authority's current Claim and
one-use execution reservation, plus all existing cleanup resource checks.
Policy at the authority decides this conjunction; no flag can disable it.
This amendment does not register, enable or grant that action. Existing
`pr.cleanup_branch_scoped.v1` remains Permit-only with `claimRequirement:
not_required` / `claimStatus: not_evaluated`.

The Claim belongs to a separate **cleanup task**, never the completed source
development task. An active source-task Claim or other live branch dependency
continues to block deletion. A claimed cleanup task cannot bypass that blocker.
The service authenticates its own delegation and verifies the Claim again at
the actual effect-admission boundary. An admission receipt is not a guarantee
that all external GitHub state remains unchanged until the request completes.

`active` plus a still-valid expiry is necessary for new admission; merely not
having persisted `expired` is insufficient. `closing` accepts no new effects.
Already admitted operations may finish bounded cleanup or reconcile. Neither
terminal phase information nor a successful historical receipt grants a new
execution. Reacquisition cannot bypass an unsettled reservation.

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

### Source inventory at b8b11ed64238c3b622d110e5d2d11944a342609e

These are current legacy paths, not v2 producers. A source search is not proof
that no old deployed binary or credential remains; C6 must inventory those too.

| Current owner / path                                                                                                         | Actual entrypoints and required migration                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub acquire — `packages/github/src/claims.ts`                                                                             | `claimIssueTask`, private `rollbackClaimRef`, `projectClaimLabels`, `reconcileExistingClaimProjection`; disable old authority writes in migrated scope. Exported `expireIssueClaim` also deletes refs; no in-repo caller found, but exported callers remain possible. |
| Lease lifecycle — `packages/github/src/claim-lifecycle.ts`                                                                   | `heartbeatClaim`, `reviewClaim`, `completeClaim`; completion deletes the ref. No separate remote `releaseClaim` exists. Replace exact old-instance writes, not just claim creation.                                                                                   |
| Repair — `packages/github/src/repair.ts`                                                                                     | `repairExpiredClaims`, `currentClaimEvidence`, `effectiveExpiry`, `deleteClaimRef`, `setReadyProjection`, `setClaimedProjection`; `repairLabels` is projection maintenance, not lease recovery authority.                                                             |
| Lifecycle projections — `packages/github/src/lifecycle.ts`                                                                   | Exported `markIssueRunning`, `markIssueBlocked`, `markIssueDone` write labels/comments. `markIssueDone` does not close the Issue. Fence/reroute projections through the v2 outbox.                                                                                    |
| Automatic admission — `packages/runtime/src/tick.ts`                                                                         | `tickAgent` selects GitHub or local sources. Explicitly separate those authorities; local lease is not remote proof.                                                                                                                                                  |
| Watch — `apps/cli/src/commands/watch-auto-claim.ts`, `packages/github/src/{watch-daemon,workspace-watch}.ts`                 | `buildAutoClaimFn`, `WatchDaemon.processIssueEvent`, `startWorkspaceWatchDaemon`; cover polling, webhook, startup, configured agent loops and old processes.                                                                                                          |
| CLI producers — `apps/cli/src/commands/{agent,github,task}.ts`                                                               | `agent tick`; claim heartbeat/review/complete; deprecated `issue-done`; `repair-claims`/`repair-all` and `repair claims/all`; `task sync` calls `proposeWorkspacePR` then `reviewClaim`. All aliases must obey the same fence.                                        |
| Local authority — `packages/core/src/claim-broker.ts`                                                                        | `ClaimBroker`/`FileClaimBroker`: `setTaskReady`, `claimTask`, `heartbeat`, `releaseLease`, `expireLease`, `getActiveLease` (may expire during read). File persistence `.openslack/leases/lease-state.json` retains its local role; no relabeling as remote v2.        |
| Legacy observations — `packages/github/src/{claims,claim-lifecycle,issue-tasks,issue-task-snapshot,manifest,task-filter}.ts` | Claim/heartbeat/review comment parsers and owner resolution; ready-task reads, `createIssueTaskSnapshot`/`issueTaskSnapshotMatches`, manifest extraction and `runAutoClaimGates`. Preserve v1 bytes and distinguish current eligibility from lease authenticity.      |
| PR/task association — `packages/runtime/src/propose.ts`, `packages/core/src/task-link.ts`                                    | `proposeWorkspacePR`, task-link render/parse, `parseTaskLinkMarker`, `issueClaimRef` identify associations only. A marker is never current ownership.                                                                                                                 |
| Source-task blocker — `packages/github/src/branch-evidence.ts`, `packages/pr/src/cleanup-branch.ts`                          | `claimRefPresent`, `runCleanup`, `cleanupPRBranchThroughBroker`: retain conservative source dependency rejection, independent of the cleanup-task Claim.                                                                                                              |
| Broker task view — `packages/pr/src/internal/cleanup-broker-executor.ts`                                                     | `checkTaskView` checks administrator-fixed dependency evidence; it does not establish a current Claim.                                                                                                                                                                |
| Graph — `packages/organization-graph/src/software-delivery-projector.ts`                                                     | `addClaims`/`projectSoftwareDeliverySnapshot` currently project local-store ref/SHA/freshness. Future status must distinguish `legacy_observed` / `strong_claim_not_proven` from live v2 proof.                                                                       |
| Harness consumer — `packages/agent-runtime/src/harness-task-authority.ts`                                                    | `createHarnessTaskAuthority` consumes `source.readLease` owner/expiry/ref. Migrate separately; historical reconciliation must stay nonexecuting and not require renewed execution rights.                                                                             |
| Collaboration/TUI — `packages/collaboration/src/{events,types,digest}.ts`                                                    | `task.claimed`/`released` are projections. No current strong-Claim TUI endpoint was found; future TUI consumes safe typed observations, never infers authority from events.                                                                                           |
| Local identity — `packages/runtime/src/identity.ts`                                                                          | `resolveAgentPrincipal`/`resolveAgentStatusBinding` establish local identity, not a task lease or service delegation.                                                                                                                                                 |

### Cutover and rollback protocol

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

For one bounded repository/task scope, the cutover record must identify the
administrator-owned routing policy, old binary/process/credential inventory,
closed admission observation, drain/reconciliation result, and denied writes
from each legacy producer/alias. Revoke or remove their direct GitHub write
credentials in that scope; new external credentials are confined to the
controlled Broker. Workers must not retain a usable bypass token. A new ref
namespace or UI version warning is not that fence. If repository-level App
permissions cannot isolate the selected scope, do not activate mixed writers;
reduce the rollout scope or keep the old scope entirely on the old authority.

Old comments, refs and local leases display `legacy_observed` /
`strong_claim_not_proven`. Do not synthesize run IDs, generations or epochs,
rewrite their digests or delete old refs to make a migrated slot look empty.

Rollback closes new admission first, drains/reconciles in-flight operations,
preserves v2 records and read-only observation, and leaves the old writer
fenced. Deleting v2 fields, reverting to unconditional ref writes or clearing
terminal evidence is not a rollback procedure. Destructive migrations and
deployment changes require a separate reviewed implementation deliverable.

### C1–C3 task decomposition (not ready)

| Task draft                                                                                                   | Dependency / scope                                                                                    | Required acceptance, before downstream admission                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [C1 #429](https://github.com/Negentropy-Laby/OpenSlack/issues/429) — state kernel and canonical conformance  | Exact accepted C0/ADR-0005; isolated new module/contracts/tests only, no service or production writer | Independent TS/Go vectors; one winner; same-agent different-run rejection; epoch/revision/CAS; injected clock; same-key receipts/conflicts; terminal retention. No live authority claim.                                     |
| [C2 #430](https://github.com/Negentropy-Laby/OpenSlack/issues/430) — PostgreSQL authority and local sessions | C1 accepted and verified; separately reviewed module/schema/session installation scope                | Transactional slot/outbox/receipt, authority time after lock wait, immutable Unix session/delegation, restart/old-backup activation refusal, credentials confined, no TCP or Windows server. No migrated admission yet.      |
| [C3 #431](https://github.com/Negentropy-Laby/OpenSlack/issues/431) — independent claimed cleanup admission   | C2 qualified plus separate action/policy/grant review                                                 | New `pr.cleanup_branch_claimed.v1`, cleanup-task Claim plus Permit, service delegation, final-boundary fence, single reservation, stale worker denied, unknown external result reconciliation; Permit-only action unchanged. |

These are blocked backlog tasks, never active claims or ready labels. The
default credential-store preflight failed on 2026-11-03; the already authorized
PEM-backed bot runtime subsequently returned READY_FOR_PROBE. Publish only
through the supported bot task path after semantic duplicate checks. C1–C3 are not implemented
or made ready by writing this table. Documentation reviews and exact acceptance
remain separate, and administrative/CI gaps are not relabeled code completion.

## QA Layers and Required Future Evidence

All rows are **PLANNED / NOT_RUN** for Claim v2; legacy regression success is
not v2 evidence.

| Layer / classification | Required cases and evidence                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract / API         | Strict schema, unsupported versions, principal/task/digest mismatch, missing authority and bounded error vocabulary; explicit zero mutation on rejected observations.            |
| Auth / Permission      | Forged comments/refs cannot mint ownership; stale epoch/run cannot heartbeat/release/repair; old writer credentials cannot modify the newly admitted scope.                      |
| Workflow / Concurrency | Concurrent claim has one winner; expiry versus heartbeat is atomic; duplicates preserve one operation; lost response reconciles without taking over a new epoch.                 |
| Data / Migration       | Normal label changes do not drift task definition; real requirement changes do; old records unchanged; no dual writers; terminal history retained; restart restores exact state. |
| Ops / Recovery         | Authority/database restart, unavailable database, expired credentials, interrupted cutover, close-admission/drain rollback and repair of unknown outcomes.                       |
| Hosted compatibility   | Same candidate Linux/Windows consumer checks and Go/PostgreSQL integration; old-client refusal without field stripping.                                                          |
| Isolated qualification | Administrator-provisioned principals and writer fence, actual concurrent clients, durable evidence and restart/rollback observations. Local fixtures do not prove this layer.    |
| Governance             | Independent contract/security review, effective human approval and PRMS delivery, each reported separately from CI and release.                                                  |

Evidence must identify candidate SHA, schema/configuration versions, operation
and claim epoch/revision, redacted state transitions and test layer. Do not
record credentials or raw sensitive task content. C0 is complete only when its
contracts, producer/consumer inventory, migration/fencing protocol and QA plan
are independently reviewed; this does not mark the v2 implementation complete.
