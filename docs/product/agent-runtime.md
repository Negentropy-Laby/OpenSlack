---
schema: openslack.product_spec.v1
status: active
created: 2026-06-02
source: Phase AR — Agent Runtime Hardening
---

# Agent Runtime — Product Specification

## Executive Summary

Phase AR upgrades OpenSlack's Agent Conversation MVP into a runnable, auditable,
and governable Agent Runtime. The core goal is to replace the "No agent launcher
configured" stub with a fully instrumented local agent launcher that produces
structured results, records transcripts, enforces permissions, and feeds the
collaboration event pipeline.

## Problem Statement

OpenSlack already has:

- Subagent definition parsing and resolution
- Conversation store with typed messages
- TUI conversation views
- Workflow lifecycle event bridge

But `ctx.agent()` in execute mode still throws `"No agent launcher configured"`.
Agents are parsed, resolved, and displayed — but never executed.

## Design Principles

1. **Migrate runtime protocol, not UI shell.** Aby's AppState, React Tool UI,
   tmux/iTerm backend, Perfetto, and bun feature flags are excluded.
2. **Fail closed.** `bypassPermissions` is blocked; corrupted metadata refuses
   to run; missing MCP servers mark agent unavailable.
3. **Agent runs are audit events.** Every run produces `run.json` +
   `transcript.jsonl` + `metadata.json` and feeds collaboration events.
4. **Subagents never approve/merge/read-secrets/bypass-rulesets.** Hardcoded in
   permission profile; not configurable.
5. **Worktree isolation for writers.** `isolation=worktree` is enforced via
   existing `packages/runtime/src/worktree.ts`; implementer agents must use it.

## Architecture

### Package: `@openslack/agent-runtime`

A new cross-cutting package (not a new product module) that provides:

| File             | Purpose                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `types.ts`       | `AgentRunRequest`, `AgentRunState`, `AgentRunResult`, `AgentPermissionProfile`, `AgentRunEvent` |
| `run-store.ts`   | File-based run storage under `.openslack.local/agents/runs/<runId>/`                            |
| `transcript.ts`  | Append-only JSONL transcript store                                                              |
| `recorder.ts`    | Run lifecycle recorder: start/progress/complete/fail                                            |
| `launcher.ts`    | `createOpenSlackAgentLauncher()` factory                                                        |
| `permissions.ts` | `buildPermissionProfile()`, `isActionAllowed()`, `enforceToolScope()`                           |

### Storage Layout

```
.openslack.local/agents/runs/<runId>/
  run.json       # AgentRunState
  metadata.json  # AgentRunRequest (minus prompt for size)
  transcript.jsonl
```

### Run Lifecycle

```
1. Resolve agent type → ResolvedAgentConfig
2. Check required MCP servers → AgentUnavailableError if missing
3. Build permission profile → check hardcoded denylists
4. Create worktree if isolation=worktree or implementer agent
5. Create run state in store (status: pending)
6. Emit 'start' transcript event
7. Execute agent (local adapter or LLM)
8. Record tool calls as transcript events
9. Emit 'complete' or 'fail' transcript event
10. Update run state
11. Cleanup worktree
```

### Integration Points

| Consumer                   | Integration                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| `@openslack/workflows`     | `runtime.ts` uses `createOpenSlackAgentLauncher()` as default launcher         |
| `@openslack/collaboration` | `conversation-store.ts` links runs to threads; `events.ts` receives run events |
| `@openslack/tui`           | `AgentRunDetailView` shows run status/progress/permissions                     |
| `apps/cli`                 | `conversation send` supports `@agent-id prompt` dispatch                       |

## Acceptance Criteria

- [ ] `workflow agent(prompt,{agentType})` runs without external launcher injection
- [ ] Each agent run produces `run.json` + `transcript.jsonl` + `metadata.json`
- [ ] Conversation thread shows subagent result via `agent_response`/`tool_event`
- [ ] TUI shows `AgentRunDetailView` with status/model/tools/permissions
- [ ] Tool allowlist/denylist enforced at runtime
- [ ] `bypassPermissions` blocked (fail closed)
- [ ] `isolation=worktree` enforced for implementer agents
- [ ] Agent run events appear in activity/digest/room via collaboration layer
- [ ] PR approval, merge, secret access, ruleset bypass always denied to subagents
