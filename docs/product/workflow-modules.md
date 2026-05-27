---
schema: openslack.product_spec.v1
status: design
created: 2026-05-28
source: .claude/workflows/full-lifecycle.js
canonical_status: docs/status/current.md
---

# OpenSlack Workflows — Product Design

## 1. Overview

OpenSlack Workflows are **deterministic, previewable, resumable, auditable
agent-native workflow modules** that run inside the OpenSlack runtime. A
workflow is a JS/TS module that declares metadata, schemas, permissions, and
side effects, then executes through a controlled runtime that gates every
dangerous operation.

Workflows absorb the Anthropic-style DSL patterns found in
`.claude/workflows/full-lifecycle.js` (parallel agents, schema-constrained
output, adversarial verification, pipeline processing) while adding OpenSlack's
own trust model, permission enforcement, preview/dry-run/execute modes, PRMS
gates, collaboration events, and API integration.

### Design Principles

| Principle | Meaning |
|-----------|---------|
| Deterministic | Same inputs + same cache state produce same outputs. No hidden randomness. |
| Previewable | Every workflow can run in preview mode with zero side effects. |
| Resumable | Interrupted workflows resume from the last completed phase, not from scratch. |
| Auditable | Every agent call, permission check, and side effect is recorded to the run store. |
| Gated | No workflow can approve PRs, bypass rulesets, merge, or read secrets. |
| Schema-constrained | Agent output is structured data validated against declared schemas, not free text. |

## 2. Anthropic Workflow Core Mechanisms

The reference implementation `.claude/workflows/full-lifecycle.js` demonstrates
six core mechanisms that OpenSlack must absorb:

### 2.1 `agent(prompt, opts)` — Subtask Delegation

Launches a specialist LLM agent with a label, phase, and optional output schema.
The agent reads files, runs commands, and returns structured output.

```javascript
const result = await agent(prompt, {
  label: 'scan:security',
  phase: 'Scan',
  schema: FINDING_SCHEMA,
  isolation: 'worktree',     // OpenSlack extension
})
```

OpenSlack adds `isolation` (worktree sandbox), `budget` (token/cost cap), and
routes side effects through OpenSlack APIs instead of raw shell commands.

### 2.2 `parallel(tasks)` — Concurrent Execution

Runs an array of async thunks concurrently. Used in Scan (5 dimensions) and
Verify (3 verifiers per finding).

```javascript
const results = await parallel(
  DIMENSIONS.map(d => () => agent(d.prompt, { schema: FINDING_SCHEMA }))
)
```

OpenSlack adds concurrency limits, budget tracking across parallel tasks, and
per-task isolation options.

### 2.3 `pipeline(items, fn)` — Sequential Processing with Progress

Processes a list sequentially, emitting progress events. Used in Verify (each
finding) and Create Issues (each issue).

```javascript
const results = await pipeline(findings, async (finding, idx) => {
  // process each finding
})
```

OpenSlack adds progress bar integration with the TUI and checkpoint persistence
after each item completes.

### 2.4 `phase(name)` and `log(text)` — Execution Markers

`phase()` marks the current execution stage for logging, UI progress, and
checkpointing. `log()` writes structured log entries.

OpenSlack extends `phase()` to automatically checkpoint state and validate
phase transitions against the declared `meta.phases` array.

### 2.5 Schema-Constrained Output

Three JSON schemas constrain agent output to structured data:

| Schema | Phase | Purpose |
|--------|-------|---------|
| `FINDING_SCHEMA` | Scan | Structured findings with title, severity, category, module, file, description |
| `VERDICT_SCHEMA` | Verify | Boolean `refuted` + reason string |
| `TRIAGE_SCHEMA` | Triage | Prioritized issues with P0-P3, risk zone, labels |

OpenSlack requires all `agent()` calls to declare schemas and fails closed on
validation errors. LLM-assigned `risk_zone` is validated against the real
`classifyPaths()` classifier, not trusted.

### 2.6 3-Vote Adversarial Verification

Each finding gets 3 adversarial verifiers. If 2+ refute, the finding is
dropped (pigeonhole early-exit):

```
3 verifiers → 2 refutes = drop
```

This is the most important design pattern from the reference workflow.
OpenSlack adopts it as a standard capability available to any workflow.

## 3. Product Positioning

### Target Users

| User | Use Case |
|------|----------|
| Operator (human) | Run predefined workflows with `openslack workflow run <name>` |
| Operator (agent) | Trigger workflows programmatically via `ctx.openslack.workflow.run()` |
| Developer | Write new workflows using the OpenSlack-native format |
| Security reviewer | Audit workflow permissions, side effects, and run history |

### Workflow vs. One-shot Agent

| Aspect | One-shot Agent | Workflow |
|--------|---------------|----------|
| Determinism | Low (varies by prompt) | High (structured phases, schemas) |
| Resumability | None | Checkpoint per phase |
| Auditability | Conversation log only | Structured run store with full provenance |
| Side effects | Ungated | Permission-gated, previewable |
| Reusability | Copy-paste prompt | Versioned module with declared interface |

### Workflow vs. CI Pipeline

| Aspect | CI Pipeline | Workflow |
|--------|------------|----------|
| Execution | Container/VM | Agent subtask (LLM + tools) |
| Branching logic | YAML conditionals | Full TypeScript |
| Schema validation | None | Required for all agent output |
| Human interaction | Manual approval gates | Collaboration events, handoffs |
| Resume | Re-run from scratch | Resume from last checkpoint |

## 4. User Experience Design

### CLI Commands

```
# List available workflows
openslack workflow list

# Preview a workflow (no side effects)
openslack workflow preview full-lifecycle --input scope=packages/runtime

# Dry-run (simulate side effects, no real changes)
openslack workflow dry-run full-lifecycle --input scope=all

# Execute (real side effects with confirmation)
openslack workflow run full-lifecycle --input scope=all --confirm

# Resume an interrupted run
openslack workflow resume <runId>

# Inspect a past run
openslack workflow inspect <runId>

# Show workflow details and permissions
openslack workflow show full-lifecycle
```

### Execution Modes

| Mode | Agent Calls | GitHub API | Git Operations | File Writes | Confirmation |
|------|------------|------------|----------------|-------------|-------------|
| validate | No | No | No | No | No |
| preview | Yes (read-only) | Read-only | No | No | No |
| dry-run | Yes (read-only) | Simulated | Simulated | Simulated | No |
| execute | Yes | Yes | Yes | Yes | Required |

### TUI Integration

The TUI Dashboard view gains a "Workflows" tab showing:

- Active runs with phase progress bars
- Completed runs with pass/fail status
- Select a run to see detailed phase results
- Launch preview/dry-run from TUI (execute requires CLI confirmation)

The Doctor view gains workflow health checks:

- Orphaned run directories
- Stale cache entries
- Permission mismatches between workflow manifest and granted permissions

### Output Formats

| Format | Command Flag | Description |
|--------|-------------|-------------|
| terminal | default | Structured output to stdout |
| markdown | `--format markdown` | Markdown report written to file |
| html | `--format html` | Self-contained HTML artifact with CSP |
| json | `--format json` | Structured JSON for programmatic consumption |

HTML artifacts are self-contained: no external CDN, no network requests, inline
CSS/JS, CSP headers in meta tag. Suitable for sharing via GitHub Pages, Slack
attachment, or local file.

## 5. File Format

### 5.1 Anthropic-Compatible Format (Migration Layer)

The reference workflow uses this format. OpenSlack provides a compatibility
shim that injects ambient globals and wraps the body in an async function:

```javascript
export const meta = {
  name: 'full-lifecycle',
  description: 'Complete issue-to-PR lifecycle...',
  phases: [...],
}

// Ambient globals (injected by runtime, not imported):
// args, phase, log, parallel, pipeline, agent, budget, workflow

const scope = args?.scope || 'all'
// ... workflow body using ambient globals ...
return { status: 'complete', ... }
```

**Limitations:** No permission declarations, no preview/dry-run separation,
direct GitHub/git commands bypass OpenSlack gates, no checkpoint/resume,
no explicit runtime API.

### 5.2 OpenSlack-Native Format (Preferred)

```typescript
import type { WorkflowRuntime, WorkflowMeta } from '@openslack/workflows'

export const meta: WorkflowMeta = {
  name: 'full-lifecycle',
  version: '1.0.0',
  description: 'Complete issue-to-PR lifecycle',
  whenToUse: 'Run when you want a full automated sweep',
  phases: [
    { title: 'Scan', detail: 'Multi-agent codebase scan' },
    { title: 'Verify', detail: 'Adversarial verification' },
    { title: 'Triage', detail: 'Prioritize findings' },
    { title: 'Create Issues', detail: 'File GitHub issues' },
    { title: 'Implement', detail: 'Code fix' },
    { title: 'Validate', detail: 'Run test suite' },
    { title: 'Submit PR', detail: 'Create pull request' },
  ],
  inputs: {
    scope:     { type: 'string', default: 'all', description: 'Module filter' },
    maxPerDim: { type: 'number', default: 3, description: 'Max findings per dimension' },
    maxIssues: { type: 'number', default: 3, description: 'Max issues to create' },
    autoImpl:  { type: 'boolean', default: true, description: 'Auto-implement top issue' },
  },
  permissions: {
    github: ['issues:create', 'issues:read', 'prs:create', 'prs:read'],
    git: ['branch:create', 'push'],
    filesystem: ['workspace:write'],
    openslack: ['task:create', 'prms:doctor', 'collaboration:event'],
  },
  sideEffects: [
    'github.issue.create',
    'git.branch.create',
    'git.push',
    'github.pr.create',
  ],
  forbidden: [
    'github.pr.approve',
    'ruleset.bypass',
    'secrets.read',
    'github.pr.merge',
  ],
  risk: 'high',
}

export async function preview(
  ctx: WorkflowRuntime,
  args: Record<string, unknown>,
): Promise<PreviewResult> {
  // Scan, Verify, Triage only — no side effects
  const scope = (args.scope as string) || 'all'
  // ... scan and verify ...
  return { findings, triaged, preview: true }
}

export async function run(
  ctx: WorkflowRuntime,
  args: Record<string, unknown>,
): Promise<RunResult> {
  // Full execution with all side effects gated by permissions
  // ... all 7 phases ...
  return { status: 'complete', ... }
}
```

### 5.3 Dual Format Support

The workflow loader detects format automatically:

| Signal | Format | Loader |
|--------|--------|--------|
| `export async function preview` or `export async function run` | OpenSlack-native | Direct import |
| `export const meta` + top-level body with ambient globals | Anthropic-compatible | `anthropicCompatRunner()` wrapper |
| Neither | Invalid | Reject with error |

## 6. DSL Design — Runtime Primitives

### 6.1 `ctx.phase(name: string): void`

Marks current execution phase. Validates against `meta.phases` array. Emits
progress event to TUI and run store. Automatically checkpoints state.

```typescript
ctx.phase('Verify')  // Must match a phase title in meta.phases
```

### 6.2 `ctx.log(message: string): void`

Writes structured log entry with timestamp, phase, and run ID. Entries are
persisted to the run store and visible in `openslack workflow inspect <runId>`.

```typescript
ctx.log(`Verified ${count} findings`)
```

### 6.3 `ctx.agent<T>(prompt: string, options): Promise<T>`

Launches a subtask agent with schema-constrained output. Returns validated data.

```typescript
const findings = await ctx.agent<FindingsResult>(prompt, {
  label: 'scan:security',
  phase: 'Scan',
  schema: FINDING_SCHEMA,
  isolation: 'worktree',     // Optional: sandbox in git worktree
  budget: { tokens: 100_000 }, // Optional: cap agent spend
})
```

**Key difference from raw agent calls:** All side effects are routed through
OpenSlack APIs. The agent cannot call raw `gh` or `git` commands directly.

### 6.4 `ctx.parallel<T>(tasks: Array<() => Promise<T>>): Promise<T[]>`

Executes tasks concurrently with optional concurrency limit. Tracks budget
across all parallel tasks. Each task gets its own log prefix.

```typescript
const results = await ctx.parallel(
  DIMENSIONS.map(d => () => ctx.agent(d.prompt, { schema: FINDING_SCHEMA })),
  { concurrency: 3 },  // Optional: limit parallelism
)
```

### 6.5 `ctx.pipeline<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]>`

Processes items sequentially with automatic progress tracking and checkpointing
after each item. If the workflow is interrupted, `resume()` replays cached
results for completed items and re-runs only the unfinished ones.

```typescript
const verified = await ctx.pipeline(
  findings,
  async (finding, idx) => {
    ctx.log(`Verifying ${idx + 1}/${findings.length}: ${finding.title}`)
    return verifyFinding(ctx, finding)
  },
)
```

### 6.6 `ctx.budget`: Budget Tracking

Read-only object tracking cumulative token usage, cost, and remaining budget.

```typescript
interface BudgetState {
  tokensUsed: number
  tokensRemaining: number
  costUsd: number
  agentCalls: number
}
```

Workflows can check budget before expensive operations:

```typescript
if (ctx.budget.tokensRemaining < 50_000) {
  ctx.log('Budget low, skipping optional analysis')
  return
}
```

### 6.7 `ctx.workflow(name: string, args?): Promise<unknown>`

Nests one workflow inside another. The nested workflow inherits the parent's
execution mode (preview/dry-run/execute) and permissions are intersected.

```typescript
const scanResult = await ctx.workflow('codebase-scan', { scope: 'packages/runtime' })
```

### 6.8 OpenSlack API Namespace

```typescript
ctx.openslack = {
  task: {
    createPreview(issueData),     // Preview issue creation
    createIssue(issueData),       // Create real GitHub issue
    checkout(issueNumber, agentId), // Claim task and create worktree
    sync(issueNumber),            // Push changes and sync status
  },
  prms: {
    classify(paths),              // Run path risk classification
    doctor(prNumber),             // Run PRMS pre-merge checks
    queue(),                      // List PRs awaiting review
  },
  collaboration: {
    recordEvent(event),           // Record collaboration event
    createHandoff(details),       // Create agent-to-agent handoff
    recordDecision(details),      // Record human/agent decision
  },
  governance: {
    audit(action),                // Record governance-relevant action
  },
}
```

## 7. Execution Modes

### 7.1 Validate

Parse the workflow file, validate metadata, check schemas, verify permissions
are declared. No agent calls, no API calls, no file reads beyond the workflow
file itself.

```
openslack workflow validate full-lifecycle
```

### 7.2 Preview

Run all phases up to the first side-effect boundary. Agent calls execute in
read-only mode (can read files and search, cannot write or call GitHub API).
Schema validation is active. Output is the same as a real run minus the side
effects.

```
openslack workflow preview full-lifecycle --input scope=packages/runtime
```

### 7.3 Dry-Run

Simulate all side effects without executing them. GitHub issue creation logs the
issue body without calling `gh issue create`. Git operations log the commands
without executing them. Useful for verifying the workflow plan before committing
to real changes.

```
openslack workflow dry-run full-lifecycle --input scope=all
```

### 7.4 Execute

Run the workflow with real side effects. Requires `--confirm` flag or TUI
confirmation. Each side-effect phase prompts for explicit approval unless the
workflow was launched with `--yes`.

```
openslack workflow run full-lifecycle --input scope=all --confirm
```

### Mode Escalation

A workflow running in preview mode cannot escalate to dry-run or execute. Each
mode is a separate invocation. This prevents a preview run from accidentally
causing side effects.

## 8. Trust and Permission Model

### 8.1 Workflow Trust Levels

| Level | Meaning | Allowed Operations |
|-------|---------|-------------------|
| untrusted | Downloaded/external workflow | Read-only agent calls, no filesystem access |
| trusted | Authored by project contributor | All declared permissions, gated side effects |
| core | Ships with OpenSlack | Full access to all OpenSlack APIs |

### 8.2 Permission Declarations

Every workflow must declare required permissions in `meta.permissions`:

```typescript
permissions: {
  github: ['issues:create', 'issues:read', 'prs:create'],
  git: ['branch:create', 'push'],
  filesystem: ['workspace:write'],
  openslack: ['task:create', 'prms:doctor', 'collaboration:event'],
}
```

The runtime checks each permission before the corresponding operation. If a
permission is not declared, the operation fails with a clear error message.

### 8.3 Forbidden Actions

These actions are **always forbidden** regardless of permission declarations:

| Action | Why |
|--------|-----|
| `github.pr.approve` | Agents must never approve PRs |
| `github.pr.merge` | Merging requires PRMS doctor == READY_TO_MERGE |
| `ruleset.bypass` | Branch protection cannot be bypassed |
| `secrets.read` | No workflow may read credential files |
| `kernel.constitution.write` | Self-evolution governance rules |

### 8.4 Permission Resolution

When a workflow calls `ctx.workflow(name, args)` to nest another workflow:

- Permissions are intersected (parent AND child)
- Forbidden actions remain forbidden
- Trust level is the lower of parent and child

## 9. Sandboxing

### 9.1 Worktree Isolation

When `isolation: 'worktree'` is specified in an agent call, the runtime:

1. Calls `createWorktree(taskId, agentId, runId)` to create an isolated worktree
2. Sets the agent's working directory to the worktree path
3. After the agent completes, runs `checkDirty(worktreePath)` to assess changes
4. Optionally runs `cleanupWorktree(runId)` if the results are committed

### 9.2 Filesystem Sandboxing

Agent subtasks can only write to:

- The worktree directory (if isolated)
- `.openslack.local/workflows/runs/<runId>/` (run store)
- Temporary directories created by the runtime

All other writes are blocked by the runtime.

### 9.3 Network Sandboxing

In preview mode, all network requests are blocked except read-only GitHub API
calls. In execute mode, the runtime proxies all GitHub API calls through
OpenSlack's GitHub adapter, which enforces bot identity and rate limits.

## 10. Resume and Cache

### 10.1 Run Store

Each workflow run creates a directory at
`.openslack.local/workflows/runs/<runId>/` containing:

```
runs/<runId>/
  meta.json          # Run metadata (workflow name, args, mode, timestamps)
  manifest.json      # Workflow manifest hash at time of run
  status.json        # Current status (running/paused/completed/failed)
  phases/
    Scan.json        # Phase result with cache key
    Verify.json      # Phase result with cache key
    ...
  agents/
    scan:security.json   # Individual agent call results
    verify:1.json
    ...
  log.jsonl          # Structured log entries
  output.json        # Final workflow output
```

### 10.2 Cache Key

Cache is keyed by: `workflowHash + phase + label + promptHash + optsHash`

If the same workflow runs with the same inputs and the source files haven't
changed, cached results are reused without re-running agent calls.

### 10.3 Resume Flow

```
openslack workflow resume <runId>
```

1. Load `status.json` to find the last completed phase
2. Load cached results for all completed phases
3. Resume execution from the next phase
4. For `pipeline()` items, skip completed items and resume from the last
   checkpointed item

### 10.4 Cache Invalidation

Cache entries are invalidated when:

- The workflow source file changes (hash mismatch)
- The scanned source files change (for scan-phase cache)
- The user explicitly clears cache with `openslack workflow cache clear`

## 11. HTML Artifacts

### 11.1 Structure

HTML output is a self-contained file with:

- CSP meta tag: `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`
- Inline CSS (no external CDN)
- Inline JS (no external CDN, no network requests)
- All data embedded in the HTML (no fetch/XHR)

### 11.2 Content

| Section | Content |
|---------|---------|
| Summary | Workflow name, run ID, status, timestamps, counts |
| Phases | Expandable sections per phase with findings/results |
| Findings | Table with title, severity, category, module, file, status (confirmed/refuted) |
| Triage | Prioritized issue list with P0-P3, risk zone, labels |
| Issues | Created issue URLs and bodies |
| Validation | Test/typecheck/lint results |
| PR | PR URL and metadata |
| Permissions | Declared vs. granted permissions |
| Audit Log | Full structured log with timestamps |

### 11.3 Generation

```bash
openslack workflow inspect <runId> --format html > report.html
```

## 12. Module Integration

### 12.1 Operator Integration

Workflows are launched through the Operator module. The Operator:

- Resolves the workflow name to a file path
- Validates the manifest and permissions
- Creates the run store directory
- Injects the `WorkflowRuntime` context
- Captures the workflow result

CLI commands under `openslack workflow` are Operator commands.

### 12.2 Collaboration Layer Integration

Workflows emit collaboration events at each phase transition:

```typescript
ctx.openslack.collaboration.recordEvent({
  type: 'workflow.phase.complete',
  workflow: meta.name,
  phase: 'Scan',
  runId,
  summary: { findings: 15, verified: 8 },
})
```

Human operators can create handoffs and decisions during workflow execution:

```typescript
const decision = await ctx.openslack.collaboration.createHandoff({
  type: 'decision',
  question: 'Proceed with P0 fix implementation?',
  options: ['yes', 'no', 'skip-to-triage'],
})
```

### 12.3 PRMS Integration

Workflows that create PRs must pass through PRMS gates:

1. `ctx.openslack.prms.classify(paths)` — Classify changed files by risk zone
2. PR creation routed through `ctx.openslack.task.sync()` which enforces bot identity
3. `ctx.openslack.prms.doctor(prNumber)` — Run pre-merge health checks
4. PRMS doctor must return `READY_TO_MERGE` before any merge consideration

No workflow can bypass PRMS. The `forbidden` list explicitly blocks
`github.pr.approve` and `github.pr.merge`.

### 12.4 TUI Integration

| TUI View | Workflow Integration |
|----------|---------------------|
| Dashboard | "Workflows" tab with active/completed runs, phase progress bars |
| Doctor | Workflow health checks (orphaned runs, stale cache, permission mismatches) |
| Setup | Configure workflow permissions and trust levels |

### 12.5 Chat Gateway Integration

Workflows can be triggered and monitored via chat commands:

```
openslack workflow preview full-lifecycle --input scope=packages/runtime
openslack workflow status <runId>
openslack workflow resume <runId>
```

Results are posted as structured messages with links to HTML artifacts.

## 13. Complete User Workflows

### 13.1 First-Time User: Run a Predefined Workflow

```
# See what's available
$ openslack workflow list
  full-lifecycle   Complete issue-to-PR lifecycle
  codebase-scan    Scan for bugs, dead code, security issues
  pr-steward       Review and manage open PRs

# Preview before committing
$ openslack workflow preview full-lifecycle --input scope=packages/runtime
  Phase Scan: 5 dimensions, 15 raw findings
  Phase Verify: 8/15 confirmed (7 refuted by 2+ verifiers)
  Phase Triage: 3 P1 issues, 2 P2 issues, 3 P3 issues
  No side effects (preview mode).

# Dry-run to see what would happen
$ openslack workflow dry-run full-lifecycle --input scope=packages/runtime
  Would create 3 GitHub issues:
    [P1] [runtime] Unhandled null in task lifecycle
    [P1] [runtime] Race condition in concurrent claim
    [P2] [runtime] Missing pagination in issue sync
  Would implement fix for top issue: unhandled-null-task-lifecycle
  Would create PR targeting main

# Execute for real
$ openslack workflow run full-lifecycle --input scope=packages/runtime --confirm
  Creating issue #42: [P1] [runtime] Unhandled null in task lifecycle ... done
  Creating issue #43: [P1] [runtime] Race condition in concurrent claim ... done
  Creating issue #44: [P2] [runtime] Missing pagination in issue sync ... done
  Implementing fix for #42 ... done
  Validation: typecheck PASS, lint PASS, test PASS (818/818)
  PR #45 created: https://github.com/org/repo/pull/45
```

### 13.2 Operator: Resume Interrupted Workflow

```
$ openslack workflow list --runs
  run-abc123  full-lifecycle  paused  Phase 4/7 (Create Issues)  2h ago
  run-def456  codebase-scan   failed  Phase 2/2 (Verify)         1d ago

$ openslack workflow resume run-abc123
  Resuming from phase "Create Issues" (3/3 issues remaining)
  Creating issue #46 ... done
  Creating issue #47 ... done
  Creating issue #48 ... done
  Implementing fix for #46 ... done
  PR #49 created
```

### 13.3 Developer: Write a New Workflow

```
# Create workflow scaffold
$ openslack workflow init my-custom-scan
  Created .openslack/workflows/my-custom-scan.ts

# Edit the workflow
$ vim .openslack/workflows/my-custom-scan.ts

# Validate syntax and permissions
$ openslack workflow validate my-custom-scan
  OK: meta declared, 2 phases, 3 permissions, 0 forbidden overrides

# Preview to test
$ openslack workflow preview my-custom-scan
```

### 13.4 Security Reviewer: Audit a Workflow

```
# Inspect manifest and permissions
$ openslack workflow show full-lifecycle
  Name: full-lifecycle
  Risk: high
  Permissions: github (issues:create, prs:create), git (branch:create, push), filesystem (workspace:write)
  Forbidden: pr.approve, ruleset.bypass, secrets.read, pr.merge
  Side Effects: github.issue.create, git.branch.create, git.push, github.pr.create

# Inspect a past run
$ openslack workflow inspect run-abc123
  Status: completed
  Phases: Scan (15 findings) → Verify (8 confirmed) → Triage (8 triaged)
          → Create Issues (3 created) → Implement (done) → Validate (pass)
          → Submit PR (#45)
  Token usage: 847,231 tokens ($4.23)
  Agent calls: 28
  Duration: 12m 34s

# Export HTML report
$ openslack workflow inspect run-abc123 --format html > audit-report.html
```

## 14. Implementation Plan

### Phase 1: Package Scaffold (`@openslack/workflows`)

**PR 1:** Package skeleton with types

- `packages/workflows/` directory with `package.json`, `tsconfig.json`, `vitest.config.ts`
- Type definitions: `WorkflowMeta`, `WorkflowRuntime`, `WorkflowResult`, `PreviewResult`
- Schema validation utilities
- Manifest parser (`parseManifest`)
- Format detection (OpenSlack-native vs. Anthropic-compatible)
- Hash computation for cache keys
- Unit tests for type definitions and parser

**PR 2:** Runtime primitives

- `WorkflowRuntime` implementation: `phase()`, `log()`, `agent()`, `parallel()`, `pipeline()`
- Budget tracking
- Permission checker
- Anthropic compatibility shim (`anthropicCompatRunner`)
- Unit tests with mocked agent calls

**PR 3:** Run store and cache

- Run directory structure (`.openslack.local/workflows/runs/<runId>/`)
- Checkpoint serialization/deserialization
- Cache key computation and lookup
- Resume logic with cached result replay
- `openslack workflow cache clear` command
- Unit tests for cache invalidation and resume

### Phase 2: Preview and Validation

**PR 4:** Preview mode

- `preview()` function implementation
- Read-only agent calls (filesystem sandbox, no writes)
- Schema validation for agent output
- Risk zone validation against `classifyPaths()`
- Output formatting (terminal, JSON)
- Integration tests using a test workflow

**PR 5:** Validate and show commands

- `openslack workflow validate` — Parse and validate manifest
- `openslack workflow show` — Display permissions, phases, risk
- `openslack workflow list` — List available workflows
- `openslack workflow list --runs` — List past and active runs

### Phase 3: Execution and Side Effects

**PR 6:** Dry-run and execute modes

- Dry-run: simulate side effects, log what would happen
- Execute: real side effects with confirmation prompts
- Permission gating before each operation
- Integration with `ctx.openslack.task`, `ctx.openslack.prms`
- Integration tests with temporary git repository

**PR 7:** Permission and trust model

- Trust level resolution (untrusted/trusted/core)
- Permission intersection for nested workflows
- Forbidden action enforcement (hardcoded blocklist)
- `openslack workflow trust <name> --level trusted` command
- Security-focused tests

### Phase 4: Integration and Output

**PR 8:** TUI and collaboration integration

- Dashboard "Workflows" tab with phase progress bars
- Doctor workflow health checks
- Collaboration event recording at phase transitions
- Handoff/decision support during workflow execution
- Chat gateway command support

**PR 9:** HTML artifacts and module registration

- Self-contained HTML output generation
- CSP headers, inline CSS/JS, embedded data
- `openslack workflow inspect <runId> --format html`
- Register `@openslack/workflows` in `.openslack/modules.yaml`
- Update `docs/status/current.md` and `docs/user-guide.md`

## 15. Rules to Avoid

Based on gaps identified in the reference workflow (see
[workflow-format-analysis.md](workflow-format-analysis.md)):

| Rule | Why |
|------|-----|
| Never trust LLM-assigned `risk_zone` | Must validate with `classifyPaths()`, not the agent's classification |
| Never hardcode test counts | Read from `docs/status/current.md` or validate by exit code only |
| Never use raw `gh` or `git` commands in agent calls | Route through `ctx.openslack.task.*` and `ctx.openslack.prms.*` |
| Never use ambient globals | Use explicit `ctx: WorkflowRuntime` parameter |
| Never bypass PRMS for PR creation | All PRs must pass through `prms.doctor()` |
| Never allow `pr.approve` or `pr.merge` in workflows | Hardcoded forbidden, regardless of permission declarations |
| Never use `Co-Authored-By` in workflow commits | Bot identity enforced by `ctx.openslack.task.sync()` |
| Never create issues without preview | Preview mode must show the issue body before creation |
| Never use `--no-verify` or `--force` in git operations | All git operations must follow normal hooks |
| Never read secrets or credential files | Hardcoded forbidden, even in execute mode |

## 16. Related Documentation

| Document | Purpose |
|----------|---------|
| [workflow-format-analysis.md](workflow-format-analysis.md) | Analysis of Anthropic workflow format and integration gaps |
| [user-experience-roadmap.md](user-experience-roadmap.md) | UX roadmap including workflow TUI integration |
| [module-04-pr-review-merge-steward.md](module-04-pr-review-merge-steward.md) | PRMS gates that workflows must pass through |
| [collaboration-layer.md](collaboration-layer.md) | Collaboration events and handoff integration |
| `docs/developer/workflow-runtime.md` | Technical runtime design (separate document) |
| `docs/security/workflow-execution.md` | Security model and sandboxing (separate document) |
| `.claude/workflows/full-lifecycle.js` | Reference Anthropic-style workflow |
