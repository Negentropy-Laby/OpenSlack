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
structured results from an explicitly configured execution provider, records
transcripts, enforces permissions, and feeds the collaboration event pipeline.
An unconfigured launcher fails with `RUNTIME_NOT_CONFIGURED`; the local adapter
is a test fixture and is never selected by production defaults.

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

| File                           | Purpose                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `types.ts`                     | `AgentRunRequest`, `AgentRunState`, `AgentRunResult`, `AgentPermissionProfile`, `AgentRunEvent` |
| `run-store.ts`                 | File-based run storage under `.openslack.local/agents/runs/<runId>/`                            |
| `transcript.ts`                | Append-only JSONL transcript store                                                              |
| `recorder.ts`                  | Run lifecycle recorder: start/progress/complete/fail                                            |
| `launcher.ts`                  | `createOpenSlackAgentLauncher()` factory                                                        |
| `provider-registry.ts`         | Instance-scoped execution-provider registration and resolution                                  |
| `permissions.ts`               | `buildPermissionProfile()`, `isActionAllowed()`, `enforceToolScope()`                           |
| `tool-executor.ts`             | Worktree-scoped read/search/exact-patch/diff tool plane                                         |
| `openai-compatible-runtime.ts` | Bounded Chat Completions provider and non-secret config loader                                  |

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
4. Resolve execution provider independently from model vendor and transport
5. If unresolved, persist a direct terminal `failed + RUNTIME_NOT_CONFIGURED` run
6. Only after provider validation, create a worktree when required
7. Create running state and emit the `start` transcript event
8. Execute the registered provider adapter
9. Parse tool arguments, enforce ToolGuard/path/size limits, execute, and redact
10. Charge provider usage after every response and enforce independent limits
11. Validate structured output before completion
12. Emit `complete` or typed `fail` and update run state
13. Cleanup or preserve the worktree according to dirty-state evidence
```

### Integration Points

| Consumer                   | Integration                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| `@openslack/workflows`     | `runtime.ts` uses `createOpenSlackAgentLauncher()` as default launcher         |
| `@openslack/collaboration` | `conversation-store.ts` links runs to threads; `events.ts` receives run events |
| `@openslack/tui`           | `AgentRunDetailView` shows run status/progress/permissions                     |
| `apps/cli`                 | `conversation send` supports `@agent-id prompt` dispatch                       |

## Acceptance Criteria

- [x] `workflow agent(prompt,{agentType})` fails closed unless its execution provider is configured
- [x] Each started or configuration-rejected agent run produces redacted local evidence
- [ ] Conversation thread shows subagent result via `agent_response`/`tool_event`
- [ ] TUI shows `AgentRunDetailView` with status/model/tools/permissions
- [x] Tool allowlist/denylist enforced before every built-in provider tool execution
- [ ] `bypassPermissions` blocked (fail closed)
- [x] `isolation=worktree` enforced for implementer and built-in write-capable agents
- [ ] Agent run events appear in activity/digest/room via collaboration layer
- [ ] PR approval, merge, secret access, ruleset bypass always denied to subagents
