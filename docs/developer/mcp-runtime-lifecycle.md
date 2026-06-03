# MCP Runtime Lifecycle Boundary

OpenSlack AR-5 adds MCP status UX for Aby-backed agent runs. It does not make
OpenSlack the MCP client runtime.

## Current Boundary

OpenSlack owns:

- required MCP server descriptors from agent configuration
- available MCP server descriptors recorded in run/start or bridge progress events
- fail-closed checks when required servers are missing before launch
- MCP tool namespace normalization such as `mcp__github__search` to `mcp.github.search`
- transcript evidence for MCP tool request and response events

Aby owns:

- MCP server bootstrap
- MCP client session creation
- server authentication and secret-bearing config
- tool registry loading inside the Aby runtime
- MCP session cleanup

OpenSlack must not receive inline secret-bearing MCP config from Aby or local
identity files. Bridge child processes only receive the explicit safe env key
allowlist; runtime scope travels through the Agent Run Bridge request and
transcript evidence.

## Transcript Evidence

The AR-5 status command reads existing run transcripts:

```powershell
openslack agent-runtime mcp status --provider aby --run <runId>
```

It extracts:

- `start` event `requiredMcpServers`
- `start` event `mcpServers`
- `progress` event `bridge_mcp_availability`
- `tool_call` and `tool_result` events whose tool name normalizes to
  `mcp.<server>.<tool>`

Missing required servers and invalid tool namespaces are reported as `FAIL`.

## Future AR-6 Design Questions

AR-6 can add full lifecycle evidence without changing the ownership boundary:

- MCP handshake evidence: record server name, version, and capability summary,
  never secrets.
- Tool registry import: decide whether OpenSlack stores only a summary or a
  full normalized tool descriptor list.
- Session cleanup: record cleanup success/failure and timeout classification.
- Error taxonomy: distinguish `mcp_server_missing`, `mcp_handshake_failed`,
  `mcp_tool_unavailable`, `mcp_tool_failed`, and `mcp_cleanup_failed`.

Until AR-6 is implemented, product copy should say:

> OpenSlack validates MCP descriptors and namespaces; Aby owns MCP client
> lifecycle.
