# Aby Integration Guide

OpenSlack can launch Aby as a configurable external agent runtime through the
generic Agent Run Bridge protocol. Aby is not bundled with OpenSlack and is not
the default backend. OpenSlack still owns governance, permissions, run storage,
transcripts, worktree lifecycle, and PRMS decisions.

## Prerequisites

- A local Aby checkout that contains:
  - `src/sidecar/entrypoints/runEntrypoint.ts`
  - `src/sidecar/entrypoints/agentRunBridge.ts`
- `bun` available on `PATH`.
- An OpenSlack agent whose resolved registry config sets either:
  - `runtime: "aby_assistant"`
  - `runtime: "aby"`
  - `provider: "aby"`

## Configure Aby Root

Use one of these configuration paths.

Environment variable:

```powershell
$env:OPENSLACK_ABY_ROOT="D:\path\to\Aby"
bun run openslack agent-runtime doctor --provider aby
```

Local config file:

```json
{
  "aby": {
    "root": "D:\\path\\to\\Aby",
    "command": "bun",
    "timeoutMs": 120000,
    "env": {
      "AGENT_RUN_BRIDGE_RUNNER": "real"
    }
  }
}
```

Save that JSON as `.openslack.local/agent-runtime.json`. The
`OPENSLACK_ABY_ROOT` environment variable takes precedence over the file.

Only safe `AGENT_RUN_*` bridge variables are forwarded to the child process.
Prompts, permission profiles, MCP descriptors, secrets, and task bodies are sent
inside the JSONL bridge request, not through environment variables.

## Agent Registry Hint

An Aby-backed agent must resolve to a process bridge runtime. A registry entry
can use a vendor runtime hint:

```yaml
vendor:
  provider: "aby"
  runtime: "aby_assistant"
  model: "default"
```

The workflow resolver maps Aby runtime hints to `bridgeMode: "process"`.

## Run A Smoke Check

First diagnose configuration:

```powershell
bun run openslack agent-runtime doctor --provider aby
```

Expected passing output includes:

```text
Provider: aby
Status: PASS
runEntrypoint.ts: ...
agentRunBridge.ts: ...
```

Then use one of the existing agent entry points:

```powershell
bun run openslack conversation start --title "Aby bridge smoke"
bun run openslack conversation send <threadId> "@anthropic_architect_aby inspect this repository"
```

For workflows, use the existing workflow `agent(...)` step with
`agentType: "anthropic_architect_aby"`.

Developers can also run the opt-in real bridge smoke test:

```powershell
$env:OPENSLACK_RUN_REAL_ABY_SMOKE="1"
$env:OPENSLACK_ABY_ROOT="D:\path\to\Aby"
bun test packages/agent-runtime/src/__tests__/aby-e2e.test.ts
```

This test is skipped by default so CI does not require a local Aby checkout.

## Evidence To Inspect

After a run, the same run ID should be visible in:

- `.openslack.local/agents/runs/<runId>/run.json`
- `.openslack.local/agents/runs/<runId>/metadata.json`
- `.openslack.local/agents/runs/<runId>/transcript.jsonl`
- The conversation `agent_response` message metadata
- Collaboration activity and room projections
- TUI AgentRun detail

## Common Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `No Aby root configured` | Neither `OPENSLACK_ABY_ROOT` nor `.openslack.local/agent-runtime.json` has a root | Set one explicit local path |
| `missing runEntrypoint.ts` | Aby checkout does not expose the sidecar launcher | Update Aby or point to the correct checkout |
| `missing agentRunBridge.ts` | Aby checkout does not expose the generic bridge entrypoint | Update Aby to the L3 bridge version |
| `Rejected unsafe keys` | Config tried to forward secret-like env keys | Remove those keys; do not send task content or secrets through env |
| `permission_denied` | Aby requested a forbidden tool or approval flow | Adjust the OpenSlack permission profile; OpenSlack remains final policy authority |
| `Bridge response timed out` | Aby process did not complete within the configured timeout | Increase `timeoutMs` or inspect Aby stderr logs |

## Boundaries

This integration does not import Aby internals into OpenSlack and does not
replicate Aby AppState, React Tool UI, tmux/iTerm teammate execution, remote CCR,
or Perfetto telemetry. Those capabilities remain outside this bridge surface.
