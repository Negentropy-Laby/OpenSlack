---
schema: openslack.document.v1
id: contract-workflow-control
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
  - docs/architecture/ts-to-go-migration-roadmap.md
  - memory_bank/t2_execution/workflow_contract.md
---

# Workflow Control Contract

Status: GS7-A contract freeze plus a GS7-B PostgreSQL observational shadow candidate. TypeScript
remains the sole workflow writer, runner, approval, budget, effect, resume, and user-visible read
authority. The Go service owns only an isolated credential-free observation journal and matched
projection index; hosted PostgreSQL/container qualification remains a separate exact-head gate.

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
built image, and calls its observation, projection, and version APIs. These are gate definitions,
not a claim that an unpublished head has passed hosted infrastructure.

GS7-B remains an observational candidate until its exact hosted head passes real PostgreSQL,
response-loss, restart, concurrency, corruption, OpenAPI, Prometheus, distribution, image-smoke,
cross-language, review-thread, and independent-human-approval gates. GS8 owns the versioned JS
runner worker protocol and any scheduler/lease work. GS9 is the separate PostgreSQL authority
cutover for checkpoint, approval, and budget state. None of those later stages is implied by a
GS7-A or GS7-B local pass.
