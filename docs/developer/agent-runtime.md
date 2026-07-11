---
schema: openslack.developer_doc.v1
status: active
created: 2026-06-02
---

# Agent Runtime — Implementation Guide

## Package: `@openslack/agent-runtime`

Dependencies: `@openslack/kernel`, `@openslack/workspace`, `@openslack/collaboration`, `@openslack/runtime`

## Type Definitions

### AgentRunRequest

The input to launch an agent run. Contains everything needed to execute,
record, and audit a single agent invocation.

```typescript
interface AgentRunRequest {
  runId: string;
  agentId: string;
  prompt: string;
  resolvedConfig: ResolvedAgentConfig;
  permissionProfile: AgentPermissionProfile;
  budget?: { tokens: number; costUsd: number };
  correlationId?: string;
  threadId?: string;
  worktreePath?: string;
}
```

### AgentRunState

The mutable state of a run, persisted to `run.json`.

```typescript
interface AgentRunState {
  runId: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  agentId: string;
  model?: string;
  startedAt: string;
  completedAt?: string;
  tokensUsed: number;
  tokensRemaining: number | null;
  toolCalls: number;
  lastTool?: string;
  failureCode?:
    | 'RUNTIME_NOT_CONFIGURED'
    | 'RUNTIME_MISCONFIGURED'
    | 'PROVIDER_UNAVAILABLE'
    | 'PROVIDER_TIMEOUT'
    | 'PROVIDER_INVALID_RESPONSE'
    | 'TOOL_ARGUMENT_INVALID'
    | 'TOOL_DENIED'
    | 'BUDGET_EXCEEDED'
    | 'LIMIT_EXCEEDED'
    | 'EXECUTION_FAILED';
  errorSummary?: string;
  error?: string;
  worktreePath?: string;
  transcriptPath: string;
}
```

### AgentPermissionProfile

Immutable permission snapshot computed before execution.

```typescript
interface AgentPermissionProfile {
  allowedTools: string[];
  deniedTools: string[];
  permissionMode: PermissionMode;
  canApprovePR: false; // Always false
  canMerge: false; // Always false
  canReadSecrets: false; // Always false
  canBypassRulesets: false; // Always false
  acceptEdits: boolean;
  isReadOnly: boolean;
}
```

## Launcher Contract

`createOpenSlackAgentLauncher(options)` returns an async function matching:

```typescript
(prompt: string, options: AgentOptions & { resolvedAgentConfig?: ResolvedAgentConfig }) =>
  Promise<{ data: T; tokenUsage?: number }>;
```

The launcher is injected into `WorkflowRuntime` as the default `AgentLauncher`.
It has no fixture fallback: a missing execution provider creates a terminal
failed run and throws `RuntimeNotConfiguredError`. Tests may inject a custom
launcher or `LocalExecutionAdapter` explicitly.

`ResolvedAgentConfig.runtimeProvider` selects execution. `provider` remains model
vendor metadata, while `bridgeMode` describes transport. `ProviderRegistry` is
instance-scoped and rejects duplicate provider IDs.

The production registry includes `openai-compatible` and opt-in `aby`. The
OpenAI-compatible adapter resolves its credential reference only while creating
the transport, performs a bounded Chat Completions tool loop, requires valid
provider-reported token usage, and charges usage after every response. A workflow
result schema is validated before the run can be recorded as complete.

## OpenSlack-owned Tool Plane

`AdapterExecutionContext.toolExecutor` is required. The first production tool
plane contains four typed tools:

- `repo.read` and `repo.search` perform bounded text access;
- `repo.apply_patch` performs one exact replacement or creates one file;
- `repo.diff` returns bounded tracked diff plus untracked-file evidence.

The executor validates exact argument keys before `ToolGuard`, then validates
worktree containment, symlink ancestry, Red/Black paths for writes, runtime
metadata paths, and byte limits before side effects. `.git/**`,
`.openslack.local/**`, credential directories, `.env*`, key files, and similar
credential-equivalent paths are inaccessible. Provider-driven Red Zone writes
are rejected and must use a separate human-governed path. Cancellation and the
run deadline remain active during file walks and Git subprocesses. The same
redacted, byte-bounded result is returned to the provider and persisted as
transcript evidence. Chat Completions wire names use `repo_read`,
`repo_search`, `repo_apply_patch`, and `repo_diff`, then map back to canonical
internal names.

## Recorder Protocol

`createRunRecorder(store, rootDir)` produces a `RunRecorder` with these methods:

- `start(request)` — creates run, writes `start` event, returns state
- `reject(request, error)` — creates a terminal failed run without a running transition
- `progress(runId, data)` — appends `progress` event
- `toolCall(runId, toolName, input)` — appends `tool_call` event, increments toolCalls
- `toolResult(runId, toolName, output)` — appends `tool_result` event
- `chargeUsage(runId, tokenUsage)` — atomically charges provider-reported usage
- `complete(runId, result, tokenUsage)` — appends `complete` event, updates state
- `fail(runId, error)` — appends `fail` event, updates state
- `cancel(runId)` — appends `cancel` event, updates state

## Permission Profile Construction

`buildPermissionProfile(resolvedConfig)`:

1. Determine effective mode (default: `strict`)
2. Select baseline tools for mode:
   - `plan`: Read, Grep, Glob, Find plus read/search/diff repository tools
   - `acceptEdits`: + Edit, Write and `repo.apply_patch`
   - `default`: + Edit, Write, Bash and `repo.apply_patch`
   - `strict`: the same read-only baseline as `plan`
3. Intersect with `tools` allowlist (if specified)
4. Subtract `disallowedTools` denylist
5. Add hardcoded forbidden actions to denied list
6. Set boolean flags from mode

## Worktree Isolation

The launcher checks:

- `resolvedConfig.isolation === 'worktree'` → create worktree
- `agentId` contains "implement" or prompt contains "implement" → create worktree
- an `openai-compatible` run can call `repo.apply_patch` → create worktree

Worktree creation uses `createWorktree()` from `@openslack/runtime`.
Cleanup happens in `finally` block.

## MCP Scope

Phase 1 (current): Check and declare only.

- If `requiredMcpServers` contains servers not in `availableMcpServers`, throw
  `AgentUnavailableError`
- No full MCP client implementation yet

## Error Types

- `AgentUnavailableError(missingMcpServers)` — agent cannot run due to missing MCP
- `PermissionDeniedError(action, reason)` — action blocked by permission profile
- `RuntimeNotConfiguredError` — no execution provider is selected or registered
- `RuntimeMisconfiguredError` — a selected provider has invalid local configuration
- `ProviderUnavailableError` / `ProviderTimeoutError` — transport outage versus timeout
- `ProviderInvalidResponseError` — malformed response, missing usage, or invalid result schema
- `ToolArgumentInvalidError` / `TOOL_DENIED` — malformed versus unauthorized tool call
- `AgentBudgetExceededError` — provider-reported tokens exceed the token budget
- `AgentLimitExceededError` — turn, tool-call, response, or tool-result safety limit

## Testing

Run the agent-runtime test suite:

```bash
bun test packages/agent-runtime/src/__tests__/
```

Key test files:

- `run-store.test.ts` — CRUD, path traversal, corruption, secret scanning
- `transcript.test.ts` — append, read, malformed line skipping
- `permissions.test.ts` — all modes, allowlist/denylist, hardcoded blocks
- `launcher.test.ts` — run lifecycle, transcript recording, result shapes
- `mcp-worktree.test.ts` — MCP rejection, worktree creation
- `tool-executor.test.ts` — tool contracts, containment, Black paths, redaction, byte caps
- `openai-compatible-runtime.test.ts` — multi-turn protocol, budget, failure evidence, worktrees
- `openai-compatible-diagnostics.test.ts` — preview/write, four-state doctor, smoke evidence
