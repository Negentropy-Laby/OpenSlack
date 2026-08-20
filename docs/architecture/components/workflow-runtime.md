---
schema: openslack.document.v1
id: architecture-workflow-runtime
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-08-20
sources:
  - docs/reference/document-path-migration-v1.yaml
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
> **illustrative sketch** of the desired API surface. A production
> implementation must NOT use `AsyncFunction` or `eval` to execute arbitrary
> JS from workflow files. The real implementation must:
>
> 1. Complete static analysis of the file before any execution (see Loading Flow)
> 2. Run the workflow body inside a sandboxed execution context (e.g., a
>    dedicated worker thread with restricted globals, or a VM module with
>    a frozen sandbox object)
> 3. Never pass unsanitized file contents to code evaluation primitives
>
> The sketch below shows only the API shape, not the execution mechanism.

```typescript
// ILLUSTRATIVE API shape only. Real implementation uses sandboxed execution.
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
  // Unsafe sketch: wrapping the body in an async function is NOT production-safe.
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

### GS8 Workflow Runner process boundary

The frozen `openslack.workflow_runner.v1` contract defines a future JSONL child-process boundary
between a Go scheduler and the existing TypeScript runner. Go may own only runner jobs, attempts,
leases/fencing, cancel requests, and durable protocol receipts. TypeScript continues to load and
execute JavaScript, call agents, enforce permissions, decide or execute effects, and own RunStore,
checkpoint, resume, approval, and budget state through GS8.

GS8-A provides the immutable schemas, validators, exact-byte vectors, and importable Go mirror.
GS8-B implements a separate, explicit runner-server with PostgreSQL job/attempt/lease/fence/cancel
and receipt ownership. It launches only an externally hash-anchored, closed worker bundle containing
one copied Node executable, one self-contained JavaScript entrypoint, and the exact manifest under
the platform process-tree supervisor. The worker resolves a hash-bound descriptor from an
owner-only store, rejects workflow sources with runtime imports, revalidates the source immediately
before import, and starts JavaScript only after the durable `lease_accept` receipt. This source
closure is specific to the GS8 worker and does not change the legacy CLI loader. See
[`../contracts/workflow-runner.md`](../contracts/workflow-runner.md).

GS8-B remains off by default and does not change the CLI `run` or `resume` paths. Go cannot select
or receive an arbitrary workflow command, module path, raw argument, URL, prompt, or credential and
does not embed another JavaScript runtime. TypeScript continues to own RunStore, checkpoint,
resume, approval, effect execution, agent/provider calls, and budget state until GS9.

### GS9-A Workflow Control authority contract

GS9-A freezes the future authority record under
`packages/workflows/contracts/workflow-control-authority/v2/` and mirrors it in the pure Go
`authoritycontract` package. It keeps run revision/CAS separate from GS8 attempt/lease/fencing,
keeps legacy run-gate and workflow-effect approval v2 separate, defines the durable receipt as the
checkpoint commit point, and freezes resume generation plus cumulative budget decimal/rounding
rules. It also freezes an 18-kind `openslack.workflow_runner.v2` vocabulary with 12 retained v1
kinds and six additions without changing v1 bytes. The immutable authority epoch may select a
writer only before a future record is created.

The six added v2 kinds are `checkpoint_commit`, `budget_reserve_request`, `budget_usage_report`,
`budget_authorization`, `effect_authorization`, and `resume_offer`. Durable budget quantities are
canonical non-negative decimal strings within signed 64-bit `BIGINT`; money uses integer
`nano_usd`, scale 9, and `half_up_nonnegative` conversion. The schemas and vectors freeze these
rules plus the v2 `hello` / `hello_ack` negotiation contract, but GS9-A does not negotiate,
deliver, or apply them to a running workflow.

This is contract-only `LOCAL_PASS`: existing CLI/TUI/MCP paths and every current or new workflow
record remain TypeScript-authoritative. There is no Go Workflow Control PostgreSQL authority,
active route, user-visible read cutover, v2 runtime negotiation/delivery, checkpoint/resume runtime,
approval/effect execution, budget enforcement, canary, or rollback in GS9-A. Organization Graph is
unrelated to this boundary.

### GS9-B default-off authority spine

GS9-B adds a third, isolated PostgreSQL namespace for qualification-only Workflow run heads. Its
six tables own immutable epoch registration, run revision/state/phase/resume CAS, append-only
transition events and exact receipts, same-transaction outbox records, and unresolved
reconciliation evidence. They do not modify or reuse the GS8 runner job/attempt/lease/fence
tables, and they do not persist checkpoint, approval, effect, or budget subdomains.

The `/authority-server` binary exposes mutation routes only in the closed
`local-qualification-v1` mode with fixed workspace, caller, epoch, build, bearer, and loopback
binding. Production defaults remain unregistered and `acceptNewRecords: false`; the image still
starts the observational `/server`. Same-key/same-fingerprint requests return the original receipt
bytes, while stale CAS, route drift, invalid transitions, and fingerprint conflicts return 409.
Unknown commit evidence never advances the run head and a double-unknown outcome fails closed.

This batch does not connect the TypeScript RunStore, JavaScript runner, CLI/TUI/MCP, or Qoder to
Go. It does not negotiate runner protocol v2 or implement checkpoint/resume, approval/effect,
budget, canary routing, rollback, migration, or writer retirement. The evidence ceiling is
`GS9-B LOCAL_PASS / Go authority NOT_CLAIMED` after the reviewed real-PostgreSQL race, restart,
atomicity, migration, OpenAPI, and default-off image gates pass.

### GS9-C checkpoint and resume shadow

GS9-C introduces an explicit awaited `ctx.checkpoint.commit()` for evidence recorded after phase
work. The existing `ctx.phase()` remains a synchronous phase-entry marker for compatibility and
cannot be used as a durable commit claim. The TypeScript `RunStore` persists bounded artifact bytes
and a canonical checkpoint-control head before journaling a hash-only observation.

The control head owns revision, resume generation, source sequence, checkpoint prefix, immutable
workflow/manifest/input identity, and the current runner binding. Resume is allowed only with the
opaque binding minted by `WorkflowRunnerSession` after an advancing lease receipt; public callers
cannot manufacture that authority. Each valid resume uses a new attempt/lease and higher fence and
emits `resume_advance` before the next checkpoint. Artifact and control corruption, phase gaps,
identity drift, and stale bindings fail closed in TypeScript.

An accepted lease may resume before any checkpoint only at the derived `phase-0` identity with a
null prior checkpoint. Consecutive new leases may repeat that state, but the first committed
checkpoint must still be phase 0. Ordinary `createRuntime()` instances expose no checkpoint member;
the required capability exists only on the internal runner-authority runtime subtype.

The optional observer is disabled unless the trusted runner host injects a closed loopback
configuration. Local journal durability is awaited; remote delivery is ordered and asynchronous,
so Go failure cannot delay or roll back the TypeScript checkpoint. Artifact bytes, workflow input,
prompts, results, provider payloads, approval details, credentials, and paths are excluded from the
wire.

The RunStore uses the same owner-safe, deadline-bounded lock primitive as the Workflow Control
shadow journal. Pending observations are journaled from a stable snapshot and only the exact
successful prefix is removed under a second lock, preserving concurrent tail appends for replay.

The isolated Go checkpoint shadow validates `checkpoint_commit` and `resume_advance`, recomputes a
matched prefix, records exact receipts and reconciliation, and never participates in resume. This
does not negotiate runner v2, activate Go Workflow authority, or change CLI/MCP/Qoder reads.

### GS9-D D1/D2 effect-control seam

The effect boundary remains TypeScript-owned. D1 freezes a closed schema/manifest/golden-vector
bundle without implementing the runtime or store. The bundle has exactly six semantic artifact
variants: `effect_intent`, `effect_approval_pending`, `effect_decision_committed`,
`effect_audit_recorded`, `effect_execution_claim`, and `legacy_run_gate_observation`. A stable
occurrence ID prevents two identical operation/detail pairs in one run from sharing a decision or
execution claim.

The D2 TypeScript runtime order is:

```text
durable TypeScript effect_intent
  -> admission/run-continuation gate
  -> exact effect_approval_pending
  -> independently authenticated effect_decision_committed
  -> atomic one-time TypeScript effect_execution_claim:claimed
  -> effect invocation
  -> effect_execution_claim:executed or effect_execution_claim:reconciliation_required
```

The admission gate may still use a callback, manifest, unattended policy, or legacy run state to
pause, cancel, or continue evaluation. It cannot authorize the effect. In particular, changing a
legacy `pending-approvals.json` entry to `approved` may resume an old run, but the re-entered effect
must still present an exact, active v2 decision and win its one-time claim. The legacy record is
never read as an effect grant and its only semantic projection,
`legacy_run_gate_observation`, carries no authority edge.

The v2 decision binds run, workflow ID/version/hash, input hash, stable effect occurrence, effect
ID/hash, required capability, business correlation, expiry, decision revision/hash, workspace,
human principal, and reason hash. The independently authenticated human channel must be current
for that exact decision. The owner-only store rechecks expiry and expected revision under lock,
then atomically binds one claim to an exact `executionId`. An approved revision-1 decision with
audit pending and the same decision's revision-2 `effect_audit_recorded` projection are both valid
inputs to that one claim. Audit-sink success is evidence, not an authorization prerequisite. D1
does not bind job, attempt, lease, or fence; GS9-F1 introduces only the runner-v2 foundation binding.

The stable occurrence identity deliberately excludes the runner descriptor expiry. Descriptor
expiry is checked for every attempt before claim use, so an expired lease cannot execute, while a
new accepted lease can resume the same occurrence without minting a second approval or execution
identity. An immutable occurrence anchor is written before the mutable authority head. Missing,
one-sided, or hash-divergent anchor/head evidence latches reconciliation instead of allowing a
deleted record to look like a first execution.

Pending approvals are generation-bound. Generation zero retains the original deterministic
approval ID. If it expires before claim acquisition, the authority advances an immutable current
generation anchor and creates a new deterministic approval ID; old decisions, attestations, and
views remain historical evidence and cannot authorize the new generation. The host may configure
the approval TTL from one minute through 24 hours; the default remains 15 minutes.

Once claimed, an occurrence cannot be automatically executed again. A crash, cancellation,
timeout, or response loss after claim but before a proved outcome becomes reconciliation. Resume
or a newer lease may inspect that state, but neither can retry the effect until an explicit
reconciliation path proves what happened. Rejection produces no claim and no invocation.
The decision workspace must equal the artifact workspace. Claim acquisition must occur while the
approved decision is active; a terminal execution or reconciliation commit may occur after that
approval expires so long as it is not earlier than the durable claim. Expiry therefore blocks new
claims without invalidating an already consumed one.
An executed JSON result is stored in a separate owner-only replay artifact and bound to the claim
by reference and SHA-256. Its canonical JSON payload is limited to 256 KiB. Missing, modified, or
oversize replay evidence latches reconciliation after the side effect; it never permits a second
invocation. Deterministic replay returns only that hash-verified value and preserves the original
effect source-sequence position.

The effect-control observer is a separate, optional, default-off port. TypeScript commits its
authoritative local record first. The six semantic artifacts map to exactly three future Go
observer operations: `approval_created`, `approval_decided`, and `audit_recorded`. Intent,
execution claim, and legacy gate observations are not Go approval-shadow operations. Go receives
only credential-free hashes, bounded identity, revision, time, and status. Go cannot create a
decision or claim, and its outage, mismatch, receipt, or audit-sink failure cannot change a
TypeScript effect result. Raw detail, input, prompt, provider content, effect payload/result, human
reason, attestation nonce, credential, bearer, endpoint, transcript, stack, command, and local path
remain local and never enter the observer.

Runner v1 remains byte-for-byte frozen. The D1 bundle is not a v1 message extension and does not
activate runner-v2 `effect_authorization`. D2 consumes the bundle to implement and qualify the
TypeScript store plus nominal, non-public authorization/claim composition. D3 adds and qualifies
the default-off Go parity observer over only the three observer operations, including restart,
duplicate, response-loss, concurrency, tamper, expiry, capacity, and disabled/unavailable-Go
cases. Until the D3 exit gates pass, the evidence ceiling remains
`GS9-C LOCAL_PASS / Go authority NOT_CLAIMED`; afterward it may become
`GS9-D LOCAL_PASS / Go effect authority NOT_CLAIMED` and nothing broader.
The pinned runner manifest and golden hashes are source-lock evidence only. The runtime
`controlBuildHash` is a separate deployment identity supplied by trusted composition and is never
learned from, or self-certified by, an incoming receipt.

In D2 the nominal composition is created only by the authenticated worker after the advancing
`lease_accept` receipt. Each current attempt emits and closes its own runner-v1 intent/outcome
pair, while resume reuses the original owner-local occurrence, approval, and one-time execution
claim. The claim is published exclusively and mirrored in the authority head; mismatch, missing
consumption evidence, a live competing owner, or an unknown terminal write fails closed. Pending
approval and reconciliation are run-level latches even when workflow code catches the thrown
error. Public TypeScript callers therefore remain useful for validation and admission, but cannot
execute a governed effect without the private authenticated-host capability.
Manifest `approvedEffects` remains admission metadata only and never replaces the per-occurrence
v2 human decision. Effect pending, decision, and audit persistence use the same optional
observation hook as local execution; observer failure remains fail-open to TypeScript authority.

### GS9-D D3 default-off effect parity shadow

D3 consumes only the three credential-free observer operations frozen by D1 and emitted after the
authoritative D2 TypeScript commits: `approval_created`, `approval_decided`, and
`audit_recorded`. The owner-only TypeScript journal remains append-before-send, ordered per run,
and fail-open to the TypeScript effect result. Intent, execution-claim, replay-result, and legacy
run-gate artifacts never enter this transport.

The separate `effect-shadow-server` registers
`POST /v1/shadow/workflow-control/effect-events` only in explicit
`local-qualification-v1` mode. Its request idempotency keys use the frozen
`openslack.workflow-effect-control-shadow.v1.` prefix and bind the exact canonical envelope plus
workspace, run, occurrence, approval, source sequence, operation, and hashes. It listens on
loopback `127.0.0.1:8084` for qualification and remains health-only when disabled.

PostgreSQL persistence uses only `workflow_control_effect_shadow_*` tables introduced by migration
`000005`. It records immutable observations, byte-identical replay receipts, one matched-prefix
head, mismatch evidence, and unknown-commit reconciliation. A semantic mismatch may advance the
observed source sequence but cannot advance matched parity; a latched mismatch or reconciliation
cannot be hidden by a later observation. Same-key/different-fingerprint, stale sequence, identity
drift, tamper, expiry, and capacity violations fail closed inside the observer.

The local observer retries transient transport failures eight times with bounded exponential
backoff while preserving its append-before-send journal. The Go outbox remains read-only and uses
opaque exact-timestamp keyset pagination; page size does not cap total evidence visibility.

Go never reads human attestation, creates or changes a decision, mints an authorization, claims or
executes an effect, resumes a run, or changes a TypeScript response. Go outage, timeout, invalid
receipt, mismatch, and reconciliation remain observational only. Runner v1 remains byte-identical
and runner-v2 `effect_authorization` is still not negotiated or delivered. The reviewed exact-byte,
real-PostgreSQL race/restart/response-loss, OpenAPI, default-off image, and cross-language gates may
establish only `GS9-D LOCAL_PASS / Go effect authority NOT_CLAIMED`; authenticated-host, live,
release, production, routing, and writer-cutover claims remain separate.

### GS9-E1 budget operational contract and provider evidence seam

GS9-E1 freezes a TypeScript-owned `workflow-budget-authority/v1` bundle and a byte-identical Go
mirror. The Go package is validator-only: it replays the closed schemas, golden vectors, canonical
integer quantities, and pure reserve/reject/settle/reconciliation folds, but owns no runtime state.
The account, reservation, provider usage, settlement, ledger, exact receipt, and reconciliation
records bind tokens, `nano_usd`, and calls without using JavaScript or Go floating point in
authority bytes. Existing TypeScript `BudgetState.costUsd` remains local/UI estimation evidence.

The OpenAI-compatible adapter exposes bounded, domain-separated, hash-only usage evidence for each
real provider turn. A provider turn, rather than an entire potentially multi-turn agent invocation,
is the unit that future authority integration must reserve and settle. Receipt and settlement
bindings contain no prompt, response, endpoint, credential, transcript, or provider-output body.
Failure with trusted usage remains chargeable evidence; missing or untrusted usage fails closed to
provider-outcome reconciliation.

`total_tokens` is the authoritative adapter quantity and must be a non-negative safe integer.
`prompt_tokens` and `completion_tokens` are optional detail only: invalid, null, fractional, or
inconsistent detail is omitted from the receipt without discarding a valid total. Usage is charged
and the budget limit is checked before provider choice or finish-reason validation. Tool calls are
then counted, bounded, validated, and executed in order so an already executed valid prefix remains
observable and a limit breach takes precedence over a malformed call beyond that limit. In v1,
account and run revisions remain separate fields but advance together; a settlement revision may
not predate the reservation revision that opened its encumbrance.

E1 is a contract and evidence seam only. It adds no database, migration, repository, HTTP route,
server, runner-v2 delivery, production budget client, canary, routing, or authority cutover. Its Go
mirror cannot authorize or persist a budget operation. GS9-E2 consumes the mirror only inside an
isolated qualification process.

### GS9-E2 default-off durable budget qualification authority

GS9-E2 creates the independent PostgreSQL account, reservation, ledger, receipt, and
reconciliation namespace under migration 6. It uses the existing GS9-B immutable route and running
run head as the global CAS boundary while maintaining an independent account revision. Every
reserve, durable rejection, and settlement advances both revisions exactly once and writes a
budget ledger entry as the source for the accepted run revision; it does not write a transition
event or reuse runner/checkpoint/effect state.

If another writer advances a running run without advancing the E2 account, the account/run
revision mismatch is a conflict and E2 does not rebase it. GS9-F2b must explicitly coordinate that
future writer after the F1 transport foundation.

The account preserves a canonical genesis anchor. Restart recovery folds every closed ledger kind
from that anchor, verifies each provider-attempt ledger entry against its exact provider-usage
receipt, and requires the rebuilt account bytes/hash to match the current head.

E1's exact records remain TypeScript-owned, `validator_only` operational projections. Each E2
database and HTTP record wraps one unchanged projection in the Go-owned
`openslack.workflow_control_budget_durable_record.v1` companion envelope. That envelope fixes the
qualification authority/writer/mode, `productionAuthority=false`, E1 manifest hash, authority build
hash, closed record kind, projection, and projection domain hash. Neither layer can be cross-spliced
without an integrity failure.

The operation order is closed: canonical request/fingerprint, ordered idempotency and run locks,
exact receipt lookup, open database-reconciliation rejection, run-head lock, stable account and
reservation locks, route/state/revision/policy/limit checks, reservation plus ledger, account and
run CAS, exact receipt/response, then commit. Same-key replay is byte-identical and mutation-free;
that replay is returned before the active build and policy checks;
same-key fingerprint drift and new-key semantic provider-turn duplication conflict. Unprovable
database commit recovery rereads the run under the shared lock and atomically latches it at the
next revision in `reconciliation_required` only when the original mutation is absent and the run
still matches the request. Its receipt keeps accepted revisions null; drift or a second unknown
commit leaves no unproved latch.

The first qualification account is initialized from a fixed, non-secret process `BudgetSeed`
(policy hash and three canonical limits), never from an HTTP request. A production initial-policy
source is not delivered.

The `/budget-authority-server` process is health-only by default and opens data routes only under
an exact loopback `local-qualification-v1` workspace/caller/build/epoch/bearer binding. Existing
binaries support schema heads through 6 without raising their minimums; the budget binary requires
exactly 6. The default container entry point remains `/server`.

The qualification interface proves cache-hit zero mutation, durable reserve before provider
execution, and durable settlement before cache visibility. No production workflow code or provider
adapter calls this service in E2. Nonzero resume generations fail closed without budget mutation;
Runner v2 owns future resume delivery. The evidence ceiling is `GS9-E LOCAL_PASS / Go durable budget
qualification authority / Go production Workflow budget authority NOT_CLAIMED / Runner v2
NOT_DELIVERED / routing / canary / cutover NOT_ACTIVATED`.
`WORKFLOW_BUDGET_PRODUCTION_INITIAL_POLICY_SOURCE NOT_DELIVERED` is explicit.
Provider reconciliation leaves the unresolved reservation open and latches the run; a settled
reservation closes at its terminal ledger time. The shared GS9-B writer honors any open budget
database-commit reconciliation under the common run lock.

Public CLI and TUI execution submit to the loopback Workflow Runner control service rather than
calling `executeRun` or `executeResume` directly. The client seals a descriptor, submits only the
canonical hash-bound JobSpec, polls the strict JobView, and accepts a completed result only when
its hash matches the durable RunStore output. Resume creates a new job and descriptor but reuses
the workflow run ID. Project/user workflow sources remain single-file and self-contained; reviewed
builtins may use transitive product modules because the exact builtin source hash and the sealed
runner build hash jointly bind those bytes. Missing transport configuration fails before execution
and never falls back to the legacy in-process route.

GS9-E1 freezes the budget contract and evidence seam; E2 adds only its durable qualification
authority. GS9-F1 lays the transport foundation, F2a freezes the companion contract, and F2b
completes runtime delivery. GS9-G owns new-record routing,
canary, PostgreSQL single-writer cutover, and higher-epoch rollback. GS9-H makes TypeScript a
read-only recovery path. GS9-I deletes the TypeScript writer only after external qualification and
drain. D1 makes no live, release, production, external-host, or Go-authority claim.

### GS9-F1 default-off runner v2 foundation binding

GS9-F1 composes only the admission/storage and negotiation foundation for the frozen v2 runner
vocabulary. The job, worker hello, lease, and stored event/receipt bind the same workspace,
route/build/epoch, run revision, resume generation, attempt, lease, and fence. The worker advertises
the ordered `[v1, v2]` set, but a v2-required foundation job cannot select or fall back to v1.

The transport enforces receipt-before-decision: a later adapter cannot advance until the current
event and exact runner receipt are durable and the receipt is delivered. GS9-F1 intentionally has
no real checkpoint, effect, budget, or resume adapter and makes no claim about their end-to-end
decisions, runtime delivery, or crash-after-authority recovery. GS9-F2b must add and qualify those
bindings before complete runner-v2 delivery can be claimed. Existing v1 bytes remain exact.

The F1 session serializes heartbeat and workflow events through one receiptable lane. Cancellation
aborts execution without overtaking an existing event; cancel acknowledgement drains before the
sealed terminal is sent. A terminal already accepted in PostgreSQL stays terminal if only delivery
of its own event receipt is uncertain. A resume decision's `newAttemptId` is a separate workflow
resume identity, while the active runner lease attempt remains stable for envelope and receipt
binding. Total-token reservation and provider output limiting are also separate quantities.

The foundation remains off unless its qualification profile is selected. The default image does
not submit or route v2 work. TypeScript remains the sole production Workflow state-machine,
checkpoint/resume, approval/effect, budget-policy, provider, RunStore, and user-visible read
authority; F1 makes no routing, canary, cutover, release, live, or production claim.

### GS9-F2a authority-binding companion boundary

The GS9-F2 umbrella is delivered as two sequential Red-zone PRs. F2a is contract-only. It freezes
the TypeScript-owned `openslack.workflow_runner_authority_binding.v1` stage/resolution/receipt/error
bundle and a pure Go exact validator. F2b alone may add migration `000008`, durable staging,
authority adapters, process composition, recovery, or runtime delivery.

The future F2b data path must preserve two explicit phases:

```text
sealed worker companion stage_event exact bytes
-> validate job / attempt / lease / fence / route / build / epoch / current head
-> durable stage ACK reserves the exact future runner-v2 event bytes
-> source authority commit or exact prepared authority evidence
-> commit_authority resolution with exact source request and source result
-> durable resolution ACK
-> send the byte-identical frozen runner-v2 event
-> Go consumes the resolution and mutates the coordinator/global head
-> runner event receipt delivery
-> runner control_delivery ACK for exact event receipt / kind / sequence / digest / lease / fence
-> matching control decision delivery, when required
-> runner control_delivery ACK for that exact decision
-> worker advancement
```

F2a freezes the six operations `checkpoint_commit`, `effect_authorize`, `effect_complete`,
`budget_reserve`, `budget_settle`, and `resume_advance`. The coordinator/global revision deltas are
respectively `+1/0`, `+1/0`, `0/0`, `+1/0`, `+1/0`, and `+1/+1` for
`runRevision/resumeGeneration`. Embedded `sourceAuthority` expected/accepted heads are independent;
their source-store revision cannot be replaced by, inferred from, or silently rebased to the
coordinator revision. The durable source decision or observation is evidence for
`commit_authority`, not the coordinator/global receipt itself. The worker must not send the frozen
runner-v2 event until the exact matching `commit_authority` resolution has a durable ACK.

The closed receipt union covers stage ACK, resolution ACK and runner-to-control `control_delivery`
ACK. Each delivery ACK binds the exact control event, kind, sequence, digest and active
attempt/lease/fence; response loss or a replayed/cross-spliced ACK cannot clear another delivery.

The bundle hashes lock the six manifest SHA-256 values for the existing runner-v1, authority-v2
(including the runner-v2 vocabulary), checkpoint, effect-control, effect-shadow and budget sources,
plus both F1 migration `000007` SQL hashes. They do not modify those bytes, and a source lock is not
a runtime service build identity. The contract names the future
`workflow-control-runner-v2-runtime-delivery-v1` profile but does not register it. The binding
rejects phase, operation, event, exact-byte, route/build/epoch,
revision/generation, job/attempt/lease/fence, source-authority and receipt drift.

No runtime code emits or consumes these frames in F2a. The F1 profile and
`integration/source-manifest.v2.json` remain unchanged, TypeScript remains the production Workflow
authority, and Go `runnerbindingcontract` has no durable authority. Production v2 submission,
new-record acceptance, routing, canary, cutover, fallback/writer removal, external qualification,
Qoder, remote Connector, release, live, tag, npm and production claims remain outside this contract
batch. Its exact ceiling is
`GS9-F2A CONTRACT LOCAL_PASS / Go exact mirror validator only / runtime authority delivery
NOT_CLAIMED`; production Go Workflow/checkpoint/effect/budget/provider/RunStore/read authority,
hosted exact-head checks, review resolution, independent human approval and merge are separate and
not claimed.

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
