---
schema: openslack.progress_review.v1
date: 2026-05-28
milestone: post-tui-integration
status: review
source_of_truth: false
supersedes: []
canonical_status: docs/status/current.md
canonical_modules: .openslack/modules.yaml
---

# Progress Review: 2026-05-28

## Summary

This document is a dated review. It does not replace `docs/status/current.md`
or `.openslack/modules.yaml`.

OpenSlack has completed the transition from an agent automation toolchain to an
agent-native collaboration workspace. All five product modules are ACTIVE, the
TUI integration is shipped (PRs #93–#100), governance documentation has been
hardened (PR #101), and the product positioning is finalized.

The project has reached a critical product milestone: core capabilities are
complete, and the primary gap is no longer functionality — it is user
understanding and discovery.

## Current Metrics

| Metric | Value |
|--------|-------|
| Active product modules | 5 |
| Active packages | 11 |
| Unit tests (Vitest) | 808 across 101 test files |
| Module-registered tests | 1112 (packages counted per-module with shared deps) |
| Golden evals | 7/7 passing |
| Status source | `docs/status/current.md` (generated from `.openslack/modules.yaml`) |

### Packages

@openslack/kernel, @openslack/workspace, @openslack/runtime,
@openslack/github, @openslack/core, @openslack/cli, @openslack/operator,
@openslack/chat-gateway, @openslack/tui, @openslack/pr,
@openslack/collaboration.

## Module Status

### Module 01 — Self-Evolution Kernel

Phase 1.6 · ACTIVE · 107 tests / 12 files · 7 golden evals

Self-protection capabilities: risk zone classification, workspace validation,
golden evals, self-evolution safety, rollback, genesis validation. OpenSlack
can safely modify itself, validate itself, and block dangerous path changes.

Product maturity: **high**.

### Module 02 — GitHub Issues Task Loop

Phase 1.7 · ACTIVE · 172 tests / 21 files

GitHub Issues as the agent workflow source of truth: typed task creation,
dry-run repair, watch daemon (webhook receiver, dedupe, polling fallback),
console/Slack/webhook notifications, optional auto-claim with agent identity
and authorization gates, collaboration event recording.

Full loop: Issue creation → agent claim → worktree execution → PR submission
→ merge completion.

Product maturity: **high**.

### Module 03 — Operator Interface

Phase 2A/2B/2C · ACTIVE · 300 tests / 45 files

Structured planner, typed tool registry, optional LLM fallback, Webhook/Slack
chat adapters with actor mapping, PRMS chat cards, action confirmation, 24h
pending plan store, session-based conversation memory with multi-turn context
resolution and progressive clarification. `doctor --format plain` for
non-technical output. TUI views for setup report and PR doctor via
`--format tui`.

Product maturity: **high**.

### Module 04 — PR Review & Merge Steward

Phase 1.14 · ACTIVE · 264 tests / 28 files

PRMS governance: status/review/recommend/doctor/queue/merge/watch, review and
doctor comments, governance audit, operational decision summaries, deadlock
detection, Red Zone author-risk preflight, chat-friendly PR summaries with
confirm-merge flow, review thread resolution gate.

Users always know why a PR cannot merge, who needs to act, and when it is
safe to merge.

Product maturity: **high**.

### Module 05 — Collaboration Layer

Phase 2D/2E · ACTIVE · 269 tests / 38 files

Event model, activity feed, digest, handoff, decision records, room views,
workflow template preview/execute, dashboard with filters (--owner, --module,
--risk, --blocker, --type), agent display name resolution, authz-gated chat
cards for handoffs/decisions/tasks/workflows/plans, agent registry v1→v2
migration, TUI dashboard and room views via `--format tui`.

Product maturity: **high**.

## Completed This Milestone

### TUI Integration (PRs #93–#100)

`@openslack/tui` is a progressive-enhancement package providing interactive
terminal views via Ink (React for terminals). It is NOT a standalone module —
registered under Operator and Collaboration modules.

Four views shipped:

| Command | View | PR |
|---------|------|----|
| `openslack collaboration dashboard --format tui` | DashboardView | #96 |
| `openslack collaboration room show <ref> --format tui` | RoomView | #97 |
| `openslack pr doctor <n> --format tui` | DoctorView | #98 |
| `openslack setup interactive --format tui` | SetupView | #99 |

Design system components: ThemeProvider, ThemedBox, ThemedText, StatusIcon,
ProgressBar, Divider, ListItem, Pane, KeyboardShortcutHint.

Architecture: CLI lazy-imports `@openslack/tui` with try/catch fallback to
standard output. View model mappers sanitize all external text. React
components render with Ink and exit on q/Esc. Zero new business logic.

### Governance Hardening (PR #101)

Documentation PR adding review thread resolution gate, PR branch
synchronization procedures, bot/agent authorship requirements, and agent
action boundary updates across AGENTS.md, developer docs, security docs,
module spec, user guide, and README.

## TUI Product Positioning

### Architecture Principles

OpenSlack remains:

1. **CLI-first** — default output is `standard`. TUI is opt-in via
   `--format tui`.
2. **Chat-enabled** — Slack and webhook adapters are projection layers.
3. **TUI-enhanced** — `@openslack/tui` renders existing projections
   interactively.
4. **Source-of-truth externalized** — GitHub/Git/.openslack remain the
   authority.

`@openslack/tui` is an optional human-facing terminal UI layer:

- It renders existing OpenSlack projections.
- It does not own business logic.
- It does not write source-of-truth state directly.
- It does not replace standard/plain/json/chat outputs.

### Package Boundary

| Layer | Role | Source of truth |
|-------|------|-----------------|
| CLI (`apps/cli`) | Command surface, format routing | `--format tui` triggers lazy import |
| TUI (`@openslack/tui`) | Renders interactive views, produces no state | Receives data through view models |
| Domain packages | Business logic, projections, governance | Unchanged |

### Forbidden TUI Actions

The TUI layer must never:

- Call GitHub API directly
- Write to `.openslack` or collaboration state
- Execute merge, issue-done, or other mutating operations
- Treat Slack/TUI confirmation as GitHub approval
- Bypass Operator/PRMS/governance gates
- Introduce its own source of truth

### Data Flow

```
CLI command
  → Domain package API
  → Build view model (sanitize)
  → @openslack/tui renders view model
  → User action emits structured UI action
  → CLI maps action to Operator plan / PRMS command
  → Existing gates execute
```

### Lazy Import Pattern

```typescript
if (format === 'tui' && isInteractiveTerminal()) {
  const { renderDashboardTui } = await import('@openslack/tui');
  await renderDashboardTui(viewModel);
} else {
  renderStandard(viewModel);
}
```

Non-TUI commands pay zero cost. Failure falls back to standard output.

### Terminal Safety

All external text entering TUI is sanitized via `sanitizeTerminalText()` in
`packages/tui/src/sanitize.ts`, which strips:

- OSC clipboard injection (`\x1b]52;...`)
- CSI clear screen (`\x1b[2J`)
- ANSI color spoofing (`\x1b[31m...`)
- Cursor movement sequences
- Terminal title modification

## TUI User Workflows

### Target Workflow (future navigation closure)

The current TUI views are independent render-and-exit views. The target
workflow is to connect them into a navigable terminal workspace:

```
Launch
  → Home Dashboard (--format tui)
    → Needs Attention / Active Work / Blocked
      → Object Room (pr:42, issue:21)
        → PR Doctor / Task Detail / Handoff / Decision
          → Plan / Confirm / Execute (via existing gates)
  → Activity / Digest update
```

This navigation flow does not exist yet. Each view is currently invoked
separately via its own `--format tui` command.

### Dashboard View

Commands: `openslack collaboration dashboard --format tui`

Data sources: collaboration dashboard projection derived from events, handoffs,
and decisions. Task/PR counts are derived from collaboration events, not from
direct PRMS queue or GitHub metrics queries.

Sections rendered:

- **Header** — Title + generation timestamp
- **Summary row** — Blocker/handoff/decision counts with status icons
- **Blockers pane** — Each blocker with summary, owner, next action, severity
- **Handoffs pane** — Open handoffs with from/to/status/context/age
- **Decisions pane** — Active decisions with topic/status/decided-by
- **Activity pane** — Recent events with time/type/summary/actor
- **Footer** — Keyboard shortcut hint (q/Esc to exit)

User interactions: q/Esc to exit. Arrow key scrolling and item selection are
candidates for future enhancement.

Strict boundary: dashboard renders projections only. It does not merge, approve,
or mutate state.

### PR Room View

Command: `openslack collaboration room show pr:42 --format tui`

Renders: PR status, risk zone, owner, blocker, next action, source links,
recent activity, handoffs, decisions.

Cannot do: approve PR, bypass CODEOWNER, merge without PRMS, treat TUI
confirmation as GitHub approval.

### PR Doctor View

Command: `openslack pr doctor <n> --format tui`

Renders: merge decision, risk zone, 6 governance gates (Draft/State/Merge/
Checks/Approvals/Risk), checks with pass/fail status, reviews with approval
validity, evidence, recommendation.

Cannot do: show approve button, execute merge directly.

### Setup Report View

Command: `openslack setup interactive --format tui`

Renders: read-only setup report with readiness classification (ready / almost
ready / needs setup help), grouped findings (fixable / needs action).

Cannot do: execute repairs. Setup TUI is a report viewer, not a wizard.

### Issue / Task Room (future)

Candidate: `openslack collaboration room show issue:21 --format tui`

Would render: issue title, task status, claim owner, agent assigned, worktree
status, handoffs, recent activity, next action.

Strict boundary: task sync requires plan + confirmation. Agent-scoped
mutations require `--agent-id` and runtime identity.

### Handoff / Decision Forms (future)

Candidates for TUI forms that output to `.openslack/collaboration/` YAML files.

Handoff: from, to, object, context, next steps, notes.

Decision: topic, decision, rationale, alternatives, consequences, tags, linked
object.

Both remain behind existing authz gates.

### Workflow Template Preview (future)

Candidate: `openslack collaboration workflow preview <file> --format tui`

Would render: template metadata, inputs, generated tasks, handoffs, decisions,
validation checklist, risk summary.

Strict boundary: preview only. Execute requires separate confirmation.

## Documentation And User Entry Points

### README

Top-line positioning: "agent-native collaboration workspace for human-agent
teams." Quick Start and "What Should I Run?" sections are user-goal-oriented.
Bot-authored PR requirement strengthened from "should" to "must."

### User Guide

Organized by user goals (Start With User Goals table). Safety defaults
documented. `--format tui` and `--format plain` commands listed. Base branch
policy note about unresolved conversations.

### Status Source

`docs/status/current.md` is generated from `.openslack/modules.yaml` via
`openslack status generate` and verified via `openslack status verify`. No
hand-editing of generated status.

## TUI Implementation History

The TUI was delivered in 8 PRs following a phased plan:

| PR | Scope | Key Deliverable |
|----|-------|-----------------|
| #93 | Skeleton + Ink engine | `@openslack/tui` package, minimal Ink fork, pure TS Yoga |
| #94 | Design system + theme | 9 design system components, OpenSlack theme |
| #95 | Capabilities + sanitize | `isTuiSupported()`, `renderTui()`, `sanitizeTerminalText()` |
| #96 | Dashboard TUI | First user-visible view: `collaboration dashboard --format tui` |
| #97 | Room TUI | `collaboration room show <ref> --format tui` |
| #98 | PR Doctor TUI | `pr doctor <n> --format tui` |
| #99 | Setup Report TUI | `setup interactive --format tui` |
| #100 | Docs sync | Module registry, user guide, status docs updated |

Each PR required 1–3 review rounds. Key issues caught in review:
- Lockfile not updated after adding workspace dependencies
- Doctor view re-derived approval validity from raw reviews instead of using
  `report.humanApprovals`
- Neutral/skipped check conclusions incorrectly shown as FAIL
- Setup readiness misclassified mixed reports (needsAction vs fixable priority)
- TUI incorrectly registered as standalone module instead of under existing
  modules

## Next Phase Recommendations

Core execution, governance, and collaboration loops are complete. The primary
gap is **user understanding and discovery**.

### P0: Reduce User Understanding Cost

1. **Enhanced onboarding** — `openslack setup interactive` exists with TUI view.
   Could add post-setup "what would you like to do first?" flow with actionable
   next commands.

2. **Status as workspace homepage** — `openslack status` should surface
   needs-attention items, active work, blocked items, and a recommended next
   action, not only system health.

3. **Role-based quick guides** — focused paths for human operators, reviewers,
   agent maintainers, and project leads.

### P1: Collaboration Workbench

1. **Dashboard as primary entry** — `openslack collaboration dashboard` with
   --owner, --module, --blocker, --risk filters already works. Add
   `--format markdown` and `--format chat` for non-terminal contexts.

2. **Room views in more formats** — `openslack collaboration room show pr:42`
   with `--format plain` and `--format chat`.

3. **Digest to Slack** — `openslack collaboration digest --post slack` for
   periodic team summaries.

### P2: Scenario-Based Workflow Templates

Move from generic template engine to scenario products:

- bugfix, feature, release, incident, research, refactor, docs-update
- Each defines task breakdown, agent division, handoff checklist, PRMS policy,
  validation, decision points
- User experience: `openslack collaboration workflow preview
  templates/workflows/feature.yaml --input title="Add PRMS Slack cards"`

### P3: Continue Plain-Language Output Expansion

`--format plain` is available on: `pr doctor`, `doctor`, `setup interactive`,
`collaboration dashboard`, `collaboration activity`, `collaboration digest`,
`collaboration room show`, `governance audit`.

Extend to higher-frequency commands and ensure plain output always includes:
status, owner, blocker reason, next action, source.

### P4: Chat Output Unification

Standardize all chat/card output to include: Status, Owner, Blocker, Why, Next
action, Source.

### P5: Additional TUI Views (If Requested)

The TUI infrastructure supports adding new views. Candidates:

- `openslack pr queue --format tui` — PR readiness list
- `openslack collaboration digest --format tui` — event summary
- `openslack status --format tui` — workspace homepage

All follow the same pattern: view model mapper → React component → render
function → lazy CLI import.

### P6: TUI Interactive Enhancements (If Requested)

Current TUI views are render-and-exit. Future enhancements could add:

- Arrow key navigation between dashboard items
- Enter to drill into room views from dashboard
- `d` key to open PR doctor from room view
- `m` key to create Operator merge plan (not direct merge)
- `r` key to refresh data

All interactive actions route through existing Operator/PRMS/governance gates.

## Governance Notes

1. **Co-Authored-By prohibition** — Commits must not include AI/model/tool
   attribution trailers. Bot identity (openslack-agent-operator[bot]) as
   author/committer is allowed and distinct from model attribution.

2. **Collaboration Layer remains projection-only** — GitHub/Git/.openslack are
   the source of truth. Dashboard, room, digest, and workflow views must never
   become authoritative state stores.

3. **Review thread resolution gate** — Unresolved GitHub review conversations
   block merge even when CI is green and human approval exists. Agents may only
   mechanically resolve threads with explicit authorization.

## Final Assessment

OpenSlack has successfully productized as an agent-native collaboration
workspace. The completed capability set:

- Humans, agents, GitHub Issues, PRMS, Slack/Webhook, handoffs, decisions,
  rooms, and workflows unified in a verifiable collaboration model
- Optional interactive TUI for terminal users
- Multi-format output (standard/plain/tui/json/chat)
- Governance gates that protect merge integrity
- Projection-only collaboration views that never compete with source of truth

The next phase should focus on **making users effective** — onboarding,
plain-language output, dashboard-as-homepage, role-based guides, and
scenario-based workflow templates — rather than expanding underlying modules.

**One-line summary:** Core capabilities complete, collaboration workspace
positioning established. Next phase concentrates on onboarding, plain-language
output, dashboard-as-homepage, role-based guides, and scenario-based workflow
templates.
