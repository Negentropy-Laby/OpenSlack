---
schema: openslack.document.v1
id: contract-workflow-control
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-08-04
sources:
  - design/cdd/workstreams/workflow-runtime/README.md
  - docs/architecture/components/workflow-runtime.md
  - docs/architecture/ts-to-go-migration-roadmap.md
  - memory_bank/t2_execution/workflow_contract.md
---

# Workflow Control Contract

Status: GS7-A contract freeze plus the merged, exact-head-qualified GS7-B PostgreSQL observational
shadow, GS8 runner lifecycle, and the GS9-A Workflow Control authority v2 contract freeze.
TypeScript remains the sole workflow writer, runner, approval, budget, effect, resume, and
user-visible read authority. GS9-A adds only exact-byte TypeScript/Go contract parity and reports
`LOCAL_PASS`; Go Workflow Control authority remains `NOT_CLAIMED`.

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
