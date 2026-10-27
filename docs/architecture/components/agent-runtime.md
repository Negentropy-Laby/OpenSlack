---
schema: openslack.document.v1
id: architecture-agent-runtime
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-10-27
sources:
  - docs/reference/document-path-migration-v1.yaml
  - docs/architecture/adr/adr-0003-harness-closed-loop-repair.md
---

# Agent Runtime — Implementation Guide

## Package: `@openslack/agent-runtime`

Dependencies: `@openslack/core`, `@openslack/kernel`, `@openslack/workspace`, `@openslack/collaboration`, `@openslack/runtime`

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

## Opt-in DeepSeek Harness tasks

`deepseek-harness` uses the same Agent Run Bridge with the OpenSlack-owned external
package at `integrations/deepseek-harness` (see its
[installation and trust contract](../../../integrations/deepseek-harness/README.md)).
It targets unmodified Harness `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`,
SDK/dsh `0.2.1-rc.3`, and Node `24.18.1`; no Harness source or installation patches
are runtime dependencies. The old patched experiment remains historical only.
The failure, evidence and process-ownership repairs follow
[Accepted ADR-0003](../adr/adr-0003-harness-closed-loop-repair.md); decision acceptance
does not establish live qualification or PR approval.
Host task composition is exported only at the exact
`@openslack/agent-runtime/internal/harness` subpath, outside the sealed worker's
default provider module closure.
It does not replace Aby, add MCP tools, enable a TypeScript Workflow writer, or
grant approval/merge/release authority. The existing MCP preview and confirmation
tools route two reviewed targets: `harness.task.dispatch` accepts only an existing
approved `taskId` and a correlation `requestId`; `harness.task.report` records the
bound run's progress and evidence, never acceptance or completion.
Harness-only principals need neither `scenario.instantiate` nor a locked Scenario
Pack. Harness plans do not load or bind unrelated Scenario locks or initialize
their instance store. Scenario/Contract-to-Delivery paths retain their own explicit
capability, sealed-definition and storage checks; this separation grants nothing
to those actions.

The CLI loads an administrator-provisioned
`.openslack.local/harness/deployment.json` only when agent-bound serving explicitly
selects `--harness-task-host` or the host-created `--harness-worker-binding`.
Ordinary agent-bound serving does not inspect this deployment. Selecting a missing
host, mixing dispatcher/worker flags, or mixing either flag with an injected host
fails before composition rather than silently falling back. Provisioning is a separate
step after implementation; developers do not bootstrap an identity or supply
credentials to test this integration. The file uses `HarnessDeploymentFile` from
[the owning module](../../../packages/agent-runtime/src/harness-deployment.ts).
The configured host explicitly disables the RunStore's legacy startup sweep and
rejects linked canonical storage; it does not clean historical temporary evidence.
It fixes the principal's original UID/provider/runtime run ID, model route,
existing SDK home, independently bound Harness/plugin build roots, Node binary
version/hash, and digests of already approved
local workspace-task descriptors. Descriptors live under the approved identity
workspace's `.openslack.local/harness/tasks/`; dispatch cannot supply their paths,
prompts, file grants, verification definitions, or identity.

The file-based CLI composition runs in its approved primary identity workspace;
it rejects a different identity/read-model root. Actual task execution uses a new
isolated worktree at the approved commit and never copies identity or credentials.
An application using GitHub/claim-backed tasks must supply a live formal task and
lease source through `createHarnessTaskAuthority`; the local workspace-task format
explicitly rejects claim-required tasks rather than waiving their lease.

The host binds the verifier, nonsecret SDK profile and launch overlay, model
deployment, original Harness public runtime artifacts, exact external plugin
entries and callback modules into the approved task. Only the two approved code
roots' exact registered public files may be mounted, not arbitrary external paths.
Unsupported external/dynamic plugin mounts or SDK package overrides fail closed.
The worker's per-run callback binding is checked against the live canonical run;
the caller cannot turn an arbitrary run ID or environment variable into authority.
Runtime identities and execution run IDs remain distinct.

Installed byte proofs use `openslack.installed_runtime_closure.v2`: a bounded,
canonical package-resolution closure frames each relative path, exact byte length
and Core stable-descriptor SHA-256, including nested chunks, transitive package
copies, native modules and runtime resources. Resource bodies stream rather than
requiring a large buffer (256 MiB/file, 512 MiB total, 1,024 packages, 32,768 files).
Protected configuration/key names are rejected before content reads; package
resolution links cannot escape the approved code root. The separately framed
plugin digest uses `openslack.harness_plugin_artifacts.v2`. No old deployment,
receipt or approval is rewritten under these new digest domains.

The confirmed start's nominal execute eligibility is narrowed to its canonical
run/generation and checked after expensive observations and at actual spawn.
Only a denial restriction crosses the private peer/SDK boundary; dependency load,
SDK initialize and first-prompt awaits cannot turn an expired restriction into a
new executable start. Per-effect live authorization remains independent, and
expiry does not prohibit owned cancellation, shutdown or disposal.
The public `llm/stream` waterfall and its lazy iterator entry recheck the known
cutoff after Agent preparation awaits, without mutating the recorded request.
This guards the pinned SDK's public dispatch boundary, not an atomic private
provider/network operation.

Admission uses exclusive per-task routing records, canonical pending runs and a
durable owner generation, originating plan/execution/confirmation-attempt binding
and absolute deadline. Ownership is registered before asynchronous publication.
All providers' recorder/report state changes use store-owned functional
transactions and complete, fsynced snapshots published by rename. The persistence
watermark binds state revision and exact transcript bytes; pending transactions,
uncommitted tails and drift are not guessed into a success. A failed publication
retains its private temporary and any unresolved lock as evidence. Shared stable-FD
bytes come from Core; runtime callers retain their own path, link and ownership
checks. Trusted Windows spelling aliases normalize before comparison, while
directory junctions and links remain rejected.
Admission/report paths re-observe typed read conflicts within a bounded observation
window; three immediate synchronous reads do not constitute recovery or a new
admission. Corruption, invalid identities
and oversized records remain hard failures. Immutable stop-intent facts outside
the state transaction provide a report/tool barrier even when run-state recording
is busy or corrupt; orphan locks are never automatically repaired.
Same-key/same-input requests return the original run, while input drift or an
uncertain publication returns a conflict or indeterminate result without replay.
The visible activity anchor must be confirmed before a normal receipt is returned.
For principal-bound dispatch, the originating durable confirmation must succeed
for the exact plan, execution and attempt before the original in-process owner
can prepare or execute. Failed/aborted/uncertain confirmation stops that owner.
An unconfirmed, restarted, historical or legacy-format admission cannot activate
an executor; legacy records are observed without rewriting them.
`openslack_get_activity({objectKind: 'workflow', objectId: runId})` exposes an
optional bounded, redacted `execution` projection only through an already visible
anchor. Its reader never constructs or repairs a RunStore.

Harness uses separate caller and worker scopes. Confirmation bearers stay in a
private in-memory vault; model-visible confirm/cancel accept only `planId`.
The caller dispatches one approved task and queries its returned run. The worker
receives exact native file grants and current-task reports, with no Shell, PTC,
plugin management or recursive dispatch. File effects recheck production
principal/task permissions through the SDK owner before action, while the existing
filesystem observation/version policy remains authoritative.
`buildHarnessTaskPermissionProfile` adds only explicitly requested Harness callback
capabilities; it does not widen the permission baselines of other providers.

The per-launch overlay disables the original STDIO server and mounts the external
SDK host, which delegates standard requests to the public SDK server/transport.
Its native MCP owner holds raw definitions privately and directly awaits stop.
The peer observes the SDK's actual spawned child through Node's public experimental
`child_process` diagnostics channel, without SDK private fields or monkey patches.
Missing or ambiguous observation fails closed. Generation-bound prepare-shutdown
precedes standard ACK and actual child-close evidence; SDK cleanup never sends a
lazy-start request after failed initialization.

Cleanup clock readings never cross a process boundary. A private generation-bound
prepare carries only integer `remainingMs` in `1..24000`, not UTC or another
process's `performance.now()` value. The sender retains its original local
24-second outer bound; the receiver establishes one local monotonic deadline,
reused by nested stops, repeated prepare, standard ACK, flush and disposal.
Late completion cannot renew it. UTC execution cutoffs and task/claim leases
remain unchanged, as do the 25-second grace / 5-second force / 30-second envelope
and independent actual-exit requirements.

Every Bridge provider validates UTF-8, run/session identity, payload and terminal
ordering. Wire validation is independent of the provider's trusted exit policy.
Harness alone negotiates `chunked-json.v1`: frames remain at most 1 MiB, with
256 KiB chunks, at most 64 chunks and a 16 MiB logical-message ceiling. Full
canonical tool inputs/results are retained once in strict streaming JSONL evidence,
not copied into run state or silently truncated. The transcript is bounded at
64 MiB, including a 64 KiB terminal/error reserve; a generation-bound reservation
must fit before a tool effect. Incomplete, mismatched or over-budget evidence
cannot become a verified result.

On Windows x64 a private Go 1.26.5 supervisor assigns the peer to a nonbreakaway,
kill-on-close Job atomically during suspended process creation, then verifies
membership before resume. Typed outer receipts are separate from child Bridge
bytes and bind the run and owner generation. Success requires actual root exit,
Job process count zero, drained output streams and helper close; forced, absent or
unknown receipts never succeed. There is no direct-Node fallback. Task preparation
reserves 30 seconds inside its absolute total deadline for cleanup: SDK/MCP/ACK
coordination shares one 24-second deadline, and the Job owner uses 25-second grace
plus 5-second force observation within that same 30-second envelope. Heartbeat and
successive cleanup phases do not reset it. Explicit caller cancellation invalidates
success for every provider, including cancellation after complete during cleanup;
the legacy Aby internal completion grace remains a separate bounded policy.

The peer waits for a completed Session turn, managed work and SDK shutdown;
OpenSlack also confirms peer process exit. None of prompt enqueue, idle, heartbeat,
exit code alone or a model report constitutes acceptance. Host-owned text checks
require an acknowledged clean SDK shutdown receipt; forced SDK termination or
unconfirmed native MCP process disposal remains indeterminate. Text checks then
inspect the approved baseline, HEAD, index, modes, deletions, renames and all new
files, then verify expected bytes and report evidence before `recorder.complete`.
Acceptance writes a bounded receipt with file and tool-evidence digests. A final
synchronous version guard rejects artifact drift after authority awaits. Recovery
uses `reconcileHarnessTask` with `inspectHarnessTaskExecution`: it reads that receipt,
the canonical run, read authority, deployment and retained workspace without
constructing an SDK, repairing locks or changing historical records. An unknown
exit or mismatched evidence stays indeterminate. Historical observation does not
require a currently active claim lease; current execution eligibility is checked
separately and cannot turn an expired lease or a historical result into permission
to execute again.
Unsupported strict token/cost/turn/effort requirements are rejected, and absent
usage stays unknown. Disconnect/cancellation stops owned work, preserves artifacts
and records uncertainty; reconnection does not prompt, resume or redispatch.

Keyless fixtures do not qualify a real principal, credential service, model route,
native Windows deployment or hosted CI. Those are separate deployment checks after
the implementation is ready. No default profile or identity is installed by this
documentation.

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

State-derived patches and their intended transcript events share the owned run
transaction for every provider. Readers enforce the published transcript watermark;
they do not repair an incomplete append or discard its recovery evidence.

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
- a trusted provider policy requires isolation for file-writing tools → create worktree

Worktree creation uses `createWorktree()` from `@openslack/runtime`.
Cleanup/preservation and host acceptance follow trusted immutable
`ProviderExecutionPolicy`, not a provider-name comparison. Aby retains its explicit
existing cleanup policy; unknown external transports default to preservation.
Harness worktrees are always preserved for acceptance and reconciliation, including
apparently clean trees and unknown dirty-state results. An advisory handoff-write
failure cannot replace the accepted result or original execution error.

## MCP Scope

Phase 1 (current): Check and declare only.

- If `requiredMcpServers` contains servers not in `availableMcpServers`, throw
  `AgentUnavailableError`
- The generic launcher does not create a universal MCP client. The opt-in Harness
  composition owns only its scoped public client and callback surface described above.

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
bunx vitest run packages/agent-runtime/src/__tests__/
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
