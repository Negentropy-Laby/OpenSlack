# Qoder Work MCP integration

OpenSlack exposes a local Model Context Protocol server for Qoder Work:

```bash
bun run openslack mcp serve --stdio
```

The stock CLI composition is projection-only and advertises exactly 12 read-only tools. An
embedding may opt into a nominal agent-bound governed profile with 16 tools, or a separately
human-attested profile with 17. The CLI composition root supplies the same instance-scoped OpenSlack
context used by the CLI, TUI, and chat frontend. `apps/mcp` imports package APIs and never imports
private CLI files, executes CLI text, or parses CLI stdout.

This document describes the current local build. It does not claim that a Qoder Work desktop build
has completed qualification or that `QODER_VERIFIED` has been reached.

## Authority boundary

- STDIO is the only production transport; it opens no listening socket.
- Every catalog is nominal and frozen after construction. Valid production counts are read-only
  12, agent-governed 16, and separately human-attested 17.
- A separately composed local demo profile may add only `openslack_demo_reset` to one valid
  production profile.
- Every input rejects unknown properties and applies field, count, depth, timeout, evidence, and
  output-size bounds.
- Every advertised tool returns `openslack.mcp_result.v2`.
- Stdout is reserved for MCP JSON-RPC frames; diagnostics use stderr.
- Structured output and JSON text content derive from the same sanitized object.
- Reads do not create pending plans or initialize missing graph/authority state.
- No Operator `ActionRegistry` entry is exported automatically.

No profile exposes arbitrary shell/command execution, workspace indexing, PR watch, repair, policy
or permission write, GitHub approval, or direct merge.

Qoder MCP permission is not OpenSlack confirmation, OpenSlack workflow approval, Workflow-Trust,
or GitHub human review.

## Exact production catalog

The exact 12-tool production catalog is:

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
openslack_list_scenarios
openslack_query_graph
openslack_explain_graph
```

`openslack_list_pending_approvals` is a read projection. It returns OpenSlack plan confirmations,
workflow trust/effect gates, and GitHub human-review requirements as distinct state. It cannot
decide any of them.

The three organization-runtime reads are:

| Tool                       | Current behavior                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `openslack_list_scenarios` | Lists only locked Scenario Definitions accepted by the sealed host-owned catalog                                     |
| `openslack_query_graph`    | Queries one current Organization Graph snapshot with query-bound pagination and strict traversal/output limits       |
| `openslack_explain_graph`  | Explains one node or edge using bounded authority, provenance, completeness, and optional relationship-path evidence |

Graph query ceilings are depth 3, 200 nodes, 500 edges, and 512 KiB. A pagination cursor is opaque
and bound to the normalized query; changing the query invalidates the cursor.

## Governed mutation profiles

An embedding opts into the agent-governed profile only by supplying the nominal
`OpenSlackGovernedMutationPort`. It appends exactly:

```text
openslack_preview_scenario
openslack_preview_workflow
openslack_confirm_plan
openslack_cancel_plan
```

Preview compiles business input through a host-owned Scenario or sealed Workflow compiler,
persists one immutable canonical plan, and returns a root-only one-time confirmation capability.
Only the capability hash is stored. Confirmation revalidates actor, workspace, expiry, plan,
source, permission, action catalog, executor binding, build, and process snapshots before one
atomic execution claim. A timeout after that claim is reconciliation-required; it is never
reported as safe to retry.

The human-attested profile additionally requires a nominal `OpenSlackWorkflowApprovalPort` backed
by the isolated v2 workflow-effect approval store and a separately authenticated host attestation
port. It appends exactly:

```text
openslack_decide_workflow_approval
```

For every call, the host authenticator receives the exact run ID, approval ID, decision, raw reason
for human display, reason hash, required capability, business correlation, and approval expiry.
Only a matching short-lived attestation can decide the existing OpenSlack workflow effect. Qoder
permission and client-supplied identity are not authority. The tool cannot create a GitHub review.
The v2 approval record is authoritative and keeps the workflow's original business correlation
ID. Its deterministic audit projection is durable: a terminal CAS records `pending`, and a
successful Collaboration append advances it to `recorded`. Projection failure preserves the
terminal decision and retries only that audit event; a second business decision remains invalid.
The audit sink binds one verified O_APPEND descriptor at composition time and never reopens the
event log by path, so a later directory replacement cannot redirect a successful audit write.

## Demo-only catalog

An embedding or test composition may append one tool only when it sets `demoMode: true` and
injects a port created by `createLocalDemoResetPort`:

```text
openslack_demo_reset
```

The factory binds an existing, canonical, stable-identity directory below
`.openslack.local/demo/<fixture>`, rejects symlink/reparse components and cross-workspace reuse, and
passes the host callback only a frozen `{ root, signal, deadlineAt }` invocation. The host callback
must limit every effect to that root and honor abort. A deadline returns
`DEMO_RESET_RECONCILIATION_REQUIRED` with `data.outcome: reconciliation_required`; it never claims
that a timed-out effect did not occur. The tool returns `authority.mode: governed_mutation`, is not
a QG5 mutation surface, and never deletes or rewrites live GitHub objects.

The stock `openslack mcp serve --stdio` command injects neither mutation nor reset ports and
therefore advertises only the production 12. Exact demo counts are 13, 17, or 18, corresponding to
the 12, 16, or 17 production profile plus reset. Any other count or ordering is invalid.

## Result envelope

All tools advertised to MCP clients return:

```text
schema: openslack.mcp_result.v2
correlationId
status
summary
authority.mode / authority.sources / authority.observedAt
governance
nextActions
evidenceRefs
data or bounded error
```

The nine foundation handlers retain the frozen v1 contract internally so their business behavior
can be upgraded compatibly. The server performs that conversion before producing either structured
or text MCP content. Qoder clients never receive a mixture of v1 and v2 within one catalog.

Every read result uses `authority.mode: projection`; mutations use `governed_mutation`. The server
generates the business correlation before compilation. Confirmation and decision results recover
that stored business correlation rather than replacing it with an MCP transport-call ID. The
client cannot supply an actor, authority, capability, approval source, workspace root, correlation
ID, plan step, or command through tool input.

## Graph fail-closed behavior

Graph reads never synthesize an empty authoritative graph.

| Condition                                              | Result                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| No current snapshot for the scenario instance          | `status: blocked`, `governance.blocker: SOURCE_EVIDENCE_UNAVAILABLE` |
| Snapshot exceeds the configured freshness window       | `status: blocked`, `governance.blocker: SOURCE_EVIDENCE_STALE`       |
| Cursor does not belong to the current normalized query | `status: failed`, `error.code: READ_PROJECTION_FAILED`               |
| Result exceeds the protocol output ceiling             | `status: failed`, `error.code: READ_PROJECTION_TOO_LARGE`            |
| Input exceeds a closed tool schema bound               | MCP invalid-params error with `INVALID_TOOL_INPUT` semantics         |

Missing or stale graph evidence does not initialize a store, create a scenario, or become a
successful empty dataset. Narrowing a query is appropriate for truncation or size limits; it does
not repair missing or stale authority evidence.

## Explicit local graph snapshot build

The side-effecting CLI importer is separate from the frozen MCP catalog:

```bash
bun run openslack graph snapshot build \
  --scenario software-delivery \
  --from ./evidence/software-delivery.json \
  --scenario-instance <scenario-instance-id> \
  --format json
```

Use exactly one of `--from <path>` or `--from-stdin`. Both paths stop at the Software Delivery
4 MiB source ceiling before parsing. File input requires a real regular file, rejects symlink or
reparse resolution, and verifies path and handle identity before, during, and after the bounded
read. The package service then uses strict JSON with explicit depth, node, and string ceilings,
the registered Software Delivery validator/projector, and the existing atomic `LocalGraphStore`.
It does not call GitHub or assemble live evidence.

The first publication omits `--expected-cursor` and succeeds only when no current pointer exists.
Every replacement must pass the exact current cursor:

```bash
bun run openslack graph snapshot build \
  --scenario software-delivery \
  --from-stdin \
  --scenario-instance <scenario-instance-id> \
  --expected-cursor <current-cursor> \
  --format json
```

The store root is fixed to `.openslack.local/graph` in the current workspace. There is no force
or arbitrary-store option. A missing, stale, or concurrently changed cursor fails with
`GRAPH_STORE_CURSOR_CONFLICT`; lock contention remains `GRAPH_STORE_LOCKED`. If publication reports
`GRAPH_STORE_COMMITTED_UNVERIFIED`, read the current pointer before retrying because the cursor may
already be committed.

`openslack_query_graph` and `openslack_explain_graph` remain read-only and side-effect-free. They
never invoke this command, read its stdin, or silently build missing graph evidence. A successful
local import and official MCP SDK readback are `LOCAL_PASS` evidence only and do not establish
`QODER_VERIFIED`.

## Configure the Qoder Work desktop connector

Open **Extensions → Connectors → + Add → Paste JSON Config**, then adapt one of:

- `templates/qoder-skill/examples/mcp-config.windows.json`
- `templates/qoder-skill/examples/mcp-config.wsl.json`
- `templates/qoder-skill/examples/mcp-config.unix.json`

The examples preserve a workspace path containing spaces as one JSON argument and contain no
credential values. Keep permission prompts enabled, authorize only the exact names advertised by
the selected 12, 16, or 17 profile, and do not add a wildcard allow rule.

After adding or changing the connector, start a new Qoder Work conversation so it discovers the
current catalog. Qoder's connector documentation is:
<https://docs.qoder.com/qoderwork/connectors>.

## Install and discover the Skill

The Qoder Work desktop application and qodercli use different discovery roots. Installing into one
does not install into or qualify the other.

### Qoder Work desktop

Desktop Skills live at:

```text
~/.qoderwork/skills/openslack-organization-control/SKILL.md
```

From the checked-in Skill directory:

```bash
./install/install.sh
```

```powershell
.\install\install.ps1
```

Start a new desktop conversation after installation or update. Verify the Skill through the
desktop Skills page or `/` chooser, then exercise automatic, `/`, and explicit-name invocation
against the exact production MCP catalog.

Official Qoder Work Skill documentation:
<https://docs.qoder.com/qoderwork/skills>.

### qodercli

qodercli user Skills live at:

```text
~/.qoder/skills/openslack-organization-control/SKILL.md
```

Project Skills live at:

```text
<project>/.qoder/skills/openslack-organization-control/SKILL.md
```

Project scope overrides a same-named user Skill. Use the installer's explicit target override:

```bash
./install/install.sh --target-root "$HOME/.qoder/skills"
./install/install.sh --target-root "/absolute/project/.qoder/skills"
```

```powershell
.\install\install.ps1 -TargetRoot "$env:USERPROFILE\.qoder\skills"
.\install\install.ps1 -TargetRoot "C:\absolute\project\.qoder\skills"
```

New qodercli sessions discover Skills at startup. In an existing session, run `/skills reload`,
then use `/skills` to confirm the name and source scope. Skill discovery alone does not configure
the OpenSlack MCP server and does not qualify the Qoder Work desktop path.

Official qodercli Skill documentation:
<https://docs.qoder.com/en/cli/Skills>.

## Local validation

Repository validation:

```bash
bunx vitest run packages/qoder-adapter/src/__tests__
bunx vitest run apps/mcp/src/__tests__
bunx vitest run apps/cli/src/__tests__/mcp-command.test.ts
bunx tsc --noEmit -p packages/qoder-adapter/tsconfig.json
bunx tsc --noEmit -p apps/mcp/tsconfig.json
bunx tsc --noEmit -p apps/cli/tsconfig.json
```

Production MCP Inspector validation must:

1. complete `initialize`;
2. prove `tools/list` equals the selected exact 12, 16, or 17 names in documented order;
3. call every advertised tool with bounded inputs, using explicit confirmation only for the exact
   returned plan;
4. validate every structured result against `openslack.mcp_result.v2`;
5. prove text content is the JSON encoding of the same sanitized result;
6. exercise unavailable and stale graph evidence as the explicit blocked states above.

A separate injected-demo validation must prove the selected production profile plus exactly one
final reset tool, bounded fixture-root behavior, and a v2 result. Demo evidence never replaces
production-profile evidence.

These checks support local build acceptance only. They do not establish `QODER_VERIFIED`.

## Current-build acceptance record

Before making any Qoder qualification claim, create a credential-free record bound to the exact
build under test. It must include:

- surface: `qoder-work-desktop` or `qodercli`;
- Qoder Work build or qodercli version, operating system, and architecture;
- OpenSlack commit and whether the checkout had local changes;
- MCP transport and credential-free connector configuration hash;
- Skill source path, scope, and `SKILL.md` hash;
- initialization and completion timestamps;
- exact `tools/list` in order and expected profile (`production-12`, `agent-16`, `human-17`, or the
  corresponding local-demo profile);
- one bounded call result for every advertised tool, including schema and status;
- missing-graph and stale-graph fail-closed results;
- permission-prompt state and confirmation that no wildcard tool grant was used;
- automatic, `/`, and explicit Skill discovery/invocation evidence for the tested surface;
- redaction confirmation and absence of credentials, tokens, or raw vendor bodies;
- unresolved blockers and all explicit unknowns.

Qoder Work desktop and qodercli records are separate. A qodercli `/skills` result cannot prove
desktop discovery, desktop connector permissions, or desktop MCP execution. A desktop record can
support `QODER_VERIFIED` only when the named current desktop build exercises the production 12-tool
MCP and Skill path with all required bounded evidence. No such claim is made by this document.

## Tool-specific evidence limits

- PR readiness requests live, strict, current-head GitHub/PRMS evidence. Missing authentication or
  stale evidence fails closed.
- Business outcomes use the evidence-labelled `BusinessOutcomeProjection`. Configured estimates
  remain estimates, and unavailable metrics remain unknown.
- Notification status reports configured routes and payload-blind local counts. `accepted` never
  means `delivered`; remote delivery remains unknown without typed reconciliation evidence.
- Scenario listing contains accepted locked definitions, not proof that an instance is active.
- Graph query/explain require a current stored snapshot; missing or stale snapshots block.
- Existing events, plans, workflow runs, handoffs, and decisions are read only when their stores
  already exist. A status query never materializes an empty store.

## Troubleshooting

- `OPENSLACK_MCP_START_FAILED`: run the command directly and inspect stderr; stdout intentionally
  contains no diagnostics.
- `INVALID_TOOL_INPUT`: remove unknown fields or bring a value within the advertised schema.
- `SOURCE_EVIDENCE_UNAVAILABLE`: produce or select a current graph snapshot; do not infer empty
  authority state.
- `SOURCE_EVIDENCE_STALE`: rebuild the graph from current bounded source evidence.
- `READ_PROJECTION_FAILED`: verify the requested structured source or restart pagination with the
  same normalized query.
- `READ_PROJECTION_TOO_LARGE`: narrow time, scenario, traversal, filter, node, or edge bounds.
- `GOVERNED_MUTATION_RECONCILIATION_REQUIRED`: inspect the durable plan; do not confirm it again.
- `WORKFLOW_APPROVAL_RECONCILIATION_REQUIRED`: read the durable approval before another decision.
- `WORKFLOW_APPROVAL_AUDIT_PROJECTION_RECONCILIATION_REQUIRED`: the decision is already terminal;
  rebuild its Collaboration projection and do not decide again.

No troubleshooting step should replace the connector command with a generic shell MCP server.

## Related documents

- [Qoder product boundary](../product/qoder-work-integration.md)
- [Qoder MCP v2 contract](qoder-mcp-contract.md)
- [Qoder trust boundary](../security/qoder-trust-boundary.md)
- [Organization Graph contract](organization-graph-contract.md)
- [Skill operating guide](../../integrations/qoder-work/skills/openslack-organization-control/README.md)
