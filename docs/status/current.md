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
| Collaboration Layer | 2D/2E | ACTIVE | Full 2D/2E Collaboration Layer active with typed workflow template preview/execute and dashboard with filters (--owner, --module, --risk, --blocker, --type). Workflow engine with JS module discovery, preview, dry-run, execute, resume, trust levels, and inspect (HTML/JSON/Markdown). Dynamic Workflow Parity v1 active with Operator workflow recommendation/ultracode draft trigger, dynamic workflow draft generation, pattern registry (classify-and-act, fanout-synthesize, adversarial-verification, generate-filter, tournament, loop-until-done, model-router), workflow policy config, run listing/control evidence, save/export-skill, budget/model/isolation metadata, and helper APIs on ctx.workflow. Dynamic Workflow UX Closure active with workflow start aggregation, catalog preview, progress evidence model, TUI workflow home and run drilldown, save-run to project/user/Claude project, and budget/routing visibility across draft/run evidence. Event model, activity feed, digest, handoff, decision, and room views with agent display name resolution. Authz-gated chat cards for handoffs, decisions, tasks, workflows, and plans. Agent registry v1 to v2 migration command. TUI dashboard and room views via --format tui. Full workflow GitHub Issues lifecycle including proposal, review, run audit, improvement (with CLI), split with native sub-issue linking and linear dependency fallback, workflow-aware PRMS gate (BLOCKED_WORKFLOW_GATE), and post-merge lifecycle finalizer. Profile Sync Robot active with config-driven check/preview/run, idempotent branch naming, failure issue creation, profile_sync.failed event, watch-daemon auto-pr trigger (manual/watch/auto-pr modes), dedupe queue/worker, TUI profile workbench with 6 actions, PRMS profile-sync governance gate (BLOCKED_PROFILE_SYNC_GATE), and buildProfileSyncStatus finalizer. Agent Conversations active with typed thread model (7 message kinds), JSONL persistence, secret scanning on messages and metadata, agent type resolution with Claude Code subagent compatibility, and conversation commands (start/list/show/send/summarize/archive). Agent Runtime (@openslack/agent-runtime) active with launcher, permission profiles, run store, transcript recording, local adapter, process bridge diagnostics, Aby external runtime doctor/setup/smoke, worktree isolation, fail-closed metadata validation, MCP descriptor status UX, and redacted bridge stderr summaries. Lifecycle events (started/completed/failed) are wired through executeRun/executeResume via agentEventEmitter bridge into collaboration recordEvent, with activity feed and room integration. TUI AgentRun detail view with bridge/MCP observability timeline and Agent Runtime diagnostics view. |

## Packages (13 active)

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
- @openslack/agent-runtime

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
- openslack collaboration workflow start
- openslack collaboration workflow generate
- openslack collaboration workflow preview-draft
- openslack collaboration workflow patterns
- openslack collaboration workflow catalog
- openslack collaboration workflow runs
- openslack collaboration workflow config
- openslack collaboration workflow save
- openslack collaboration workflow save-run
- openslack collaboration workflow export-skill
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
- openslack conversation start
- openslack conversation list
- openslack conversation show
- openslack conversation send
- openslack conversation summarize
- openslack conversation archive
- openslack agent-runtime doctor
- openslack agent-runtime setup
- openslack agent-runtime smoke
- openslack agent-runtime mcp status

## Golden Evals

7/7 passing. Zero stub assertions.

## Test Suite

3263 passing Vitest tests across 238 passing files. No failures recorded.

Module-attributed coverage: 3483 tests across 338 module test files (packages shared across modules are counted per module).

Note: The Vitest line is the raw passing count recorded in .openslack/modules.yaml. The module-attributed coverage line is the per-module sum from .openslack/modules.yaml, where each test file is counted once per module that claims it. Use module counts for coverage tracking; use raw bun run test output for CI verification, including skipped tests.

## Module Registry

Source: `.openslack/modules.yaml` — auto-generated from modules.yaml.
