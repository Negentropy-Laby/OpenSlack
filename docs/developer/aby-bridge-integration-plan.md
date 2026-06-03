# Aby Runtime Bridge Integration Plan

> Phase AR-2.5A-2.7: Replace Claude/Codex Adapter Preview with Aby Runtime Bridge Preview

**Status**: Proposed
**Date**: 2026-06-03
**Depends on**: AR-2 PRs #146-#150 (agent-runtime baseline)
**Review note**: This plan is scoped to a bridge preview. It must not turn Aby
into a compile-time dependency, a CI prerequisite, or a replacement owner for
OpenSlack's run store, permissions, transcript, or worktree lifecycle.

---

## Design Principle

OpenSlack remains the owner of governance, permissions, run store, transcript, and worktree lifecycle.
Aby is a configurable external execution provider, accessed through a **bridge contract**.
No Aby internals (AppState, UI, tmux, runtime) are imported into OpenSlack.

The bridge process is treated as a cooperating external runtime, not as a
trusted policy authority. OpenSlack constructs the permission profile, starts
and completes the run, records the transcript, owns worktree creation/cleanup,
and validates every bridge envelope before it affects durable state.

Aby integration is opt-in. Missing Aby configuration must fail closed when an
Aby bridge mode is explicitly requested, and must not change the current local
adapter default used by workflow `ctx.agent()`.

---

## Contract Mapping

### Event Mapping (Aby -> OpenSlack)

| Aby Event | OpenSlack Event | Adaptation |
|-----------|-----------------|------------|
| SessionStart | `progress` transcript event (`bridge_session_started`) | `agent.conversation.started` remains projected once by the existing workflow/conversation lifecycle bridge |
| ToolCall | `tool_call` (transcript) | ToolGuard.check() before every reported invocation |
| ToolResult | `tool_result` (transcript) | Secret scan via scanValue() before persistence |
| Progress | `progress` (transcript) | Intermediate reasoning, step markers |
| Complete | transcript complete through recorder | `agent.conversation.completed` remains projected once by agent-shim/conversation integration |
| Fail | transcript fail through recorder | `agent.conversation.failed` remains projected once by agent-shim/conversation integration; launcher finally block still runs worktree cleanup |
| Cancel | deferred for preview unless explicit terminal status is added | Timeout maps to fail; a future explicit cancel path should call `recorder.cancel()` and project `agent.conversation.failed` with `terminalReason=cancelled` metadata, without changing the collaboration schema |
| PermissionDenied | `progress` transcript event (`tool_denied`) + PermissionDeniedError | ToolGuard throws, launcher catches, recorder.fail() |

### Request Bridge Schema (OpenSlack -> Aby)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| prompt | string | yes | Task instruction, carried in a JSON bridge envelope over stdin or a request file; avoid env vars for full prompts |
| agentId | string | yes | Agent identifier from registry or subagent discovery |
| runId | string | yes | `RUN-YYYYMMDD-XXXXXXXX` format, correlates all events |
| permissionProfile | object | yes | allowedTools, deniedTools, permissionMode, boolean flags |
| worktreePath | string | no | Isolated git worktree path, set as CWD |
| allowedTools | string[] | no | Derived read-only copy of permissionProfile.allowedTools for bridge convenience; not a second authority |
| deniedTools | string[] | no | Derived read-only copy of permissionProfile.deniedTools for bridge convenience; not a second authority |
| timeout | integer | no | Default 120000ms, from adapter or agent config |
| metadata | object | no | model, correlationId, threadId, budget, resolvedConfig |

Only minimal process metadata should be passed via environment variables, such
as `OPENSLACK_RUN_ID`, `OPENSLACK_AGENT_ID`, and
`OPENSLACK_BRIDGE_PROTOCOL_VERSION`. Full prompts, permission profiles, and
linked-object metadata should stay in the bridge envelope so they can be
validated, size-capped, and redacted consistently.

### Response Bridge Schema (Aby -> OpenSlack)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| data | object | yes | Structured result, validated against schema if provided |
| tokenUsage | integer | no | Actual or estimated token consumption |
| toolStats | object | no | `{ totalCalls, uniqueTools, lastTool }` |
| events | object[] | no | Transcript events for reconciliation |
| exitStatus | object | no | `{ exitCode, signal, timedOut, truncated, durationMs }` |

### Permission Boundary Matrix

**Always Forbidden** (regardless of external runtime capabilities):

- `github.pr.approve`, `github.pr.merge`, `ruleset.bypass`
- `secrets.read`, `agent.registry.write`, `workflow.trust.upgrade`

Current code source: `packages/agent-runtime/src/permissions.ts`
`SUBAGENT_ALWAYS_FORBIDDEN`. If AR-2.5D adds `kernel.constitution.write` or
other policy actions to this set, that must be called out as a security-boundary
change with dedicated tests.

**Pass-Through** (allowed when permission mode permits):

- `Read`, `Grep`, `Glob`, `Find`, `Edit`, `Write`, `Bash`

**Needs Re-Validation** (allowed but must pass OpenSlack-side checks):

- `github.issues.create/write`, `github.prs.create/write`
- `git.branch.create/write`, `git.push`
- `openslack.task.checkout/sync`, `openslack.prms.classify/queue/doctor`
- `openslack.collaboration.recordEvent/createHandoff/recordDecision`

### Worktree Contract

- Launcher creates worktree before spawning Aby.
- `createWorktree(taskId, agentId, runId, rootDir)` produces `branchName='agent/{agentId}/{taskId}/{runId}'`.
- `worktreePath` is set as CWD of spawned process.
- Aby must not create or destroy worktrees, switch branches, access paths outside worktree, modify the main working tree, or push to protected branches.
- After exit: `checkDirty` preserves dirty worktrees as `WorktreeHandoff`, and cleans only clean worktrees.

Preview limitation: this is a contract and evidence guard, not an OS sandbox.
On Windows and ordinary local process execution, OpenSlack cannot guarantee that
a malicious external process cannot touch paths outside CWD. AR-2.5E should
validate configured CWD, preserve dirty worktrees, record reported boundary
violations, and test simulated outside-write attempts. Strong process sandboxing
or filesystem virtualization is a future hardening track, not part of this
preview.

### Gap Analysis

| Capability | Status | Recommendation |
|-----------|--------|---------------|
| Streaming stdout/stderr | gap | Defer. Full capture model for preview; add streaming variant for TUI/chat. |
| AbortSignal / cancel API | gap | Defer. Timeout kill only; add when interactive cancel is needed. |
| Dynamic tool negotiation | partial | Stub. Profile resolved before execution and immutable; add `tool_request` event for negotiation. |
| Bidirectional event bridge | partial | Stub. Add JSONL bridge envelopes over stdout/stderr or an event pipe for mid-run events; do not record collaboration events directly inside agent-runtime. |
| Model selection routing | gap | Defer. Add `OPENSLACK_AGENT_MODEL` env var when multi-model routing is needed. |
| Cost tracking at boundary | partial | Stub. Budget tracked but not enforced mid-run; add mid-run budget signals later. |
| Conversation thread lifecycle | implemented | No gap. Agent-shim/conversation integration projects lifecycle events; bridge must avoid duplicate started/completed/failed events. |
| Secret scanning of output | implemented | No gap. `scanValue()` runs on transcript events, metadata, and messages. |
| Heartbeat / liveness | gap | Defer. Timeout kill only; add heartbeat transcript events for watchdog. |

---

## Integration Phases

### AR-2.5A: Bridge Contract

**Description**: Define the formal interface between OpenSlack agent-runtime and external agent runtimes. Introduces BridgeContract types, capability negotiation protocol, and abstract BridgeAdapter base class. Runtime-agnostic: no Aby-specific types.

**New files**:

- `packages/agent-runtime/src/bridge-contract.ts`
- `packages/agent-runtime/src/__tests__/bridge-contract.test.ts`

**Modified files**:

- `packages/agent-runtime/src/types.ts` - add `BridgeSessionState`, `BridgeErrorKind`, `BridgeCapabilityDescriptor`
- `packages/agent-runtime/src/adapter.ts` - optional `bridgeContract` property on `AgentExecutionAdapter`
- `packages/agent-runtime/src/index.ts` - export new types

**Acceptance criteria**:

- `BridgeContract` interface: `negotiateCapabilities`, `openSession`, `closeSession`, `sendEnvelope`, `healthCheck`
- `BridgeEnvelope<T>` with `correlationId`, `sessionId`, `timestamp`, `protocolVersion`
- Session state machine `idle -> initializing -> ready -> busy -> ready -> shutdown` enforced
- No process spawn and no Aby path lookup in AR-2.5A
- No direct collaboration event recording from agent-runtime
- All existing tests pass unchanged

**Risk zone**: Yellow
**Depends on**: none

---

### AR-2.5B: Aby External Adapter

**Description**: Implement `BridgeProcessAdapter` for external runtimes and `FakeBridgeAdapter` for CI. Process lifecycle management, envelope serialization, timeout/retry. Generic over any BridgeContract-compliant external process.

**New files**:

- `packages/agent-runtime/src/bridge-adapter.ts`
- `packages/agent-runtime/src/__tests__/bridge-adapter.test.ts`

**Modified files**:

- `packages/agent-runtime/src/index.ts` - export `BridgeProcessAdapter`, `FakeBridgeAdapter`
- `packages/agent-runtime/src/external-command-adapter.ts` - JSDoc note about `BridgeProcessAdapter` successor

**Acceptance criteria**:

- `BridgeProcessAdapter` implements `AgentExecutionAdapter` with bridge handshake
- `FakeBridgeAdapter` produces deterministic responses for given prompts
- Child process crash -> fatal error; timeout -> `BridgeErrorKind.timeout`
- All adapter interactions recorded via `recorder.progress` with `bridge_` prefix
- Process spawn is a runtime-owned adapter capability, not a delegated subagent `Bash` tool call. A read-only Aby bridge run must not require `Bash` in `permissionProfile.allowedTools` merely to start the external process.
- Actual bridge-reported tool calls still pass `ToolGuard` / `BridgePermissionGuard` before being accepted into transcript or run state.
- Aby root is read only from explicit local configuration (`OPENSLACK_ABY_ROOT` or `.openslack.local` config). Source code and CI must not hard-code `D:\Users\Administrator\Desktop\Coding Task\Aby`.
- Existing test suite passes

**Risk zone**: Yellow
**Depends on**: AR-2.5A

---

### AR-2.5C: Lifecycle Mapping

**Description**: Map BridgeContract session events to recorder/transcript state and the existing workflow/conversation projection layer. Bridge session start/complete/fail must not directly call collaboration `recordEvent()` from agent-runtime; lifecycle visibility should continue through agent-shim and conversation integrations so every run emits one coherent started/completed/failed sequence.

**New files**:

- `packages/agent-runtime/src/bridge-lifecycle.ts`
- `packages/agent-runtime/src/__tests__/bridge-lifecycle.test.ts`

**Modified files**:

- `packages/agent-runtime/src/bridge-adapter.ts` - inject `BridgeLifecycleMapper`
- `packages/agent-runtime/src/launcher.ts` - `bridge_lifecycle_complete` progress event
- `packages/agent-runtime/src/types.ts` - `BridgeSessionSummary` type
- `packages/agent-runtime/src/index.ts` - export new types
- `packages/workflows/src/agent-shim.ts` - only if existing lifecycle metadata needs bridge `terminalReason` / `resultSummary` fields

**Acceptance criteria**:

- `onSessionOpen` -> transcript progress `bridge_session_started`
- `onSessionClose` -> transcript progress `bridge_session_completed` plus `BridgeSessionSummary`
- `onSessionError` -> transcript progress `bridge_session_failed` plus error details
- Workflow/conversation projection still emits at most one `agent.conversation.started` and one terminal lifecycle event for each run
- Graceful degradation when event emitter/projection is not provided
- All bridge transcript events include `correlationId -> runId`

**Risk zone**: Yellow
**Depends on**: AR-2.5B

---

### AR-2.5D: Permission Boundary

**Description**: Enforce OpenSlack permission boundaries at the bridge interface. `BridgePermissionGuard` wraps every outbound request and inbound response, strips denied tools, and rejects forbidden action results.

**New files**:

- `packages/agent-runtime/src/bridge-permission-guard.ts`
- `packages/agent-runtime/src/__tests__/bridge-permission-guard.test.ts`

**Modified files**:

- `packages/agent-runtime/src/bridge-adapter.ts` - inject `BridgePermissionGuard`
- `packages/agent-runtime/src/permissions.ts` - export `SUBAGENT_ALWAYS_FORBIDDEN`
- `packages/agent-runtime/src/index.ts` - export guard

**Acceptance criteria**:

- `filterOutboundTools` removes `SUBAGENT_ALWAYS_FORBIDDEN` from capability negotiation
- `validateInboundResponse` rejects responses from denied tools
- `canApprovePR`, `canMerge`, `canReadSecrets`, and `canBypassRulesets` always false
- Guard operates independently of external runtime cooperation
- Double enforcement: `ToolGuard` per call plus `BridgePermissionGuard` at envelope boundary
- Denied inbound tool events are recorded as denial evidence, but their payloads are not persisted until redaction/secret scanning succeeds
- If forbidden actions are promoted into `@openslack/kernel`, the PR is Red by path and must use the full human-approval gate. If AR-2.5D only exports and tests the existing agent-runtime set, PRMS path classification may be Yellow, but it should still be handled as security-sensitive.

**Risk zone**: Red warning (touches permission enforcement; human approval required)
**Depends on**: AR-2.5B

---

### AR-2.5E: Worktree Contract

**Description**: Bridge adapter receives worktree path from launcher and communicates it via session config envelope. Post-session boundary validation records evidence about CWD, preserved dirty state, and bridge-reported outside-root attempts. This is not a malicious-process sandbox.

**New files**:

- `packages/agent-runtime/src/bridge-worktree-guard.ts`
- `packages/agent-runtime/src/__tests__/bridge-worktree-guard.test.ts`

**Modified files**:

- `packages/agent-runtime/src/bridge-adapter.ts` - worktree config in session init, post-session validation
- `packages/agent-runtime/src/bridge-contract.ts` - `BridgeWorktreeConfig` type
- `packages/agent-runtime/src/index.ts` - export guard

**Acceptance criteria**:

- Validate CWD is exactly the launcher-provided worktree path when worktree isolation is active
- Bridge envelope includes `allowedRoot=worktreePath` and rejects bridge-reported file/tool events outside that root
- Post-run dirty check preserves dirty worktree as `WorktreeHandoff` and cleans only clean worktrees
- Simulated outside-root event -> run fails with `worktree_boundary_violation` transcript evidence
- No new collaboration/governance event type unless a later PR explicitly changes the collaboration schema
- No worktree -> guard is no-op
- Existing worktree tests pass unchanged

**Risk zone**: Yellow
**Depends on**: AR-2.5B, AR-2.5D

---

### AR-2.6: MCP Runtime Scope

**Description**: Bridge adapter discovers MCP servers from launcher config, includes them in the session init envelope, and validates required MCP availability before session start. External runtime reports which MCP servers it provides. MCP tool namespacing uses `mcp.<server>.<tool>`.

**New files**:

- `packages/agent-runtime/src/bridge-mcp-scope.ts`
- `packages/agent-runtime/src/__tests__/bridge-mcp-scope.test.ts`

**Modified files**:

- `packages/agent-runtime/src/bridge-contract.ts` - `BridgeMcpServerDescriptor` type
- `packages/agent-runtime/src/bridge-adapter.ts` - pass `availableMcpServers`, validate before start
- `packages/agent-runtime/src/launcher.ts` - forward `availableMcpServers` to bridge adapter
- `packages/agent-runtime/src/index.ts` - export MCP scope

**Acceptance criteria**:

- `negotiateServers` returns available and missing MCP servers
- MCP tool namespacing `mcp.<server>.<tool>` validated against permission profile
- Missing required servers -> `AgentUnavailableError` before session start
- `FakeBridgeAdapter` uses an injected `availableMcpServers` list. It must not report every requested server as available by default, because that would hide fail-closed behavior in CI.
- Agent-specific MCP server bootstrap/cleanup remains declaration/evidence only in AR-2.6; no Aby MCP client internals are imported.
- Empty MCP list -> no-op

**Risk zone**: Yellow
**Depends on**: AR-2.5A, AR-2.5B

---

### AR-2.7: Workflow/Conversation Enablement

**Description**: Wire bridge adapter into workflow runtime and conversation system. Agent-shim uses bridge when configured, conversation thread creation, results flow back to workflow steps, and existing CLI flows can select bridge mode through configuration. No new top-level command is introduced.

**New files**:

- `packages/agent-runtime/src/bridge-factory.ts`
- `packages/agent-runtime/src/__tests__/bridge-factory.test.ts`

**Modified files**:

- `packages/agent-runtime/src/launcher.ts` - `bridgeMode` option in `LauncherOptions`
- `packages/agent-runtime/src/index.ts` - export `BridgeFactory`, `createBridgeAdapter`, `BridgeMode`
- `packages/workflows/src/agent-shim.ts` - optional `bridgeMode` in `AgentOptions`
- `packages/workflows/src/agent-resolver.ts` - `runtime: 'aby_assistant'` -> bridge hint

**Acceptance criteria**:

- `BridgeFactory.create('fake'|'process'|'local'|'external-command')` returns correct adapter
- Unknown `bridgeMode` -> descriptive error
- Workflow dry-run with `FakeBridgeAdapter` produces correct results
- Agent resolver maps an explicit bridge hint, for example `runtime: 'aby_assistant'` or `provider: 'aby'` depending on the final registry schema, to bridge config without breaking existing subagent parsing
- BridgeFactory `fake` is the CI default only when bridge mode is explicitly enabled. It must not replace the current `LocalExecutionAdapter` default for ordinary `ctx.agent()` calls.
- All existing workflow runtime tests pass

**Risk zone**: Yellow
**Depends on**: AR-2.5C, AR-2.5D, AR-2.5E, AR-2.6

---

## Scope Boundaries (Explicitly Not Doing)

- No Aby-specific imports, SDK calls, or internal Aby API usage
- No AppState, AppStateStore, or any Aby global state store
- No React, Ink, or UI components
- No tmux, screen, or terminal multiplexing
- No remote CCR (Claude Code Runtime) or cloud API calls
- No modification to existing adapter behavior
- No new top-level CLI commands
- No changes to collaboration layer event schema
- No secret/credential handling in the bridge
- No streaming response support in preview phase
- No AbortController/cancellation beyond timeout kill
- No changes to `@openslack/kernel` risk zones or constitution rules

---

## FakeBridgeAdapter Design (CI Without Real Aby)

The `FakeBridgeAdapter` is the cornerstone of CI:

1. Implements `AgentExecutionAdapter` plus `BridgeContract` in memory, with no process spawn.
2. Provides deterministic responses: same prompt-pattern matching as `LocalExecutionAdapter`, wrapped in `BridgeEnvelope` format.
3. Mirrors real session lifecycle: `idle -> ready -> busy -> ready -> shutdown`.
4. Simulates tools while respecting `ToolGuard` and `BridgePermissionGuard` exactly.
5. Simulates worktree by recording worktree path without writing files.
6. Simulates MCP by reporting only injected `availableMcpServers` as available; missing required servers remain a fail-closed test case.
7. Supports configurable `responseDelayMs`, `shouldFail`, and `customResponseTemplate`.
8. Uses `BridgeFactory.create('fake')` as the default for bridge-enabled CI/dry-run/dev only, never the global `ctx.agent()` default.

---

## Fail-Closed Guarantees

1. `BridgePermissionGuard` denies all tools not explicitly allowed; empty intersection -> run fails.
2. Session state machine rejects invalid transitions -> error -> run fails.
3. Worktree boundary violations detected -> run fails with transcript/run-state evidence.
4. Child process crash -> fatal bridge error, no silent retry.
5. Missing required MCP servers -> `AgentUnavailableError` before session start.
6. Malformed envelopes rejected -> run fails.
7. Session errors always recorded in transcript, never silently swallowed.
8. Handshake timeout / connection refused -> run fails with descriptive error, no fallback to local.
9. `SUBAGENT_ALWAYS_FORBIDDEN` enforced at two levels: `ToolGuard` per-call plus `BridgePermissionGuard` envelope boundary.
10. All bridge operations pre-flight recorded in transcript.

Note: item 3 records governance-relevant evidence in the run transcript and run
metadata during this preview. It should not create a new collaboration event type
unless a dedicated schema-change PR is opened.

---

## Estimated New Tests

Approximately 95 new tests across 7 test files, bringing agent-runtime from 73 to roughly 168 tests.

---

## PR Strategy

Following the AR-2 pattern, each phase is a separate PR:

| PR | Branch | Phase | Risk Zone |
|----|--------|-------|-----------|
| 1 | `phase-ar25a/bridge-contract` | AR-2.5A Bridge Contract | Yellow |
| 2 | `phase-ar25b/bridge-adapter` | AR-2.5B External Adapter | Yellow |
| 3 | `phase-ar25c/bridge-lifecycle` | AR-2.5C Lifecycle Mapping | Yellow |
| 4 | `phase-ar25d/bridge-permission-guard` | AR-2.5D Permission Boundary | Red |
| 5 | `phase-ar25e/bridge-worktree-guard` | AR-2.5E Worktree Contract | Yellow |
| 6 | `phase-ar26/bridge-mcp-scope` | AR-2.6 MCP Runtime Scope | Yellow |
| 7 | `phase-ar27/bridge-factory-workflow` | AR-2.7 Workflow Enablement | Yellow |

Merge order: 2.5A -> 2.5B -> {2.5C, 2.5D} -> 2.5E -> 2.6 -> 2.7.
AR-2.5D requires human approval before merge.
