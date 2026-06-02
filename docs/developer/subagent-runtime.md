---
schema: openslack.developer_doc.v1
status: active
created: 2026-06-02
source: Phase AC — Agent Conversations & Subagent Runtime
---

# Subagent Runtime

## Overview

The subagent runtime provides the infrastructure for discovering, resolving, and
dispatching subagents within OpenSlack. A subagent is an independently configured
agent with its own prompt, tool allowlist, permission mode, and optional isolation.

This document covers the architecture, lifecycle, and integration points.
For the security model, see `docs/security/subagent-permissions.md`.

## Architecture

### Resolution Pipeline

Subagent resolution follows a strict priority order:

```
agentType string
  │
  ├─ 1. OpenSlack registry (.openslack/agents/registry/*.yaml)
  │     └─ Highest priority — production-registered agents
  │
  └─ 2. Claude Code subagents (.claude/agents/*.md)
        ├─ Project-level (<root>/.claude/agents/) — source: claude-project
        └─ User-level ($HOME/.claude/agents/) — source: claude-user
```

Resolution is handled by `resolveAgentType()` in `@openslack/workflows`.

### Key Packages

| Package | Role |
|---------|------|
| `@openslack/kernel` | Defines `SubagentDefinition` and `PermissionMode` types |
| `@openslack/workspace` | `parseSubagentMarkdown()` and `discoverSubagents()` — parses `.md` files |
| `@openslack/workflows` | `resolveAgentType()` — full resolution with caching |
| `@openslack/operator` | `tool-registry.ts` — routes actions through the planner |

### Caching

`resolveAgentType()` uses a module-scoped cache with a 30-second TTL. Cache is
keyed on `rootDir` to avoid cross-project contamination. The cache is cleared
between tests via `clearSubagentCache()`.

## Subagent Definition File Format

Subagents are defined as Markdown files with YAML frontmatter:

```markdown
---
name: Code Reviewer
description: Reviews code for correctness and style
model: sonnet
tools:
  - Read
  - Grep
  - Glob
disallowedTools:
  - Edit
  - Write
  - Bash
permissionMode: plan
maxTurns: 15
skills:
  - code-review
mcpServers:
  - name: github
memory: project
isolation: none
color: green
---
You are a code reviewer. Analyze the provided diff for correctness bugs,
security issues, and style problems. Do not suggest edits — only report findings.
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable agent name |
| `description` | string | One-line purpose summary |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | inherited | Model override (e.g., `sonnet`, `opus`, `haiku`) |
| `tools` | string[] | all allowed | Allowlist of tools the subagent may use |
| `disallowedTools` | string[] | none | Tools explicitly denied |
| `permissionMode` | string | `default` | One of: `plan`, `acceptEdits`, `default`, `strict` |
| `maxTurns` | number | inherited | Maximum conversation turns |
| `skills` | string[] | none | Named skill references |
| `mcpServers` | object[] | none | MCP server configurations |
| `memory` | string | `local` | Memory scope: `user`, `project`, `local`, `none` |
| `isolation` | string | `none` | Isolation mode: `none`, `worktree` |
| `color` | string | none | Display color for TUI |

### Validation

The parser in `@openslack/workspace/subagent-parser.ts` enforces:

1. **YAML frontmatter** must be present and parseable.
2. **`name` and `description`** are required and non-empty.
3. **`permissionMode`** must be one of the four valid values.
4. **`tools`, `disallowedTools`, `skills`, `mcpServers`** must be arrays.
5. **`maxTurns`** must be a number.
6. **`memory`** must be one of: `user`, `project`, `local`, `none`.
7. **`isolation`** must be one of: `none`, `worktree`.

Any validation failure throws an error naming the file and field — no silent
coercion.

## Source Classification

The `source` field indicates where the definition was found:

| Source | Location | Priority |
|--------|----------|----------|
| `openslack-registry` | `.openslack/agents/registry/*.yaml` | 1 (highest) |
| `claude-project` | `<root>/.claude/agents/*.md` | 2 |
| `claude-user` | `$HOME/.claude/agents/*.md` | 3 |
| `runtime` | Any other path | 4 |

Project-level agents override user-level agents with the same ID. This prevents
project-specific configurations from being accidentally overridden by a user's
personal agents.

## Lifecycle

```
1. Discovery   → discoverSubagents() scans project and user directories
2. Parsing     → parseSubagentMarkdown() validates and parses each .md file
3. Resolution  → resolveAgentType() picks the highest-priority match
4. Dispatch    → (future) spawn isolated agent process with resolved config
```

### Discovery

`discoverSubagents(rootDir)` scans two directories:

- `<rootDir>/.claude/agents/*.md` — project-level
- `$HOME/.claude/agents/*.md` — user-level (if HOME is set)

Both are non-recursive. Files must have the `.md` extension.

### Resolution

`resolveAgentType(agentType, rootDir)` returns a `ResolvedAgentConfig` or `null`:

1. Check OpenSlack registry YAML files for an exact `agent_id` match.
2. Scan discovered subagents — project-level first, then user-level.
3. Return `null` if no match found (does not throw).

## Integration with Operator

Subagent resolution integrates with the operator via the tool registry. The
`agent.claim_task` action already routes through `agent tick --source github-issues`.
Future subagent dispatch actions will follow the same pattern:

```
RegisteredActionId → build() → PlanStep → executor → agent-resolver → spawn
```

## Related Files

- `packages/kernel/src/types.ts` — `SubagentDefinition`, `PermissionMode`
- `packages/workspace/src/subagent-parser.ts` — parsing and discovery
- `packages/workflows/src/agent-resolver.ts` — resolution with caching
- `packages/operator/src/tool-registry.ts` — action routing
- `docs/security/subagent-permissions.md` — security model
