---
schema: openslack.document.v1
id: cdd-module-collaboration
status: In Review
authority: canonical
audience:
  - contributors
owner: product
updated: 2026-07-28
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# OpenSlack Collaboration Layer

## Product Positioning

OpenSlack is an agent-native collaboration workspace for human-agent teams.

It lets humans and heterogeneous AI agents coordinate work through GitHub Issues, PRs, chat, and a local Git-backed workspace. Chat is the frontend; GitHub/Git/.openslack are the source of truth.

This document defines the Collaboration Layer: the set of views and projections that make human-agent collaboration observable, traceable, and actionable. Its Negentropy-Lab bridge exports only bounded, schema-pinned evidence projections; see [Negentropy-Lab Integration](../workstreams/negentropy-integration/README.md). The Collaboration Layer does not own any authority state.

## Why Collaboration Layer

Current OpenSlack already supports:

```
Issue → Agent → PR → Doctor → Human Approval → Merge Steward → Done
```

And chat:

```
Chat → Operator Planner → PRMS Doctor → Chat Card → Chat Confirmation → Merge Steward → GitHub
```

But these workflows produce events that are hard to observe as a whole:

- PR #42 is blocked — but who owns the next action?
- Agent codex-dev claimed an issue — but what is its current status?
- A plan was confirmed in Slack — but what source-of-truth object changed?
- Governance audit passed — but what does that mean for the team's next action?

The Collaboration Layer solves this by aggregating events from all source-of-truth objects into human-readable collaboration views.

## Projection-Only Principle

The Collaboration Layer is **projection-only**. It does not own state.

Source of truth remains:

- GitHub Issues
- GitHub PRs
- Git branches and commits
- `.openslack` workspace files
- PRMS doctor results
- Governance audit trail

Collaboration views (Activity, Digest, Room, Handoff) are derived from these sources. If Slack disappeared, the entire collaboration state could be reconstructed from GitHub + Git + `.openslack` + the audit log.

## Collaboration Objects

### Activity

An Activity is a single collaboration event. It records:

- What happened
- Who triggered it
- Which object was affected
- Who owns the next action
- Where the source of truth lives

Events are stored in `.openslack.local/collaboration/events.jsonl` and are not committed to Git.

### Digest

A Digest is a time-bounded summary of collaboration activity. It groups events into:

- Completed
- Needs human attention
- Blocked
- Agent activity
- Governance status
- Recommended next action

Digests are derived reports, regenerable from events.

### Handoff

A Handoff is a structured transfer of context between humans or agents. It includes:

- From / to actors
- Linked issue or PR
- Summary of what was done
- Context (files, decisions, constraints)
- Next action and owner

Handoffs are first-class workspace objects stored in `.openslack/collaboration/handoffs/` and committed to Git.

### Decision Record

A Decision Record is a lightweight ADR for product or technical decisions. It captures:

- Topic
- Decision
- Rationale
- Linked objects (PRs, issues, modules)
- Status (proposed / accepted / superseded)

Decision records are first-class workspace objects stored in `.openslack/collaboration/decisions/` and committed to Git.

### Room

A Room is a collaboration space view for an issue, PR, or module. It aggregates:

- Source links
- Recent activity
- Blockers
- Owner
- Next action
- Linked decisions

Rooms are derived views, not stored objects.

### Workflow Template

A Workflow Template is a reusable, typed collaboration workflow. Templates use
`schema: openslack.workflow_template.v1`, typed inputs, phases, and steps.
Action steps must reference registered OpenSlack actions such as `pr.doctor`;
raw command strings are rejected. Workflow runs emit correlation IDs so events,
handoffs, decisions, and room views can reconstruct the run.

### Business Outcome Projection

`BusinessOutcomeProjection` is the schema-pinned, read-only business reporting boundary:

```text
openslack collaboration business-outcomes
  --since-hours <n>
  --scenario <id>
  --format json|markdown|plain
```

It has the fixed schema `openslack.business_outcome.v1` and groups metrics under `work`,
`governance`, `agents`, `economics`, `reuse`, and `notifications`. Every metric carries its own
`basis` (`observed`, `configured_estimate`, or `unknown`) and evidence references. The top-level
`gaps` list makes missing authoritative evidence visible.

The projection is a pure aggregator. `buildBusinessOutcomeProjection` accepts an injected
`BusinessOutcomeSourceSnapshot`; it does not read GitHub, PRMS, workflow storage, notification
queues, or the network. The CLI composition layer injects the bounded collaboration-event query
and versioned assumptions that are locally available. Its query receipt hashes the bounded source
as original bytes and pins the SHA-256, byte and record bounds, and requested period/scenario.
Decoding is fatal UTF-8, and JSONL accepts at most one terminating newline. A missing event store is
treated as an explicitly receipted empty query and is not created by this read-only command.
Malformed, invalid, oversized, or ambiguously terminated JSONL blocks the report with a nonzero
exit instead of silently producing observed zeroes.

Truth boundaries are strict:

- work completes only with `task.done` paired to `task.created` by object ID;
  `task.completed` is not an OpenSlack event;
- `pr.review.commented` and OpenSlack plan confirmations are not GitHub human approvals;
  approval counts remain unknown without injected current-head PRMS evidence;
- review-intervention inputs explicitly exclude those current-head approvals so one human
  approval cannot be counted twice; count inputs must be non-negative integers with evidence,
  and overlapping approval/review evidence causes the review count to be excluded;
- first-pass PR rate means the first recorded `pr.doctor.ready` or `pr.doctor.blocked`
  observation for each PR, not global PR quality;
- `notification.sent` and `notification.failed` describe direct route attempts only;
  durable `accepted` and remote `delivered` remain unknown without injected receipt or
  reconciliation evidence;
- blocker time remains unknown without close or unblock evidence;
- manual-hour and runtime-cost assumptions are always versioned
  `configured_estimate` inputs;
- revenue is not a projection field because OpenSlack has no authoritative revenue source.

Supplying `--scenario` isolates events through explicit `metadata.scenarioId` or
`metadata.scenario`; unscoped events do not leak into a scenario report. The fixed manufacturing
demo assumptions are stored in
`examples/ai-organization-demo/input/outcome-assumptions.yaml`.

## User Stories

As a human team lead, I want to:

- See what my agents did today (`openslack digest`)
- See evidence-backed operational outcomes (`openslack collaboration business-outcomes`)
- Know what is blocked and who should act next (`openslack activity`)
- Hand off a task from one agent to another (`openslack collaboration handoff`)
- Record a product decision so we don't re-discuss it (`openslack collaboration decision`)

As an agent, I want to:

- Emit events so humans can observe my work
- See what I should work on next
- Accept a handoff with full context

## Non-Goals

The Collaboration Layer does NOT:

- Replace GitHub Issues as the task source of truth
- Replace GitHub PRs as the review source of truth
- Replace PRMS doctor as the merge gate
- Allow Slack confirmation to satisfy GitHub CODEOWNER approval
- Implement long-running task orchestration
- Provide real-time chat room membership or channel binding

## Roadmap

### Phase 2D — Collaboration Observability & Audit

Event model, activity feed, audit projection, security docs.

Commands:

- `openslack activity`
- `openslack activity --since 24h`
- `openslack activity --object pr:42`

### Phase 2E — Collaboration Workspace UX

Digest, handoff, decision, room.

Commands:

- `openslack digest`
- `openslack collaboration business-outcomes --since-hours 24 --format markdown`
- `openslack collaboration handoff create/list/accept/close`
- `openslack collaboration decision record/list/show`
- `openslack collaboration room show pr:42`

### Phase 2F — Collaboration Templates

Typed workflow template preview and execution.

Commands:

- `openslack collaboration workflow preview <file>`
- `openslack collaboration workflow execute <file> --dry-run`
- `openslack collaboration workflow execute <file> --agent-id <id>`

## Overview

Collaboration is the projection and coordination module for events, activity,
digests, rooms, handoffs, decisions, conversations, and governed workflows.

## User Promise

Users can understand who is acting, what is blocked, which evidence exists, and
which authority must take the next action.

## Data Model

Validated events, correlation IDs, actors, handoffs, decisions, workflow runs,
blockers, and evidence references.

## Edge Cases

Projection gaps remain visible. Redacted, stale, synthetic, or incomplete
events cannot become task, approval, or business authority.

## Dependencies

`@openslack/collaboration`, workflow/runtime event producers, and read-only
GitHub/PRMS projections.

## Configuration

Storage, retention, redaction, and view filters are explicit and workspace
scoped.

## Acceptance Criteria

- Views rebuild from authoritative events.
- Correlation and actor identity survive projection.
- Collaboration actions never originate GitHub approval.
