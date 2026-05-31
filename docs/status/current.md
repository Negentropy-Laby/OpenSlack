---
schema: openslack.status.v1
source_of_truth: true
supersedes:
  - phase-1-prehardening
---

# OpenSlack Current Status

## Repository

| Field | Value |
|-------|-------|
| Remote | `https://github.com/Negentropy-Laby/OpenSlack` |

## Modules

| Module | Phase | Status | Notes |
|--------|-------|--------|-------|
| Self-Evolution Kernel | 1.6 | ACTIVE |  |
| GitHub Issues Task Loop | 1.7 | ACTIVE | GitHub Issues task loop active with typed task creation, dry-run repair, and Phase 4 watch daemon (webhook receiver, dedupe, console/Slack/webhook notifications, polling fallback, optional auto-claim with agent identity and authorization gates, collaboration event recording). |
| Operator Interface | 2A/2B/2C | ACTIVE | Structured planner active. Webhook and Slack chat adapters active with actor mapping. PRMS chat cards and action confirmation active. Typed tool registry, optional LLM fallback, setup report, and 24h pending plan store active. Session-based conversation memory with multi-turn context resolution and progressive clarification. Doctor --format plain for non-technical output. TUI setup report view and PR doctor view via --format tui. |
| PR Review & Merge Steward | 1.14 | ACTIVE | Phase 2C chat report and action confirmation active. Supports status/review/recommend/doctor/queue/merge/watch, review/doctor comments, governance audit, operational decision summaries, deadlock detection, Red Zone author-risk preflight, and chat-friendly PR summaries with confirm-merge flow. |
| Collaboration Layer | 2D/2E | ACTIVE | Full 2D/2E Collaboration Layer active with typed workflow template preview/execute and dashboard with filters (--owner, --module, --risk, --blocker, --type). Workflow engine with JS module discovery, preview, dry-run, execute, resume, trust levels, and inspect (HTML/JSON/Markdown). Event model, activity feed, digest, handoff, decision, and room views with agent display name resolution. Authz-gated chat cards for handoffs, decisions, tasks, workflows, and plans. Agent registry v1 to v2 migration command. TUI dashboard and room views via --format tui. Full workflow GitHub Issues lifecycle including proposal, review, run audit, improvement (with CLI), split with native sub-issue linking and linear dependency fallback, workflow-aware PRMS gate (BLOCKED_WORKFLOW_GATE), and post-merge lifecycle finalizer. Profile Sync Robot active with config-driven check/preview/run, idempotent branch naming, failure issue creation, profile_sync.failed event, watch-daemon auto-pr trigger (manual/watch/auto-pr modes), dedupe queue/worker, TUI profile workbench with 6 actions, PRMS profile-sync governance gate (BLOCKED_PROFILE_SYNC_GATE), and buildProfileSyncStatus finalizer. |

## Packages (12 active)

- @openslack/kernel
- @openslack/workspace
- @openslack/runtime
- @openslack/github
- @openslack/core
- @openslack/cli
- @openslack/operator
- @openslack/chat-gateway
- @openslack/tui
- @openslack/pr
- @openslack/collaboration
- @openslack/workflows

## CLI Commands

- openslack self
- openslack workspace
- openslack github
- openslack agent
- openslack task
- openslack ask
- openslack setup
- openslack status
- openslack doctor
- openslack chat
- openslack pr
- openslack governance
- openslack collaboration activity
- openslack collaboration digest
- openslack collaboration handoff
- openslack collaboration decision
- openslack collaboration room
- openslack collaboration workflow list
- openslack collaboration workflow show
- openslack collaboration workflow validate
- openslack collaboration workflow preview
- openslack collaboration workflow preview-js
- openslack collaboration workflow dry-run
- openslack collaboration workflow run
- openslack collaboration workflow resume
- openslack collaboration workflow trust
- openslack collaboration workflow publish
- openslack collaboration workflow review-request
- openslack collaboration workflow audit-run
- openslack collaboration workflow split
- openslack collaboration workflow improvement
- openslack collaboration workflow finalize-pr
- openslack collaboration workflow labels
- openslack collaboration inspect
- openslack collaboration workflow profile-sync check
- openslack collaboration workflow profile-sync preview
- openslack collaboration workflow profile-sync run
- openslack collaboration workflow profile-sync status

## Golden Evals

7/7 passing. Zero stub assertions.

## Test Suite

1706 Vitest tests across 141 files. All passing.

Module-attributed coverage: 2280 tests across 217 module test files (packages shared across modules are counted per module).

## Module Registry

Source: `.openslack/modules.yaml` — auto-generated from modules.yaml.
