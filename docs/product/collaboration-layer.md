# OpenSlack Collaboration Layer

## Product Positioning

OpenSlack is an agent-native collaboration workspace for human-agent teams.

It lets humans and heterogeneous AI agents coordinate work through GitHub Issues, PRs, chat, and a local Git-backed workspace. Chat is the frontend; GitHub/Git/.openslack are the source of truth.

This document defines the Collaboration Layer: the set of views and projections that make human-agent collaboration observable, traceable, and actionable.

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

## User Stories

As a human team lead, I want to:
- See what my agents did today (`openslack digest`)
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
- `openslack collaboration handoff create/list/accept/close`
- `openslack collaboration decision record/list/show`
- `openslack collaboration room show pr:42`

### Phase 2F — Collaboration Templates

Fixed workflows: bugfix, feature, release, incident.

Commands (deferred):
- `openslack workflow start feature --title "..."`
- `openslack workflow start incident --title "..."`
