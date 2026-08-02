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

Status: GS7-A contract freeze and credential-free Go parity only. TypeScript remains the sole
workflow writer and execution authority. No Go store, transport, worker, lease, approval decision,
resume path, or user-visible read authority exists in this stage.

## Authority boundary

`@openslack/workflows` continues to own the JavaScript/TypeScript DSL and runner, workflow and agent
calls, permission and trust checks, human decisions, effect execution, local RunStore writes,
resume behavior, and CLI/TUI/MCP views. The pure `services/workflow-control` Go module accepts only
the closed, bounded contract record, validates it, checks declared status transitions, and produces
a deterministic credential-free read model for differential qualification.

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

## Explicit GS7-A gaps

The contract marks the read model ineligible for authority while any of these remain true:

- RunStore status, checkpoint, control, and legacy approval writes have no shared revision or CAS;
- there is no workflow lease, heartbeat, expiry, takeover, fencing token, or stale-writer rejection;
- pause and stop do not durably abort the running workflow body;
- budget accounting is not a durable, monotonic record across resume and restart;
- resume does not yet prove exactly-once phase continuation from a durable checkpoint;
- control paths can write status outside the frozen transition method; or
- the strict v2 effect approval is not an exactly-once runtime pause/decision/resume boundary.

GS7-B may add a separate Go shadow observation store only after its own review and qualification.
GS8 owns the versioned JS runner worker protocol and any scheduler/lease work. GS9 is the separate
PostgreSQL authority cutover for checkpoint, approval, and budget state. None of those later stages
is implied by a GS7-A local or hosted pass.
