---
schema: openslack.security_spec.v1
status: active
created: 2026-06-02
threat_model: true
---

# Agent Runtime Permissions — Security Specification

## Overview

This document defines the security model for the Agent Runtime. It covers
permission profile construction, tool scope enforcement, isolation guarantees,
and hardcoded denylists.

## Threat Model

| Threat                                             | Mitigation                                                                            | Status      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------- |
| Subagent escalates privileges beyond declared mode | `buildPermissionProfile()` intersects mode baseline with allowlist                    | Implemented |
| Subagent accesses tools outside its allowlist      | `isActionAllowed()` checks at launcher level                                          | Implemented |
| Subagent modifies files without worktree isolation | `isolation=worktree` creates git worktree; implementer agents required                | Implemented |
| Subagent reads secrets or credentials              | `canReadSecrets: false` hardcoded; `secrets.read` in `SUBAGENT_ALWAYS_FORBIDDEN`      | Implemented |
| Subagent approves its own PR                       | `canApprovePR: false` hardcoded; `github.pr.approve` in `SUBAGENT_ALWAYS_FORBIDDEN`   | Implemented |
| Subagent merges without human approval             | `canMerge: false` hardcoded; `github.pr.merge` in `SUBAGENT_ALWAYS_FORBIDDEN`         | Implemented |
| Subagent bypasses branch protection                | `canBypassRulesets: false` hardcoded; `ruleset.bypass` in `SUBAGENT_ALWAYS_FORBIDDEN` | Implemented |
| `bypassPermissions` mode grants unlimited access   | Parser rejects `bypassPermissions`; permission builder defaults to `strict`           | Implemented |
| Corrupted run metadata allows replay               | `getRun()` returns `null` on parse failure                                            | Implemented |
| Path traversal via runId                           | `RUN_ID_RE` validates format before any filesystem access                             | Implemented |

## Hardcoded Denylist

These actions are permanently forbidden to all subagents:

```
github.pr.approve      // Agents must never approve PRs
github.pr.merge        // Direct merge forbidden
ruleset.bypass         // Branch protection cannot be bypassed
secrets.read           // No credential access
agent.registry.write   // Registry changes require human auth
workflow.trust.upgrade // No self-promotion
```

No permission declaration, trust level, or configuration can override these.

## Permission Mode Mapping

| Mode          | isReadOnly | acceptEdits | Baseline Tools                 |
| ------------- | ---------- | ----------- | ------------------------------ |
| `plan`        | true       | false       | Read, Grep, Glob, Find         |
| `acceptEdits` | false      | true        | + Edit, Write                  |
| `default`     | false      | false       | + Bash                         |
| `strict`      | false      | false       | + Bash (confirmation required) |

## Tool Scope Enforcement

```
effective_tools = mode_baseline ∩ tools_allowlist − disallowedTools − hardcoded_denylist
```

The launcher calls `enforceToolScope(profile, requestedTools)` before execution.
Any tool in the `denied` list causes a `PermissionDeniedError`.

## Worktree Isolation

When `isolation=worktree`:

1. `createWorktree()` creates isolated git worktree on temp branch
2. Agent's working directory set to worktree root
3. File operations confined to worktree
4. Cleanup in `finally` block

Implementer agents (detected by ID/prompt containing "implement") are **required**
to use worktree isolation. If not configured, the launcher warns and creates one
automatically.

## Secret Scanning

Run artifacts (`run.json`, `metadata.json`, `transcript.jsonl`) are not yet
secret-scanned in Phase AR. This is planned for Phase AR-2. Conversation messages
already use `scanValue()` from `@openslack/collaboration`.

## Audit Trail

Every agent run produces:

- `run.json` — state snapshot
- `metadata.json` — request metadata
- `transcript.jsonl` — chronological event log

These feed into:

- Activity feed via `recordEvent()`
- Digest via `buildDigest()`
- Room view via `buildRoomView()`
