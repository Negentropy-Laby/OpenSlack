---
schema: openslack.developer_spec.v1
status: implemented
created: 2026-05-28
parent_spec: docs/product/workflow-modules.md
---

# Workflow Runtime — Technical Design

## Overview

This document specifies the internal architecture of the `@openslack/workflows`
package: the runtime engine that loads, validates, executes, checkpoints, and
resumes OpenSlack workflow modules.

## Package Structure

```
packages/workflows/
  src/
    index.ts                  # Public API exports
    types.ts                  # TypeScript interfaces and type aliases
    loader.ts                 # Workflow file loading and format detection
    manifest.ts               # Manifest parsing, validation, hashing
    runtime.ts                # WorkflowRuntime implementation
    agent-shim.ts             # Agent subtask wrapper with schema validation
    parallel-runner.ts        # Concurrent execution with budget tracking
    pipeline-runner.ts        # Bounded-concurrency item pipeline with per-item checkpoints
    cache.ts                  # Cache key computation and lookup
    run-store.ts              # Run directory management and persistence
    resume.ts                 # Resume logic with cached result replay
    anthropic-compat.ts       # Compatibility shim for Anthropic-format workflows
    permission-checker.ts     # Permission validation and gating
    html-renderer.ts          # Self-contained HTML artifact generation
    __tests__/
      loader.test.ts
      manifest.test.ts
      runtime.test.ts
      cache.test.ts
      run-store.test.ts
      resume.test.ts
      permission-checker.test.ts
      anthropic-compat.test.ts
```

## Type Definitions (`types.ts`)

```typescript
import type { JSONSchema7 } from 'json-schema';

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface WorkflowPhase {
  title: string;
  detail: string;
}

export interface WorkflowInput {
  type: 'string' | 'number' | 'boolean';
  default?: unknown;
  description: string;
}

export interface WorkflowPermissions {
  github?: string[];
  git?: string[];
  filesystem?: string[];
  openslack?: string[];
}

export interface WorkflowMeta {
  name: string;
  version?: string;
  description: string;
  whenToUse?: string;
  phases: WorkflowPhase[];
  inputs?: Record<string, WorkflowInput>;
  permissions?: WorkflowPermissions;
  sideEffects?: string[];
  forbidden?: string[];
  risk?: 'low' | 'medium' | 'high';
}

// ── Runtime ───────────────────────────────────────────────────────────────────

export interface BudgetState {
  tokensUsed: number;
  tokensRemaining: number | null; // null = unlimited
  costUsd: number;
  agentCalls: number;
}

export interface AgentOptions {
  label: string;
  phase: string;
  schema?: JSONSchema7;
  isolation?: 'none' | 'worktree';
  budget?: { tokens: number };
}

export interface ParallelOptions {
  concurrency?: number;
}

export interface PhaseCheckpoint {
  phase: string;
  timestamp: string;
  status: 'completed' | 'failed' | 'skipped';
  result?: unknown;
  cacheKey?: string;
}

export interface RunStatus {
  runId: string;
  workflowName: string;
  mode: ExecutionMode;
  status: 'running' | 'paused' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  currentPhase?: string;
  phases: PhaseCheckpoint[];
  args: Record<string, unknown>;
}

export type ExecutionMode = 'validate' | 'preview' | 'dry-run' | 'execute';

// ── PRMS ──────────────────────────────────────────────────────────────────────

export interface PrmsDoctorBlocker {
  gate: string;
  reason: string;
  zone?: 'green' | 'yellow' | 'red';
  owner?: string;
}

export interface PrmsDoctorResult {
  status: 'READY_TO_MERGE' | 'BLOCKED' | 'ERROR';
  blockers: PrmsDoctorBlocker[];
  zone: 'green' | 'yellow' | 'red';
  why: string;
  next: string;
  gates: Record<string, { passed: boolean; detail: string }>;
}

export interface WorkflowRuntime {
  readonly runId: string;
  readonly mode: ExecutionMode;
  readonly budget: BudgetState;
  readonly args: Record<string, unknown>;

  phase(name: string): void;
  log(message: string): void;
  agent<T>(prompt: string, options: AgentOptions): Promise<T>;
  parallel<T>(tasks: Array<() => Promise<T>>, options?: ParallelOptions): Promise<T[]>;
  pipeline<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
  workflow(name: string, args?: Record<string, unknown>): Promise<unknown>;

  openslack: {
    task: {
      createPreview(issueData: unknown): Promise<unknown>;
      createIssue(issueData: unknown): Promise<{ issueUrl: string; issueNumber: number }>;
      checkout(
        issueNumber: number,
        agentId: string,
      ): Promise<{ worktreePath: string; branchName: string }>;
      sync(issueNumber: number): Promise<{ pushed: boolean; prUrl?: string }>;
    };
    prms: {
      classify(paths: string[]): Promise<{ green: string[]; yellow: string[]; red: string[] }>;
      doctor(prNumber: number): Promise<PrmsDoctorResult>;
      queue(): Promise<Array<{ prNumber: number; title: string; status: string }>>;
      requestMerge(prNumber: number): Promise<{ merged: boolean; prmsStatus: string }>;
    };
    collaboration: {
      recordEvent(event: unknown): Promise<void>;
      createHandoff(details: unknown): Promise<unknown>;
      recordDecision(details: unknown): Promise<unknown>;
    };
    governance: {
      audit(action: string, details?: unknown): Promise<void>;
    };
  };
}

// ── Results ───────────────────────────────────────────────────────────────────

export interface PreviewResult {
  preview: true;
  findings?: unknown[];
  triaged?: unknown[];
  [key: string]: unknown;
}

export interface RunResult {
  status: string;
  [key: string]: unknown;
}

// ── Workflow Module ───────────────────────────────────────────────────────────

export interface OpenSlackWorkflow {
  meta: WorkflowMeta;
  preview?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<PreviewResult>;
  run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>;
}
```

## Loader (`loader.ts`)

The loader discovers workflow files and detects their format.

### Discovery Paths

1. `.openslack/workflows/*.ts` — project-local workflows
2. `.openslack/workflows/*.js` — project-local workflows (JS)
3. `.claude/workflows/*.js` — Anthropic-compatible workflows (legacy path)
4. `packages/workflows/src/builtins/` — core workflows shipped with OpenSlack

### Format Detection

```typescript
type WorkflowFormat = 'openslack-native' | 'anthropic-compatible' | 'invalid';

function detectFormat(module: Record<string, unknown>): WorkflowFormat {
  const hasMeta = typeof module.meta === 'object' && module.meta !== null;
  const hasPreview = typeof module.preview === 'function';
  const hasRun = typeof module.run === 'function';

  if (hasMeta && (hasPreview || hasRun)) return 'openslack-native';
  if (hasMeta) return 'anthropic-compatible';
  return 'invalid';
}
```

### Loading Flow

```
1. Resolve workflow name to file path
2. Compute file hash (SHA-256 of file contents)
3. Static analysis pass (no execution):
   a. Parse the file as source text (AST or regex extraction)
   b. Extract the `export const meta = { ... }` literal
   c. Verify meta is a pure object literal: no function calls, no computed
      property names, no references to external variables, only JSON-serializable
      values. Applies to both Anthropic-compatible and OpenSlack-native formats.
   d. Parse and validate the extracted manifest against schema rules
4. If static analysis fails (meta is not a pure literal, uses computed keys,
   references external scope, etc.): reject with clear error. Do NOT fall back
   to executing the module to extract meta.
5. Import module (only after static analysis passes)
6. Detect format (openslack-native vs anthropic-compatible)
7. If openslack-native: use directly
8. If anthropic-compatible: wrap with anthropicCompatRunner()
9. Return WorkflowModule with meta, preview, run, format, hash
```

The key invariant: **meta is extracted and validated before any module code
executes.** This prevents a malicious workflow body from running during the
meta extraction phase.

### Nesting Depth Limit

When `ctx.workflow()` is called to nest a child workflow, the runtime checks
nesting depth:

```typescript
const MAX_NESTING_DEPTH = 1;

function assertNestingDepth(currentDepth: number): void {
  if (currentDepth >= MAX_NESTING_DEPTH) {
    throw new Error(
      `Workflow nesting depth limit (${MAX_NESTING_DEPTH}) exceeded. ` +
        'Child workflows cannot call ctx.workflow() again.',
    );
  }
}
```

The nesting depth is tracked in the runtime context and inherited by child
workflows. A child workflow at depth 1 cannot call `ctx.workflow()` again.

## Manifest Parser (`manifest.ts`)

### Validation Rules

| Field         | Required                           | Validation                                              |
| ------------- | ---------------------------------- | ------------------------------------------------------- |
| `name`        | Yes                                | Non-empty string, matches `/^[a-z][a-z0-9-]*$/`         |
| `version`     | No                                 | Semver string if present                                |
| `description` | Yes                                | Non-empty string                                        |
| `phases`      | Yes                                | Array of `{ title, detail }`, at least 1 phase          |
| `permissions` | No (but required for execute mode) | Object with string array values                         |
| `sideEffects` | No                                 | Array of strings matching `*.scope.action` pattern      |
| `forbidden`   | No                                 | Array of strings, validated against hardcoded blocklist |
| `risk`        | No                                 | One of `low`, `medium`, `high`                          |

### Hash Computation

```typescript
function computeManifestHash(meta: WorkflowMeta): string {
  const canonical = JSON.stringify(meta, Object.keys(meta).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
```

Used for cache key generation and integrity checks during resume.

## Runtime Engine (`runtime.ts`)

### Constructor

```typescript
function createRuntime(options: {
  runId: string;
  mode: ExecutionMode;
  manifest: WorkflowMeta;
  runStore: RunStore;
  budget?: { tokens: number; costUsd: number };
  permissions?: WorkflowPermissions;
}): WorkflowRuntime;
```

### Phase Tracking

```typescript
phase(name: string): void {
  // 1. Validate name exists in manifest.phases
  const phaseDef = this.manifest.phases.find(p => p.title === name)
  if (!phaseDef) throw new Error(`Unknown phase: ${name}`)

  // 2. Check sequential ordering (phases must execute in declared order)
  const phaseIndex = this.manifest.phases.indexOf(phaseDef)
  if (phaseIndex < this.currentPhaseIndex) {
    throw new Error(`Phase "${name}" already completed`)
  }

  // 3. Update state
  this.currentPhase = name
  this.currentPhaseIndex = phaseIndex

  // 4. Emit progress event
  this.emit('phase', { phase: name, index: phaseIndex, total: this.manifest.phases.length })

  // 5. Checkpoint
  this.runStore.savePhaseStatus(this.runId, name, 'running')
}
```

### Agent Shim

```typescript
async agent<T>(prompt: string, options: AgentOptions): Promise<T> {
  // 1. Permission check
  this.permissionChecker.assertAllowed('agent', options)

  // 2. Budget check
  if (this.budget.tokensRemaining !== null && this.budget.tokensRemaining <= 0) {
    throw new Error('Budget exhausted')
  }

  // 3. Mode-specific behavior
  if (this.mode === 'validate') {
    throw new Error('Agent calls not allowed in validate mode')
  }

  // 4. Check cache
  const cacheKey = computeCacheKey(this.manifestHash, options.phase, options.label, prompt, options)
  const cached = await this.runStore.loadAgentResult(this.runId, cacheKey)
  if (cached) return cached as T

  // 5. Launch agent subtask
  const result = await this.launchAgentSubtask<T>(prompt, options)

  // 6. Schema validation
  if (options.schema) {
    const valid = validateSchema(result, options.schema)
    if (!valid) {
      // Record failure but don't throw — let caller decide
      this.log(`Schema validation failed for ${options.label}`)
      // For standalone calls, the error propagates
      // For fan-out items (parallel/pipeline), caller handles null
      throw new SchemaValidationError(options.label, violations)
    }
  }

  // 7. Cache result
  await this.runStore.saveAgentResult(this.runId, cacheKey, result)

  // 8. Update budget
  this.budget.tokensUsed += result.tokenUsage || 0
  this.budget.agentCalls += 1

  return result
}
```

### Parallel Runner

```typescript
async parallel<T>(
  tasks: Array<() => Promise<T>>,
  options?: ParallelOptions,
): Promise<T[]> {
  const concurrency = options?.concurrency || Infinity

  // Budget partition: divide remaining budget across tasks
  const perTaskBudget = this.budget.tokensRemaining !== null
    ? Math.floor(this.budget.tokensRemaining / tasks.length)
    : null

  // Execute with concurrency limit
  const results: T[] = []
  const executing: Promise<void>[] = []

  for (const [index, task] of tasks.entries()) {
    const promise = task().then(result => {
      results[index] = result
    })

    executing.push(promise)

    if (executing.length >= concurrency) {
      await Promise.race(executing)
      // Remove completed promises
      executing.splice(0, executing.length, ...executing.filter(p => p !== /* settled */))
    }
  }

  await Promise.all(executing)
  return results
}
```

### Pipeline Runner

```typescript
interface PipelineOptions {
  concurrency?: number  // default: 4; set to 1 for sequential MVP fallback
}

async pipeline<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options?: PipelineOptions,
): Promise<R[]> {
  const concurrency = options?.concurrency ?? 4
  const results: (R | null)[] = new Array(items.length)
  const inFlight: Promise<void>[] = []
  let nextIndex = 0

  // Phase 1: replay cached items
  for (let i = 0; i < items.length; i++) {
    const cachedKey = computeItemCacheKey(this.runId, this.currentPhase, i)
    const cached = await this.runStore.loadPipelineItem(this.runId, cachedKey)
    if (cached) {
      results[i] = cached as R
      nextIndex = i + 1
    } else {
      break  // cached items must be contiguous from start
    }
  }

  // Phase 2: execute remaining items with bounded concurrency
  const launchItem = (index: number): Promise<void> =>
    fn(items[index], index)
      .then(result => {
        results[index] = result
        const cachedKey = computeItemCacheKey(this.runId, this.currentPhase, index)
        return this.runStore.savePipelineItem(this.runId, cachedKey, result)
      })
      .catch(err => {
        // Schema failure or other error: record as null
        results[index] = null
        this.log(`Pipeline item ${index} failed: ${err.message}`)
      })

  while (nextIndex < items.length || inFlight.length > 0) {
    // Fill up to concurrency limit
    while (inFlight.length < concurrency && nextIndex < items.length) {
      inFlight.push(launchItem(nextIndex))
      nextIndex++
    }

    if (inFlight.length > 0) {
      await Promise.race(inFlight)
      // Remove settled promises
      for (let j = inFlight.length - 1; j >= 0; j--) {
        // Settled promises are safe to remove (result captured by .then)
      }
    }
  }

  return results as R[]
}
```

## Cache System (`cache.ts`)

### Cache Key Computation

```typescript
function computeCacheKey(
  manifestHash: string,
  phase: string,
  label: string,
  prompt: string,
  opts: AgentOptions,
): string {
  const parts = [manifestHash, phase, label, hashString(prompt), hashString(JSON.stringify(opts))];
  return parts.join(':');
}
```

### Cache Storage

Cache entries are stored as JSON files in the run directory:

```
runs/<runId>/agents/<cacheKey>.json
```

Each entry contains:

```typescript
interface CacheEntry {
  key: string;
  timestamp: string;
  result: unknown;
  tokenUsage?: number;
  schemaVersion: string; // For migration support
}
```

## Run Store (`run-store.ts`)

### Directory Structure

```
.openslack.local/workflows/
  runs/
    <runId>/
      meta.json            # Run metadata
      status.json          # Current status, phase index
      phases/
        <phaseName>.json   # Phase result and checkpoint
      agents/
        <cacheKey>.json    # Agent call result cache
      pipeline/
        <phaseName>/
          <index>.json     # Pipeline item checkpoint
      log.jsonl            # Structured log entries
      output.json          # Final workflow output (on completion)
```

### Status Transitions

```
running → paused    (interrupted, resumable)
running → completed (successful finish)
running → failed    (unrecoverable error)
paused  → running   (resumed)
```

### Log Format

Each log entry is a JSONL line:

```json
{
  "ts": "2026-05-28T12:34:56.789Z",
  "phase": "Scan",
  "message": "Raw findings: 15",
  "runId": "run-abc123"
}
```

## Resume Logic (`resume.ts`)

### Resume Flow

```
1. Load status.json from run directory
2. Verify status is "paused" (not "completed" or "failed")
3. Verify manifest hash matches (workflow source unchanged)
4. Load cached phase results up to current phase
5. Create new runtime with same runId
6. Inject cached results into runtime
7. Resume from next phase
8. For pipeline items: skip completed items via cache lookup
```

### Manifest Hash Mismatch

If the workflow source file has changed since the run was paused:

```
1. Warn the user: "Workflow source has changed since run was paused"
2. Offer options:
   a. Re-validate the new manifest
   b. Start a fresh run
   c. Force resume with old manifest (not recommended)
```

## Anthropic Compatibility Shim (`anthropic-compat.ts`)

### Ambient Global Injection

> **Security note:** The `new AsyncFunction()` approach shown below is a
> **design placeholder** illustrating the desired API surface. A production
> implementation must NOT use `AsyncFunction` or `eval` to execute arbitrary
> JS from workflow files. The real implementation must:
>
> 1. Complete static analysis of the file before any execution (see Loading Flow)
> 2. Run the workflow body inside a sandboxed execution context (e.g., a
>    dedicated worker thread with restricted globals, or a VM module with
>    a frozen sandbox object)
> 3. Never pass unsanitized file contents to code evaluation primitives
>
> The placeholder below shows only the API shape, not the execution mechanism.

```typescript
// PLACEHOLDER: API shape only. Real implementation uses sandboxed execution.
function anthropicCompatRunner(moduleBody: string, runtime: WorkflowRuntime): Promise<unknown> {
  // The sandbox object defines the ambient globals available to the workflow.
  // In production, this is passed to a sandboxed execution context, not to
  // new AsyncFunction().
  const sandbox = {
    args: runtime.args,
    phase: (name: string) => runtime.phase(name),
    log: (msg: string) => runtime.log(msg),
    parallel: <T>(tasks: Array<() => Promise<T>>) => runtime.parallel(tasks),
    pipeline: <T, R>(items: T[], fn: (item: T, idx: number) => Promise<R>) =>
      runtime.pipeline(items, fn),
    agent: <T>(prompt: string, opts: unknown) => runtime.agent<T>(prompt, opts as AgentOptions),
    budget: runtime.budget,
    workflow: (name: string, args?: Record<string, unknown>) => runtime.workflow(name, args),
  };

  // Production: execute in sandboxed context with restricted globals
  // Placeholder: wrap body in async function (NOT production-safe)
  throw new Error('anthropicCompatRunner: must use sandboxed execution, not AsyncFunction');
}
```

### Limitations

The compatibility shim does NOT provide:

- Permission enforcement (Anthropic format has no permission declarations)
- Preview/dry-run separation (Anthropic format has no mode separation)
- Schema validation for `risk_zone` (must be added by the runtime)

For these reasons, Anthropic-compatible workflows run at `untrusted` trust level
by default. The operator must explicitly upgrade trust.

## Permission Checker (`permission-checker.ts`)

### Hardcoded Forbidden Actions

```typescript
const ALWAYS_FORBIDDEN = new Set([
  'github.pr.approve',
  'github.pr.merge',
  'ruleset.bypass',
  'secrets.read',
  'kernel.constitution.write',
]);
```

### Permission Resolution

```typescript
function resolvePermissions(
  declared: WorkflowPermissions,
  granted: WorkflowPermissions,
  trustLevel: 'untrusted' | 'trusted' | 'core',
): Set<string> {
  if (trustLevel === 'untrusted') {
    // Untrusted workflows get read-only access only
    return new Set(['github.issues.read', 'github.prs.read']);
  }

  // Intersect declared with granted
  const allowed = new Set<string>();
  for (const category of Object.keys(declared)) {
    const declaredActions = declared[category] || [];
    const grantedActions = granted[category] || [];
    for (const action of declaredActions) {
      const key = `${category}.${action}`;
      if (!ALWAYS_FORBIDDEN.has(key) && grantedActions.includes(action)) {
        allowed.add(key);
      }
    }
  }
  return allowed;
}
```

### Nested Workflow Permission Intersection

```typescript
function intersectPermissions(parent: Set<string>, child: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const perm of child) {
    if (parent.has(perm) && !ALWAYS_FORBIDDEN.has(perm)) {
      result.add(perm);
    }
  }
  return result;
}
```

## HTML Renderer (`html-renderer.ts`)

### Generation

```typescript
function renderHtmlArtifact(
  run: RunStatus,
  options: {
    findings?: unknown[];
    triaged?: unknown[];
    issues?: Array<{ url: string; title: string }>;
    validation?: Record<string, 'pass' | 'fail'>;
    prUrl?: string;
    auditLog?: Array<{ ts: string; phase: string; message: string }>;
  },
): string;
```

### CSP Policy

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
/>
```

### Structure

- Summary header with workflow name, run ID, status, duration
- Phase timeline with expand/collapse
- Findings table with sort by severity
- Triage section with priority badges
- Issues section with links
- Validation results table
- PR section with link and metadata
- Audit log with timestamps
- Permissions summary

All CSS and JS are inline. No external resources. No network requests.

## Integration Points

### Operator Module

The Operator module provides the CLI commands that interface with the runtime:

```typescript
// In apps/cli/src/commands/collaboration.ts (Collaboration module owns workflow commands)
export function registerWorkflowCommands(collab: Command): void {
  const wf = collab.command('workflow');
  wf.command('list').action(listWorkflows);
  wf.command('show <name>').action(showWorkflow);
  wf.command('validate <name>').action(validateWorkflow);
  wf.command('preview <name>').action(previewWorkflow);
  wf.command('dry-run <name>').action(dryRunWorkflow);
  wf.command('run <name>').action(runWorkflow);
  wf.command('resume <runId>').action(resumeWorkflow);
  wf.command('inspect <runId>').action(inspectWorkflow);
  wf.command('cache clear').action(clearCache);
}
```

### Runtime Package

The `@openslack/runtime` package provides worktree isolation:

```typescript
import { createWorktree, checkDirty, cleanupWorktree } from '@openslack/runtime';
```

### Workspace Package

The `@openslack/workspace` package provides module registry for scope validation:

```typescript
import { readModules, getModuleById } from '@openslack/workspace';
```

## Testing Strategy

### Unit Tests

- Loader: format detection, path resolution, hash computation
- Manifest: validation rules, required fields, invalid inputs
- Runtime: phase tracking, budget enforcement, mode restrictions
- Cache: key computation, invalidation, hit/miss
- Run store: directory creation, status transitions, log persistence
- Resume: cached replay, manifest mismatch, interrupted pipeline
- Permission checker: forbidden actions, intersection, trust levels
- Anthropic compat: global injection, mode mapping

### Integration Tests

- End-to-end preview with a test workflow (no side effects)
- End-to-end dry-run with simulated side effects
- Resume after simulated interruption
- Nested workflow permission intersection
- HTML artifact generation and CSP validation

### Test Workflow

A minimal test workflow at `packages/workflows/src/__fixtures__/test-scan.ts`:

```typescript
export const meta: WorkflowMeta = {
  name: 'test-scan',
  description: 'Minimal test workflow for integration tests',
  phases: [
    { title: 'Scan', detail: 'Single dimension scan' },
    { title: 'Verify', detail: 'Single verifier' },
  ],
  permissions: { github: ['issues:read'] },
  risk: 'low',
};

export async function preview(ctx: WorkflowRuntime, args: Record<string, unknown>) {
  ctx.phase('Scan');
  ctx.log('Test scan starting');
  const result = await ctx.agent('Scan for test findings', {
    label: 'scan:test',
    phase: 'Scan',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  });
  return { preview: true, result };
}

export async function run(ctx: WorkflowRuntime, args: Record<string, unknown>) {
  const previewResult = await preview(ctx, args);
  ctx.phase('Verify');
  return { status: 'complete', ...previewResult };
}
```
