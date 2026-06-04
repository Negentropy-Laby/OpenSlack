# TUI Workbench Guide

## Overview

The TUI Workbench is the interactive terminal interface for OpenSlack. Launch it with:

```bash
bun run openslack tui
```

## Entry Points

There are two ways to enter the TUI:

1. `bun run openslack tui` -- launches directly into the workbench shell
2. `bun run openslack collaboration dashboard --format tui` -- opens the collaboration dashboard in TUI mode, which navigates to the same shell

Both entry points land on the Home screen, which is the workbench landing page.

## Home Screen

The Home screen shows:

- **What do you want to do?** -- task-oriented actions with keyboard shortcuts
- **Quick Navigation** -- direct links to Dashboard, Status, Activity, Digest, Workflows, Workflow Runs, Profile
- **Next Recommended Action** -- the single most important thing to do next, derived from your workspace state

### Task-Oriented Actions

| Shortcut | Task | Description |
|----------|------|-------------|
| 1 | See what needs attention | View items needing immediate action |
| 2 | Start or continue work | Create tasks, claim issues, work in isolated branches |
| 3 | Start a workflow | Generate from prompt, choose a pattern, or run a saved workflow |
| w | Watch running workflows | Inspect run, phase, agent, transcript, controls, and budget evidence |
| a | Handle paused workflow approvals | Approve or reject workflow effects and budget pauses |
| s | Save/share run | Choose a workflow run, then save scripts to project, user, or Claude project targets |
| g | Publish workflow to GitHub Issues | Create proposal, review, or phase-tracking issues |
| 4 | Review and merge PRs | Check open PRs, run doctor, and merge when ready |
| 5 | Approve pending items | Approve plans, merge requests, and workflow effects |
| 6 | Maintain organization profile | Check, preview, and sync your organization profile |

### Next Recommended Action

The Home screen computes the most important next action from your workspace state. Priority order:

1. **Governance**: Pending approvals (plans, merge requests, workflow effects)
2. **Blockers**: Blocked PRs, blocked tasks, failed profile sync
3. **Operational**: Open handoffs, active decisions
4. **Informational**: Ready-to-merge PRs, system status issues

## Navigation

- Arrow keys (Up/Down) to navigate lists
- Enter to select
- Shortcut keys to jump directly
- q or Esc to go back or quit
- Mouse click support on most items

## Views

### Dashboard

Team dashboard with blockers, handoffs, decisions, and recent activity.

### Status

System status: modules, test suite, GitHub connectivity, commit info.

### PR Queue

Open PRs sorted by merge readiness. Each PR shows decision, blocker category, workflow gate, and next action.

### Profile

Organization profile sync status with guided actions: check, preview, create PR, open PR.

### Workflow Lifecycle

Horizontal 5-stage progress bar (Proposal -> Review -> Run -> PR -> Merged) with detailed stage information.

### Workflow Runs

Run, phase, and agent drilldown for recorded workflow evidence. The view shows
status, current phase, token budget, budget percent, configured cost estimate,
pending approvals, recent tool evidence, replay availability, result summaries,
transcript paths, and run/agent controls.

### Approval Center

Pending governance items grouped by category with approve/reject actions and clear effect explanations.

### Doctor

PR health report with 11 governance gates. Toggle compressed mode with `c` key.

## Keyboard Shortcuts

### Global

| Key | Action |
|-----|--------|
| q / Esc | Back / Quit |
| Up / Down | Navigate |
| Enter | Select |

### View-specific

| Key | View | Action |
|-----|------|--------|
| c | Doctor | Toggle compressed summary |
| r | Lifecycle | Run workflow |
| d | Lifecycle | Dry-run workflow |
| a | Approval Center | Approve selected |
| x | Approval Center | Reject selected |

## Fallback

If your terminal does not support the TUI (no TTY, no ANSI support), OpenSlack automatically falls back to plain-text output. Each view has a plain-text renderer that produces ASCII-only, 80-column output.

To explicitly use plain text:

```bash
bun run openslack collaboration dashboard --format plain
```

## Related

- [Core Workflows](core-workflows.md) -- day-to-day workflow guides
- [Dynamic Workflow Workbench](dynamic-workflow-workbench.md) -- workflow start, progress, save/share, publish, and disable paths
- [CLI Reference](../user-guide.md) -- complete command reference
- [TUI Style Guide](../developer/tui-style-guide.md) -- rendering conventions and column width matrix
