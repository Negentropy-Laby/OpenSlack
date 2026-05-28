---
schema: openslack.product_spec.v1
status: analysis
created: 2026-05-28
source: analyzed external sample (Anthropic full-lifecycle.js workflow)
---

# Anthropic Workflow Format Analysis

## Purpose

This document analyzes `.claude/workflows/full-lifecycle.js` — an external Anthropic-style
agent workflow file — and evaluates how OpenSlack should absorb its patterns.

## File Format

The file is a JavaScript/ESM module that combines metadata, JSON schemas,
configuration, structured prompts, runtime DSL calls, side-effect instructions,
and a return object. It is not a standard Node ESM: it uses `export const meta`,
top-level `await`, top-level `return`, and ambient globals (`args`, `phase`,
`log`, `parallel`, `pipeline`, `agent`) that have no import statements.

This means Anthropic's workflow runtime wraps the file body inside an async
function and injects runtime primitives. OpenSlack cannot simply
`await import()` and execute it directly.

## Structure Breakdown

### 1. Metadata (`export const meta`)

```javascript
export const meta = {
  name: 'full-lifecycle',
  description: 'Complete issue-to-PR lifecycle...',
  whenToUse: 'Run when you want...',
  phases: [ { title, detail }, ... ],
}
```

Serves as a discoverable workflow manifest. OpenSlack should extend this with
governance fields the file lacks:

```
risk, permissions, sideEffects, requiredApprovals,
sourceOfTruthObjects, forbiddenActions, outputs
```

### 2. Inline JSON Schemas

Three schemas constrain agent output:

| Schema | Phase | Constrains |
|--------|-------|------------|
| `FINDING_SCHEMA` | Scan | `findings[]` with title/severity/category/module/file/description |
| `VERDICT_SCHEMA` | Verify | `refuted` boolean + `reason` string |
| `TRIAGE_SCHEMA` | Triage | `issues[]` with priority/risk_zone/labels |

This is a key design: agent output is structured data, not free text. OpenSlack
should require all workflow agent calls to declare schemas, and fail-closed on
validation errors.

### 3. Runtime Inputs (`args`)

```javascript
const scope     = args?.scope     || 'all'
const maxPerDim = args?.maxPerDim || 3
const maxIssues = args?.maxIssues || 3
const autoImpl  = args?.autoImpl !== false
```

Maps to OpenSlack workflow `--input` flags:

```
openslack collaboration workflow preview full-lifecycle \
  --input scope=packages/pr --input maxPerDim=2 --input autoImpl=false
```

### 4. Ambient Runtime Primitives

| Primitive | Purpose |
|-----------|---------|
| `phase(name)` | Mark execution stage for logging/UI/progress |
| `log(text)` | Write workflow log |
| `parallel(tasks)` | Execute multiple async tasks concurrently |
| `pipeline(items, fn)` | Process list items with bounded concurrency and per-item checkpoints |
| `agent(prompt, opts)` | Launch agent subtask with label/phase/schema |
| `args` | External input parameters |

OpenSlack should provide these as an explicit context object, not globals:

```typescript
export async function run(ctx: WorkflowRuntime, args: Record<string, unknown>) {
  ctx.phase(...)
  await ctx.parallel(...)
}
```

## Workflow Phases

### Phase 1: Scan (multi-agent parallel)

Five dimensions scanned concurrently: bug, dead-code, security, performance,
architecture. Each dimension is a specialist agent with its own prompt and
schema-constrained output.

```
parallel(DIMENSIONS.map(d => () => agent(d.prompt, { schema: FINDING_SCHEMA })))
```

Strengths: broad coverage, fast concurrency, uniform output structure.
Risks: false positives, duplicate findings, scope control.

### Phase 2: Verify (3-vote adversarial)

Each finding gets 3 adversarial verifiers. If 2+ refute, the finding is
dropped (pigeonhole early-exit).

```
3 verifiers → 2 refutes = drop
```

This is the workflow's most important design pattern. It significantly reduces
false positives before issue creation. OpenSlack should adopt this as a
standard workflow capability.

### Phase 3: Triage (structured prioritization)

A single triage agent assigns priority (P0-P3), risk zone (green/yellow/red),
labels, and deduplication. Output capped by `maxIssues`.

Critical gap: `risk_zone` is LLM-assigned, not computed by OpenSlack's
`classifyPaths()`. Must be validated against the real classifier, not trusted.

### Phase 4: Create Issues (GitHub side effects)

Generates issue bodies with embedded YAML task schema and executes
`gh issue create` directly via agent.

Critical gap: bypasses `openslack task create --preview/--create-issue`,
label repair, schema validation, and collaboration event recording.

### Phase 5: Implement (code changes)

Creates branch, reads files, implements fix, runs typecheck/lint/test,
commits, pushes — all via free-form agent prompt.

Critical gap: bypasses `openslack task checkout`, `task sync`, worktree
isolation, PRMS preflight, and bot identity enforcement. The prompt mentions
bot identity but relies on the agent following instructions rather than
enforcement.

### Phase 6: Validate

Runs typecheck, lint, tests, status verify, doctor.

Critical gap: hardcodes "808 tests expected" which will drift. Should validate
by exit code or read current expected count from status docs.

### Phase 7: Submit PR

Creates PR via `gh pr create` with project template. Correctly states
"Do NOT approve or merge the PR."

Critical gap: issue-to-PR linking uses `gh issue list --label` search which
may match wrong issues. Should use structured issue numbers from Phase 4.

## Key Gaps for OpenSlack Integration

### 1. No Permission Model

The file has no permission declarations. OpenSlack must require:

```
permissions:
  github: [issues:create, prs:create]
  git: [branch:create, push]
  filesystem: [workspace:write]
  openslack: [task:create, prms:doctor, collaboration:event]
  forbidden: [pr:approve, ruleset:bypass, secrets:read]
```

### 2. No Preview/Dry-Run Separation

`autoImpl=false` still creates GitHub issues. OpenSlack needs three modes:

- **preview**: show findings/triage/plan, no side effects
- **dry-run**: simulate issue/branch/PR creation
- **execute**: real side effects with confirmation

### 3. Direct GitHub/Git Commands Bypass OpenSlack Gates

Phases 4-7 use raw `gh`/`git` commands. OpenSlack should replace these with
its own APIs:

```
ctx.openslack.task.createIssue(...)
ctx.openslack.task.checkout(issueNumber, agentId)
ctx.openslack.task.sync(...)
ctx.openslack.prms.classify(paths)
ctx.openslack.prms.doctor(prNumber)
```

### 4. Risk Zone Not Verified

LLM-assigned risk_zone must be validated by `classifyPaths()`, not trusted.

### 5. Test Count Hardcoded

Should read from `docs/status/current.md` or validate by exit code only.

## Recommended Integration Path

### Phase A: Preview-only (safe, no side effects)

Enable Scan → Verify → Triage only. Output candidate issues with risk
suggestions and recommended next actions. No GitHub issue creation.

```
openslack collaboration workflow preview full-lifecycle --input scope=all
```

### Phase B: Issue creation via OpenSlack task API

Replace raw `gh issue create` with `ctx.openslack.task.createIssue(...)`.
Requires `--mode execute --yes`.

### Phase C: Implementation via OpenSlack task loop

Replace free-form git commands with:

```
ctx.openslack.task.checkout(issue, agentId)
ctx.agent(... { isolation: 'worktree' })
ctx.openslack.task.sync(...)
```

### Phase D: PR submission via PRMS-compatible API

Use OpenSlack task sync / PR creation path, then immediately run
`ctx.openslack.prms.doctor(prNumber)`.

## OpenSlack Workflow Runtime Design

### Dual Format Support

**OpenSlack-native (preferred):**

```javascript
export const meta = { ... }

export async function preview(ctx, args) { ... }
export async function run(ctx, args) { ... }
```

**Anthropic-compatible (migration layer):**

```javascript
export const meta = { ... }
// top-level body using args, phase, log, agent, parallel, pipeline
```

OpenSlack provides an `anthropicCompatRunner` wrapper that injects ambient
globals and wraps the body in an async function.

### Runtime API

```typescript
interface WorkflowRuntime {
  args: Record<string, unknown>
  phase(name: string): void
  log(message: string): void
  parallel<T>(tasks: Array<() => Promise<T>>): Promise<T[]>
  pipeline<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]>
  agent<T>(prompt: string, options: {
    label: string; phase: string; schema?: JsonSchema; isolation?: 'none' | 'worktree'
  }): Promise<T>
  openslack: {
    task: { createPreview(...), createIssue(...), checkout(...), sync(...) }
    prms: { classify(paths), doctor(prNumber), queue() }
    collaboration: { recordEvent(...), createHandoff(...), recordDecision(...) }
    governance: { audit(...) }
  }
}
```

### Enhanced Manifest

```javascript
export const meta = {
  name, description, whenToUse, phases,
  inputs: { ... },
  permissions: { ... },
  sideEffects: ['github.issue.create', 'git.branch.create', 'git.push', 'github.pr.create'],
  forbidden: ['github.pr.approve', 'ruleset.bypass', 'secrets.read'],
  risk: 'high',
}
```

## Implementation Plan

| PR | Scope | Key Deliverable |
|----|-------|-----------------|
| 1 | Format analysis docs | `docs/product/workflow-format-analysis.md`, runtime design, security model |
| 2 | `@openslack/workflows` loader | Meta parser, type definitions, validator, hash computation |
| 3 | Runtime primitives | `phase`, `log`, `parallel`, `pipeline`, `agent` shim, mock/dry-run support |
| 4 | Preview mode for full-lifecycle | Example workflow running Scan/Verify/Triage only |
| 5 | Permission and trust model | Workflow trust/untrust, permission checks, side-effect gating |
| 6 | OpenSlack-native rewrite | `preview(ctx, args)` + `run(ctx, args)` with OpenSlack API calls |
| 7 | Multi-format output | `--format html`, `--format tui`, `--format markdown` |

## Summary

This Anthropic workflow is a prototype for **executable agent workflow modules**:
JS files that encapsulate metadata, schemas, agent subtasks, parallel/pipeline
processing, and real side effects. OpenSlack can absorb its patterns, but must
add its own trust model, permission enforcement, preview/dry-run/execute modes,
PRMS gates, collaboration events, and OpenSlack API integration before safe
production use.

**One-line:** Absorb the DSL patterns, reject the ambient globals, gate the
side effects, validate the outputs, route through existing OpenSlack APIs.

## Follow-up Design

This analysis informed the full product design documented in:

- [workflow-modules.md](workflow-modules.md) — Complete workflow system product design (16 sections)
- `docs/developer/workflow-runtime.md` — Technical runtime design for `@openslack/workflows`
- `docs/security/workflow-execution.md` — Workflow security model and sandboxing
