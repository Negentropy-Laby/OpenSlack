---
schema: openslack.product_spec.v1
status: design-only
created: 2026-06-02
source: Phase AR — Agent Runtime Hardening (deferred to future Phase AT)
---

# Agent Teams — Design Document

## Status: Design Only — Not Yet Implemented

This document analyzes Aby's teammate/tmux/iTerm/in-process team backend and
proposes how OpenSlack could support agent teams in a future phase, without
adopting Aby's UI/AppState/tmux shell architecture.

## Analysis: Aby Team Backend

Aby's team support includes:

- **Teammate definitions** — agents with `teammate` flag and role assignments
- **tmux/iTerm backend** — multiple agent panes in a shared terminal session
- **In-process team** — agents running as threads within the same process
- **Team leader** — coordinates other agents via message passing

## Why OpenSlack Defers This

1. **Single subagent runtime must be stable first.** The core launcher, recorder,
   permission profile, and transcript store need production hardening before
   adding orchestration complexity.
2. **tmux/iTerm dependency is UI-shell, not runtime.** OpenSlack's TUI is
   Ink-based React, not a terminal multiplexer. Team coordination should happen
   at the workflow level, not the terminal level.
3. **Conversation threads are the right coordination primitive.** Shared state
   via typed messages in a thread is more auditable than shared memory or
   in-process message passing.

## Design Principles for Future Phase AT

### Team Leader as Workflow

The team leader is a workflow that uses `ctx.parallel()` or `ctx.pipeline()`
to dispatch team members:

```typescript
export const meta = { name: 'security-team', phases: [...] }

export async function run(ctx, args) {
  ctx.phase('Triage')
  const triage = await ctx.agent('Analyze PR #42 for risk', {
    agentType: 'security-triage',
  })

  ctx.phase('Review')
  const [codeReview, dependencyScan] = await ctx.parallel([
    () => ctx.agent('Review code changes', { agentType: 'code-reviewer' }),
    () => ctx.agent('Check for vulnerable dependencies', { agentType: 'dependency-scanner' }),
  ])

  ctx.phase('Report')
  return { triage, codeReview, dependencyScan }
}
```

### Each Member is a Separate AgentRun

- Each team member gets its own `runId`, `transcript.jsonl`, and `run.json`
- No shared memory — coordination through the parent workflow's scope
- Each member's permission profile is independently computed

### Shared Context via Conversation Thread

- Team runs are linked to a single conversation thread
- `agent_run_event` messages show each member's progress
- Final team result is a structured message in the thread

### No tmux/iTerm Dependency

- OpenSlack uses `ConversationListView` + `AgentRunDetailView` for team visibility
- No terminal pane management
- No in-process threading — each agent run is an independent async call

## Acceptance Criteria (Future Phase AT)

- [ ] Team workflow template with parallel member dispatch
- [ ] Team leader coordinates via conversation thread
- [ ] Each member has independent transcript and permission profile
- [ ] TUI shows team progress with multiple AgentRunDetailViews
- [ ] Team result aggregates all member outputs
- [ ] No tmux, iTerm, or in-process threading dependency
