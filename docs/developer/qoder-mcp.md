# Qoder Work MCP integration

OpenSlack exposes a local, read-only Model Context Protocol server for Qoder Work:

```bash
bun run openslack mcp serve --stdio
```

The integration is an Operator-module frontend. The CLI composition root supplies the same
instance-scoped Operator context used by the CLI, TUI, and chat frontend. `apps/mcp` imports
package APIs and never imports private CLI files.

## Authority boundary

The QW2 server is projection-only:

- stdio is the only transport; it opens no listening socket;
- the tool catalog is explicit, frozen after construction, and contains exactly nine tools;
- every input object rejects unknown properties and applies field, count, text, timeout, evidence,
  and output-size bounds;
- stdout is reserved for MCP JSON-RPC frames; diagnostics use stderr;
- structured output and the JSON text content are produced from the same redacted object;
- reads do not create pending plans or initialize missing local-state directories;
- no ActionRegistry entry is exported automatically.

The server never exposes arbitrary shell/command execution, workspace indexing, PR watch, repair,
policy or permission writes, GitHub approval, direct merge, or any other mutation.

The exact catalog is:

```text
openslack_get_executive_overview
openslack_list_work_items
openslack_get_work_room
openslack_get_activity
openslack_get_workflow_progress
openslack_get_pr_readiness
openslack_list_pending_approvals
openslack_get_business_outcomes
openslack_get_notification_status
```

`openslack_list_pending_approvals` is a read projection. It returns three separate arrays:
OpenSlack plan confirmations, workflow trust/effect gates, and GitHub human-review requirements.
Qoder MCP permission is not an OpenSlack confirmation, and neither is a GitHub approval.

## Add the connector to Qoder Work

Qoder Work supports local MCP servers launched with stdio. Open
**Extensions → Connectors → + Add → Paste JSON Config**, then adapt one of:

- `templates/qoder-skill/examples/mcp-config.windows.json`
- `templates/qoder-skill/examples/mcp-config.wsl.json`
- `templates/qoder-skill/examples/mcp-config.unix.json`

The examples preserve each workspace path as one JSON argument, including paths with spaces. They
contain no credential values. Keep permission prompts enabled and authorize only the nine names
above; do not configure a wildcard allow rule.

After adding or changing the connector, start a new Qoder Work conversation so it discovers the
current tool list. Qoder's public connector instructions are:
<https://docs.qoder.com/qoderwork/connectors>.

## Qualification

Local PR evidence and Qoder desktop evidence are different gates.

Local:

```bash
bunx vitest run packages/qoder-adapter/src/__tests__
bunx vitest run apps/mcp/src/__tests__
bunx vitest run apps/cli/src/__tests__/mcp-command.test.ts
bunx tsc --noEmit -p packages/qoder-adapter/tsconfig.json
bunx tsc --noEmit -p apps/mcp/tsconfig.json
bunx tsc --noEmit -p apps/cli/tsconfig.json
```

The MCP Inspector gate must complete `initialize`, `tools/list`, and one call to each of the nine
tools. `tools/list` must equal the frozen catalog exactly. Any missing local evidence is returned as
`blocked` or `unknown`; it is not invented.

Qoder desktop qualification separately repeats initialization, listing, and all nine calls with
permission prompts enabled. Only that evidence supports `QODER_VERIFIED`; local tests alone support
`LOCAL_PASS`.

## Tool-specific evidence limits

- PR readiness requests live, strict, current-head GitHub/PRMS evidence. Missing authentication or
  stale evidence fails closed.
- Business outcomes are bound by default to QW1 `buildBusinessOutcomeProjection`. The default
  query is a bounded 24-hour snapshot of the existing Collaboration event store; callers may
  provide explicit `from`, `to`, and `scenarioId` bounds. Composition tests and embedding clients
  may inject an alternative reader without changing the tool contract.
- Notification status reports configured routes and payload-blind local counts. `accepted` never
  means `delivered`; remote delivery remains `unknown` without typed reconciliation evidence.
- Existing Collaboration events, plans, workflow runs, handoffs, and decisions are read only when
  their stores already exist. A status query never materializes an empty store.

## Troubleshooting

- `OPENSLACK_MCP_START_FAILED`: run the command directly and inspect stderr; stdout intentionally
  contains no diagnostics.
- `INVALID_TOOL_INPUT`: remove unknown fields or bring a value within the catalog bounds.
- `READ_PROJECTION_FAILED`: the requested structured source could not be read safely.
- `READ_PROJECTION_TOO_LARGE`: narrow the time window or item limit.

No troubleshooting step should replace the connector command with a generic shell MCP server.
