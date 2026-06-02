---
schema: openslack.security_spec.v1
status: partial
created: 2026-06-02
parent_spec: docs/developer/subagent-runtime.md
threat_model: true
---

# Subagent Permission Model

## Overview

This document describes the security model for subagent definitions in OpenSlack.
The current implementation covers **parsing, validation, and resolution** of
subagent definitions. Runtime enforcement (tool restriction, worktree isolation,
dispatch) is not yet implemented and is marked accordingly.

**Current state:** Subagent definitions are parsed with strict validation,
resolved through a priority pipeline, and cached. The fields described below
are validated at parse time. Runtime enforcement of `permissionMode`, `tools`,
`disallowedTools`, and `isolation` will be implemented when the subagent
dispatch runner is built.

## Threat Model

| Threat | Mitigation | Status |
|--------|------------|--------|
| Invalid permissionMode allows privilege escalation | `permissionMode` validated at parse time; only 4 values accepted | ✅ Implemented |
| Non-array `tools` field silently iterates characters | Runtime type check rejects non-array `tools`/`disallowedTools`/`skills`/`mcpServers` | ✅ Implemented |
| Invalid `memory`/`isolation` enum values | Enum validation rejects unknown values at parse time | ✅ Implemented |
| HOME with trailing slash misclassifies agent source | `inferSource` strips trailing slashes before comparison | ✅ Implemented |
| Subagent escalates privileges beyond declared mode at runtime | Dispatch runner must intersect resolved tools with permission mode baseline | ⬜ Not yet implemented |
| Subagent accesses tools outside its allowlist at runtime | Runtime tool filtering during dispatch | ⬜ Not yet implemented |
| Subagent modifies files without worktree isolation | `isolation: worktree` creates separate git worktree during dispatch | ⬜ Not yet implemented |
| Subagent reads secrets or credentials | Constitutional constraint #9 + `scanValue()` blocks secrets in persisted conversation data | ✅ Implemented (persistence) |
| Subagent modifies its own definition or registry | Constitutional constraint #6 prohibits self-prompt-edit | ✅ Enforced by constitution |
| Subagent bypasses human approval for Red Zone changes | Constitutional constraints #3 and #8 | ✅ Enforced by constitution |

## Permission Modes (Parsed, Not Yet Runtime-Enforced)

Each subagent declares one of four permission modes in its frontmatter
`permissionMode` field. The parser validates the value; the dispatch runner
will enforce the capability restrictions.

| Mode | Intended Capabilities | Use Case |
|------|----------------------|----------|
| `plan` | Read-only — analyze, search, report but never modify | Code review, research, triage |
| `acceptEdits` | Read + targeted edits — modify files but no shell commands | Implementing fixes, documentation |
| `default` | Standard tool access — read, edit, non-destructive shell | General-purpose tasks |
| `strict` | All tools available but confirmation required for side effects | High-trust agents on sensitive paths |

**Parse-time validation:** The parser rejects any value not in this set. A typo
in `permissionMode` causes the entire definition to fail — no fallback.

## Tool Restrictions (Parsed, Not Yet Runtime-Enforced)

### Allowlist (`tools`)

When `tools` is specified, the subagent should only use those tools. At
dispatch time, the intended behavior is:

```
effective_tools = permission_mode_baseline ∩ tools_allowlist
```

If `tools` is omitted, the permission mode's full baseline applies.

### Deny list (`disallowedTools`)

The deny list takes absolute precedence:

```
effective_tools = effective_tools − disallowedTools
```

A tool in `disallowedTools` should never be available, even if it appears
in `tools`.

### Type Safety (Implemented)

Both `tools` and `disallowedTools` must be arrays. Passing a string (e.g.,
`tools: "Read"`) causes a parse error. This prevents silent character-by-character
iteration that was possible before the R3 fix.

## Isolation Modes (Parsed, Not Yet Runtime-Enforced)

| Mode | Intended Behavior |
|------|-------------------|
| `none` | Subagent operates in the current working directory. File system access constrained by permission mode. |
| `worktree` | Subagent operates in an isolated git worktree. Changes invisible to main branch until merged. |

### Worktree Isolation (Planned)

When `isolation: worktree` is set, the planned dispatch behavior is:

1. A new git worktree is created on a temporary branch.
2. The subagent's working directory is set to the worktree root.
3. All file operations are confined to the worktree.
4. On completion, the worktree is either merged (after approval) or discarded.

This is not yet implemented. The `isolation` field is validated at parse time
but has no runtime effect.

## Memory Scoping (Implemented)

The `memory` field controls how subagent conversation data is persisted:

| Scope | Retention | Visibility |
|-------|-----------|------------|
| `none` | Ephemeral — messages are not written to disk | Current session only |
| `local` | 24 hours (default) | Local workspace |
| `project` | 7 days (7x multiplier) | Shared across project collaborators |
| `user` | 24 hours | User's local environment |

Memory policy is enforced at the persistence layer. When `memory: none` is set,
`appendMessage()` returns the message object but does not write to JSONL storage.
Thread metadata (`thread.json`) is always preserved for audit purposes.

## Constitutional Constraints

Subagents inherit all constitutional constraints from `.openslack/self/constitution.md`:

1. **No direct push to main** — all changes go through PRs.
2. **No self-review** — subagents cannot approve their own output.
3. **No auto-approval** — subagents must never originate approval decisions.
4. **Merge after human approval** — subagents may merge only after valid human approval.
5. **No sole-author-codeowner PR** — prevents governance deadlock.
6. **No self-prompt-edit** — subagents cannot modify their own definitions at runtime.
7. **No validation bypass** — subagents cannot disable or weaken required checks.
8. **No protected path modification without approval** — Red Zone changes require human approval.
9. **No secret access** — subagents cannot read, write, or summarize credential material.
10. **Black Zone is never mergeable** — always rejected, never escalated.

These constraints apply regardless of whether the subagent dispatch runner is
implemented. They are enforced by the existing PRMS and kernel infrastructure.

## Validation Chain (Implemented)

Subagent definitions pass through a multi-stage validation chain:

```
YAML frontmatter
  → parseSubagentMarkdown()
    → name/description presence check
    → permissionMode enum validation
    → field type validation (array, number, string enum)
      → discoverSubagents()
        → filesystem scan
          → resolveAgentType()
            → priority resolution (registry > project > user)
```

Each stage can reject the definition with a descriptive error. There are no
silent fallbacks or coercions at any stage. The dispatch step is not yet
implemented.

## Audit Trail (Partially Implemented)

Current subagent observability:

- **Conversation threads** — threads can be created and linked to agents
- **Typed messages** — 7 kinds persisted in JSONL
- **Secret scanning** — all messages pass through `scanValue()` before persistence

Planned but not yet implemented:

- **Automatic thread creation** on subagent dispatch
- **Room view aggregation** for subagent conversations
- **Lifecycle events** (`agent.conversation.started/completed/failed`)

See `docs/developer/collaboration-events.md` for the full event model.

## Related Files

- `packages/kernel/src/types.ts` — type definitions
- `packages/workspace/src/subagent-parser.ts` — parsing and validation
- `packages/workflows/src/agent-resolver.ts` — resolution with caching
- `packages/collaboration/src/conversation-store.ts` — thread persistence
- `packages/collaboration/src/redact.ts` — secret scanning
- `.openslack/self/constitution.md` — constitutional constraints
