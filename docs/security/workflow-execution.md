---
schema: openslack.security_spec.v1
status: implemented
created: 2026-05-28
parent_spec: docs/product/workflow-modules.md
threat_model: true
---

# Workflow Execution Security Model

## Overview

This document defines the security model for OpenSlack workflow execution:
trust levels, permission enforcement, sandboxing, audit logging, and the
hardcoded invariants that protect the system even when a workflow is
compromised or malicious.

## Threat Model

| Threat | Mitigation |
|--------|------------|
| Malicious workflow file injected into repository | Trust levels + permission gating |
| Compromised agent subtask attempts unauthorized actions | Sandboxing + permission checker |
| Prompt injection via user-controlled input flowing into agent calls | Input sanitization + schema validation |
| Workaround forbidden actions via nested workflows | Permission intersection + hardcoded blocklist |
| Data exfiltration via agent output | Network sandboxing in preview mode |
| Credential access via workflow | Hardcoded forbidden: secrets.read |
| Privilege escalation via mode confusion | Strict mode isolation, no escalation path |
| Unbounded workflow nesting leading to recursion | Max nesting depth 1; child workflows cannot call `ctx.workflow()` |

## Trust Levels

Repository trust decisions are bound to the reviewed PR head. For changes to
tracked workflow artifacts, a valid non-author human approval must contain one
line:

```text
Workflow-Trust: untrusted|trusted|core
```

PRMS rejects bot/app reviews, stale-head approvals, duplicate or conflicting
markers, and tree evidence that does not match the current base/head pair.
CODEOWNER evidence is loaded from the PR's immutable base commit SHA and is
resolved against the complete PR changed-file set. It is never reinterpreted
from a later value of the mutable base branch.
Engine code, tests, and fixtures use normal PRMS approval and do not require a
workflow trust marker. This merge evidence does not automatically modify a
machine-local `.openslack/workflow-trust.yaml` store.

Core artifacts (`builtins`, the workflow catalog, and the pattern registry)
have explicit repository CODEOWNERS so a core-only PR has an authorized human
review path. New or core artifacts use one bot-created Workflow Governance
Issue. That Issue remains open until the post-merge finalizer records the
reviewer, reviewed commit, trust decision, and evidence hash, applies the
accepted/core labels, and closes it. Do not close a Governance Issue manually;
a partial or failed finalizer write must leave it open for a safe retry.

### Level 0: Untrusted

Applies to workflows loaded from legacy Anthropic paths
(`.claude/workflows/*.js`) or any workflow without explicit trust assignment.

**Allowed:**

- Read-only agent calls (filesystem reads, grep, code search)
- Read-only GitHub API calls (list issues, read PRs)
- Schema-validated output parsing
- Log and phase marker calls

**Denied:**

- All write operations (filesystem, git, GitHub)
- All `ctx.openslack.*` API calls except read-only
- Nested workflow invocation
- Budget override

### Level 1: Trusted

Applies to workflows authored by project contributors and explicitly trusted
via `openslack collaboration workflow trust <name> --level trusted`.

**Allowed:**

- All untrusted permissions
- Declared permissions (validated at load time)
- Side effects gated by permission checker
- `ctx.openslack.*` API calls within declared permissions
- Nested workflow invocation (permissions intersected)

**Denied:**

- All hardcoded forbidden actions
- Operations not in declared permissions
- Direct shell command execution outside agent shim

### Level 2: Core

Applies to workflows shipped with the `@openslack/workflows` package
(`packages/workflows/src/builtins/`).

**Allowed:**

- All trusted permissions
- Full access to `ctx.openslack.*` APIs
- Direct runtime integration

**Denied:**

- All hardcoded forbidden actions (no exceptions, even for core)

## Hardcoded Forbidden Actions

These actions are blocked for ALL trust levels, including core. No permission
declaration, trust upgrade, or configuration change can override them.

| Action | Block Reason |
|--------|-------------|
| `github.pr.approve` | Agents must never approve PRs — human approval required |
| `github.pr.merge` | Direct merge forbidden; workflows must use `ctx.openslack.prms.requestMerge()` which re-runs PRMS and merges only when all gates pass |
| `ruleset.bypass` | Branch protection rules cannot be bypassed programmatically |
| `secrets.read` | No workflow may read PEM keys, tokens, or credential files |
| `kernel.constitution.write` | Self-evolution governance rules are immutable by workflows |
| `agent.registry.write` | Agent registry modifications require human authorization |
| `workflow.trust.upgrade` | Trust level upgrades require human action, not workflow self-promotion |

### Enforcement Point

```typescript
// In permission-checker.ts — checked BEFORE every operation
const ALWAYS_FORBIDDEN: ReadonlySet<string> = Object.freeze(new Set([
  'github.pr.approve',
  'github.pr.merge',    // Direct merge forbidden; use ctx.openslack.prms.requestMerge()
  'ruleset.bypass',
  'secrets.read',
  'kernel.constitution.write',
  'agent.registry.write',
  'workflow.trust.upgrade',
]))

function assertAllowed(action: string): void {
  if (ALWAYS_FORBIDDEN.has(action)) {
    throw new SecurityError(`Action "${action}" is permanently forbidden`)
  }
}
```

## Permission Enforcement

### Declaration-Required Model

Every side-effect operation requires an explicit permission declaration in the
workflow manifest. There is no implicit permission.

```typescript
// In meta.permissions
permissions: {
  github: ['issues:create', 'prs:create'],
  git: ['branch:create', 'push'],
  filesystem: ['workspace:write'],
  openslack: ['task:create', 'prms:doctor'],
}
```

### Runtime Permission Check

Before every side-effect operation, the runtime:

1. Checks the action against the hardcoded forbidden list
2. Checks the action against the workflow's declared permissions
3. Checks the action against the trust level's allowed set
4. Checks the current execution mode allows the operation
5. Logs the permission check result to the audit log

```typescript
function checkPermission(
  action: string,
  declared: WorkflowPermissions,
  trustLevel: TrustLevel,
  mode: ExecutionMode,
): { allowed: boolean; reason?: string } {
  // 1. Hardcoded blocklist
  if (ALWAYS_FORBIDDEN.has(action)) {
    return { allowed: false, reason: 'Permanently forbidden' }
  }

  // 2. Execution mode
  if (mode === 'validate' || mode === 'preview') {
    if (isWriteAction(action)) {
      return { allowed: false, reason: `Not allowed in ${mode} mode` }
    }
  }
  if (mode === 'dry-run') {
    // Simulate, don't execute
    return { allowed: false, reason: 'Simulated in dry-run mode' }
  }

  // 3. Trust level
  if (trustLevel === 'untrusted' && isWriteAction(action)) {
    return { allowed: false, reason: 'Write operations require trusted level' }
  }

  // 4. Declared permissions
  const [category, operation] = action.split('.')
  const declaredActions = declared[category] || []
  if (!declaredActions.includes(operation)) {
    return { allowed: false, reason: `Permission "${action}" not declared in manifest` }
  }

  return { allowed: true }
}
```

### Dry-Run Simulation

In dry-run mode, all write operations return simulated success without
executing. The simulation logs what would have happened:

```
[DRY-RUN] Would create GitHub issue: "[P1] [runtime] Unhandled null"
[DRY-RUN] Would create branch: fix/runtime/unhandled-null
[DRY-RUN] Would push 1 commit to origin/fix/runtime/unhandled-null
[DRY-RUN] Would create PR targeting main
```

## Sandboxing

### Filesystem Isolation

Agent subtasks with `isolation: 'worktree'` are restricted to their worktree
directory. The runtime enforces this by:

1. Creating a git worktree via `createWorktree(taskId, agentId, runId)`
2. Setting the agent's `cwd` to the worktree path
3. Intercepting all filesystem write calls and validating they target the
   worktree path or the run store directory

Writes to paths outside the worktree are blocked:

```
path.normalize(writePath).startsWith(path.normalize(worktreePath))
  || path.normalize(writePath).startsWith(runStorePath)
```

### Network Isolation

| Mode | Read API | Write API | External Network |
|------|----------|-----------|------------------|
| validate | None | None | None |
| preview | GitHub read-only (non-mutating agents) | None | None |
| dry-run | GitHub read-only | Simulated | None |
| execute | GitHub read/write (via proxy) | GitHub write (via proxy) | Blocked |

All GitHub API calls in execute mode are proxied through OpenSlack's GitHub
adapter, which:

- Enforces bot identity (`GH_TOKEN` from the bot token utility)
- Rate-limits API calls (max 100 per workflow run)
- Logs all API calls to the audit log
- Blocks calls to endpoints not in the declared permissions

### Agent Subtask Isolation

Each agent subtask runs in an isolated context:

1. **Filesystem**: Restricted to worktree (if isolated) or workspace root (read-only in preview)
2. **Network**: Proxied through OpenSlack's GitHub adapter
3. **Process**: No direct shell command execution — all side effects routed through runtime APIs
4. **State**: No access to parent workflow's runtime context or run store

## HTML Artifact Redaction

Before run data is embedded in an HTML artifact, a redaction layer sanitizes:

1. **File contents**: Only file paths from findings are included. No source code
   is embedded. Context snippets are limited to 3 lines.
2. **Agent prompts**: Full prompt text is stripped; only label, phase, and result
   summary are retained.
3. **Tokens and credentials**: Any tokens in URLs are stripped. API URLs with
   query parameters are redacted to origin + pathname only.
4. **Absolute paths**: Remapped to repo-root-relative paths before embedding.
5. **Failed schema output**: Agent output that failed schema validation is not
   embedded; only the validation error summary is retained.

The redaction layer is enforced at the HTML renderer boundary. Raw run data
never reaches the HTML template without passing through redaction first.

## Input Sanitization

### Agent Prompt Construction

When user-controlled input flows into agent prompts (e.g., issue titles,
findings, file paths), the runtime sanitizes:

1. **Shell metacharacters**: All values passed through `assertSafeSegment()` before
   use in any command context (see `packages/runtime/src/worktree.ts`)

2. **Path traversal**: All file paths validated with `path.normalize()` and checked
   against allowed directories

3. **Schema validation**: All agent output validated against declared schemas.
   If validation fails, the result is discarded (fail-closed)

### Risk Zone Validation

LLM-assigned `risk_zone` values (from triage output) are NOT trusted. The
runtime validates them against `classifyPaths()`:

```typescript
// After triage returns risk_zone for each issue
const realZones = await ctx.openslack.prms.classify(
  issue.file ? [issue.file] : [`packages/${issue.module}/`]
)
if (realZones.red.length > 0 && issue.risk_zone !== 'red') {
  ctx.log(`WARNING: LLM assigned ${issue.risk_zone} but classifyPaths() returned red`)
  issue.risk_zone = 'red'  // Escalate to more restrictive
}
```

The runtime always escalates to the more restrictive zone, never downgrades.

## Audit Logging

### What Is Logged

Every workflow run produces a complete audit trail:

| Event | Fields |
|-------|--------|
| Workflow loaded | name, format, trust level, manifest hash |
| Permission check | action, allowed, reason |
| Phase transition | from, to, timestamp, checkpoint hash |
| Agent call | label, phase, prompt hash, schema, result hash, token usage |
| Side effect | type, target, mode (simulated/real), result |
| Permission denied | action, reason, caller |
| Error | phase, message, stack trace |

### Log Storage

Audit logs are stored in `.openslack.local/workflows/runs/<runId>/log.jsonl`
as newline-delimited JSON. Each entry has a timestamp and run ID.

### Log Integrity

Logs are append-only. The runtime never deletes or modifies log entries after
writing. On resume, new entries are appended to the existing log.

### Governance Audit

```typescript
ctx.openslack.governance.audit('workflow.side-effect', {
  action: 'github.issue.create',
  target: issueTitle,
  mode: 'execute',
  permission: 'github.issues:create',
  trustLevel: 'trusted',
})
```

Governance audit entries are also recorded to the collaboration layer for
cross-referencing with other agent actions.

## Mode Isolation Invariants

### No Mode Escalation

A workflow running in one mode cannot escalate to a higher mode:

- `preview` cannot call write operations or upgrade to `dry-run`
- `dry-run` cannot execute real side effects or upgrade to `execute`
- `validate` cannot make any agent calls at all

### No Mode Confusion

The execution mode is set once at workflow start and is immutable:

```typescript
// In runtime constructor
Object.defineProperty(this, 'mode', {
  value: options.mode,
  writable: false,
  configurable: false,
})
```

### Confirmation Gate

For `execute` mode, the runtime requires explicit confirmation before the
first side-effect operation:

```typescript
if (this.mode === 'execute' && !this.confirmed) {
  const confirmed = await this.confirmationPrompt(
    `Workflow "${this.manifest.name}" requests write access. Proceed?`
  )
  if (!confirmed) {
    throw new Error('Workflow execution cancelled by user')
  }
  this.confirmed = true
}
```

In CLI, this is `--yes` flag. In TUI, this is a modal dialog. In chat,
this is a reaction-based confirmation.

## Bot Delivery Credential Boundary

The bot PR wrappers resolve `appId` and `installationId` from explicit
`OPENSLACK_GITHUB_APP_*` settings or the non-secret local
`.openslack.local/github-app.json` import record. They do not contain
organization-specific ID defaults.

The private key is read only by `scripts/bot-gh-token.js` to mint a short-lived
installation token. The subsequent `openslack pr workflow-governance` child
receives only that token through `OPENSLACK_GITHUB_APP_INSTALLATION_TOKEN`; it
does not receive the PEM. The token is neither persisted nor forwarded through
`GITHUB_TOKEN`, `GH_TOKEN`, command arguments, Git configuration, or logs.

## Failure Modes

### Schema Validation Failure

When agent output fails schema validation, the runtime follows a unified rule:
**invalid output is never passed as valid data.** The handling depends on the
call context:

1. **Standalone (required) agent call**: The `SchemaValidationError` propagates
   to the workflow author's error handling. If uncaught, the workflow fails.
   The invalid result is discarded — it never reaches workflow logic.
2. **Fan-out item** (inside `parallel()` or `pipeline()`): The failed item
   is recorded as `{ status: 'schema_failed', label, violations }` and the
   result slot is set to `null`. The workflow continues with remaining items.
3. In both cases: the failure is logged with label, phase, schema violations,
   and the raw output is discarded (not cached, not embedded in HTML artifacts).

This ensures workflows never silently process malformed data, while allowing
graceful degradation for fan-out operations where individual items may fail.

### Permission Denied

When a permission check fails:

1. Operation is blocked (not executed)
2. Error logged with action, reason, and caller
3. Governance audit event recorded
4. Workflow continues or fails based on error handling

### Budget Exhausted

When token budget is exhausted:

1. All pending and future agent calls are blocked
2. Currently running agents are allowed to complete
3. Workflow is paused (not failed) with status "budget-exhausted"
4. User can resume with additional budget: `openslack collaboration workflow resume <runId> --budget 100000`

### Cache Corruption

When a cached result fails deserialization:

1. Cache entry is deleted
2. Agent call is re-executed
3. Warning logged with cache key and corruption details

## Relationship to Other Security Documents

| Document | Overlap | Relationship |
|----------|---------|-------------|
| [human-approval.md](human-approval.md) | Approval gates | Workflows respect approval freshness rules for PR merge |
| [self-evolution-guardrails.md](self-evolution-guardrails.md) | Kernel protection | Workflows cannot write to kernel constitution |
| [collaboration-audit.md](collaboration-audit.md) | Audit trail | Workflow audit entries feed into collaboration audit log |
| [tui-terminal-safety.md](tui-terminal-safety.md) | Terminal safety | HTML artifacts follow terminal escape sequence safety rules |
