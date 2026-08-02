---
schema: openslack.document.v1
id: architecture-qoder-mcp
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-08-02
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Qoder Work MCP integration

OpenSlack exposes a local Model Context Protocol server for Qoder Work:

```bash
bun run openslack mcp serve --stdio
bun run openslack mcp serve --stdio --profile read-only
bun run openslack mcp serve --stdio --profile agent-bound --principal-ref <agent-id>
bun run openslack mcp serve --stdio --profile human-attested \
  --principal-ref <agent-id> --human-principal <human-id>
```

The default and explicit `read-only` CLI compositions are projection-only and advertise exactly 12
read-only tools. Explicit `agent-bound` uses the production composition factory and advertises
exactly 16. Explicit `human-attested` advertises 17 only after its independent provider proves the
current local OS subject, owner-only mapping, and controlling TTY. The composition root supplies
the same instance-scoped OpenSlack context used by the CLI, TUI, and chat frontend. `apps/mcp`
imports package APIs and never imports private CLI files, executes CLI text, or parses CLI stdout.

This document describes the current local build. The candidate-bound Qoder Work `0.9.12.0`
qualification completed initialization, the exact stock 12-tool call plan, observed read-only
permission outcomes, and all three Skill trigger modes, so the local stock Connector is
`QODER_VERIFIED`. The separately controlling-TTY-qualified production-17 path is
`HUMAN_ATTESTED_PROFILE_LOCAL_PASS`. Neither claim promotes a remote Connector, OAuth,
Marketplace, Workbench, live capstone, Notification Delivery, release, or production readiness;
see [Qoder Work evidence](../../evidence/qoder-work-evidence.md).

## Authority boundary

- STDIO is the only production MCP transport; it opens no listening socket. An explicitly enabled
  GS3-A Graph read mirror is an outbound comparison call, not a second MCP transport.
- Every catalog is nominal and frozen after construction. Valid production counts are read-only
  12, agent-governed 16, and separately human-attested 17.
- A separately composed local demo profile may add only `openslack_demo_reset` to one valid
  production profile.
- Every input rejects unknown properties and applies field, count, depth, timeout, evidence, and
  output-size bounds.
- Every advertised tool returns `openslack.mcp_result.v2`.
- Stdout is reserved for MCP JSON-RPC frames; diagnostics use stderr.
- Structured output and JSON text content derive from the same sanitized object.
- Reads do not create pending plans or initialize missing graph/authority state. An enabled Graph
  mirror may append one digest-only observational Collaboration event.
- No Operator `ActionRegistry` entry is exported automatically.

No profile exposes arbitrary shell/command execution, workspace indexing, PR watch, repair, policy
or permission write, GitHub approval, or direct merge.

Qoder MCP permission is not OpenSlack confirmation, OpenSlack workflow approval, Workflow-Trust,
or GitHub human review.

### Optional GS3-A Graph read mirror

For differential qualification against a running local Go Graph service, add an explicit origin to
any existing 12-, 16-, or 17-tool command:

```bash
bun run openslack mcp serve --stdio \
  --graph-read-mirror-origin http://127.0.0.1:18181
```

Loopback is the default and recommended mode. A private or link-local IP literal is accepted only
with the additional explicit selection:

```bash
bun run openslack mcp serve --stdio \
  --graph-read-mirror-origin http://10.20.30.40:18181 \
  --graph-read-mirror-network internal
```

The origin must be exact, credential-free, HTTP, and an IP literal; DNS names, public/wildcard
addresses, paths, query strings, fragments, credentials, and redirects are rejected. Supplying
`--graph-read-mirror-network` without an origin is also rejected before server construction.

Only successful local `openslack_query_graph` and `openslack_explain_graph` calculations are sent
to the fixed Go read endpoints. MCP waits for the bounded comparison, records a matched,
mismatched, or unavailable digest-only audit event, and returns the isolated TypeScript result in
the unchanged `openslack.mcp_result.v2` envelope. It never returns the Go payload, silently falls
back between backends, translates a cursor, changes the 12/16/17 catalogs, or grants Go read/write
authority. With no origin flag there is no mirror network call or mirror audit event.
Audit append failure is excluded from stdout and the MCP result; it emits only the fixed
`OPENSLACK_GRAPH_READ_MIRROR_AUDIT_FAILED` stderr diagnostic.

### Optional GS3-B bounded Graph read canary

After the Go service is started with the same positive `GRAPH_CANARY_ROUTING_EPOCH`, select only
reviewed scenario instances with a time-bounded policy:

```bash
bun run openslack mcp serve --stdio \
  --graph-read-canary-backend go \
  --graph-read-canary-routing-epoch 41 \
  --graph-read-canary-tenant openslack-self \
  --graph-read-canary-scenarios scenario-contract-delivery-001 \
  --graph-read-canary-expires-at 2026-08-03T00:00:00.000Z \
  --graph-read-canary-origin http://127.0.0.1:18181 \
  --graph-read-canary-build-sha <64-lowercase-hex-service-build>
```

The expiry must be in the future and no more than seven days from process startup. The allowlist
contains at most 16 exact comma-separated scenario-instance IDs. Internal IP literals additionally
require `--graph-read-canary-network internal`. The canonical workspace ID, epoch, scenario,
origin, and service build are immutable for the process. Each selected request uses the fixed
canary route; timeout, response, scope, epoch/build, cursor, stale snapshot, or audit failure returns
a blocked MCP result and never reads the TypeScript snapshot as a fallback. The returned snapshot
time is checked against the same 24-hour default freshness boundary as local TypeScript reads before
the Go result or its served audit is released.

Rollback is a new explicit policy with a higher epoch and no Go transport flags:

```bash
bun run openslack mcp serve --stdio \
  --graph-read-canary-backend ts-local \
  --graph-read-canary-routing-epoch 42 \
  --graph-read-canary-tenant openslack-self \
  --graph-read-canary-scenarios scenario-contract-delivery-001 \
  --graph-read-canary-expires-at 2026-08-03T00:00:00.000Z
```

Existing canary cursors are not translated: v1 or cross-epoch tokens return an explicit mismatch,
and expired same-epoch tokens return an explicit expiry. Unselected scenarios remain on TypeScript.
Both modes preserve the selected 12/16/17 tool catalog and all mutation/approval boundaries.

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

An embedding opts into the agent-governed profile only by explicitly injecting the nominal
`OpenSlackGovernedMutationPort`. The production
`createOpenSlackAgentBoundMutationComposition()` factory constructs that port from only a
canonical workspace root, an Agent registry/runtime principal reference, an optional runtime
provider, and an optional workspace-ID equality assertion. It does not accept an actor string,
permission snapshot, compiler, executor, audit callback, raw secret, or workspace authority from
the MCP client. The injected port appends exactly:

```text
openslack_preview_scenario
openslack_preview_workflow
openslack_confirm_plan
openslack_cancel_plan
```

The CLI selects that factory only through:

```bash
openslack mcp serve --stdio --profile agent-bound --principal-ref <agent-id>
openslack mcp serve --stdio --profile agent-bound --principal-ref <agent-id> \
  --workspace-id <asserted-workspace-id>
```

`--principal-ref` is only a lookup key for the existing Agent registry and matching CLI runtime
identity. It never becomes `actorId`. `--workspace-id`, when present, is only an equality assertion
against canonical `openslack.yaml`. Default and explicit `read-only` reject both mutation-only
arguments. Any principal, permission, workspace, Scenario catalog, audit, executor, plan-store, or
instance-store initialization failure terminates startup before a server or partial catalog is
created; it never falls back to 12 tools.

Preview compiles business input through a host-owned Scenario or sealed Workflow compiler,
persists one immutable canonical plan, and returns a root-only one-time confirmation capability.
Only the capability hash is stored. Confirmation revalidates actor, workspace, expiry, plan,
source, permission, action catalog, executor binding, build, and process snapshots before one
atomic execution claim. A timeout after that claim is reconciliation-required; it is never
reported as safe to retry.

The current production factory registers the real `scenario.instantiate` action and one reviewed
`openslack.contract_delivery.local` Workflow action. It discovers
the locked Scenario root once, seals the accepted definitions for the process, uses
`loadScenarioPack()` and `previewScenario()`, strictly rehydrates the persisted Scenario plan, and
writes the instance through `LocalScenarioInstanceStore` CAS before verified readback. Registry,
runtime-identity, workspace, Scenario lock, catalog, resolver, build, plan-store, instance-store,
and audit bindings fail closed. The checked-in `software-delivery` Pack remains projection-only
and requests no workflow capability. `contract-to-delivery-lite` references exactly one sealed
Workflow and one low-risk Collaboration event capability. Its executor requires an active current
Scenario instance and verified principal, permission, resolver, Pack, plan, store, and build
bindings. Every other Workflow target returns
`GOVERNED_WORKFLOW_TARGET_NOT_REGISTERED` without creating a pending plan.

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

Default and explicit `read-only` inject neither mutation nor reset ports and therefore advertise
only the production 12. Explicit `agent-bound` injects the production governed mutation port and
advertises 16. Exact demo counts are 13, 17, or 18, corresponding to the 12, 16, or 17 production
profile plus reset. Any other count or ordering is invalid.

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

Use exactly one of `--from <path>` or `--from-stdin`. Both scenarios and both input paths stop at
the locked 4 MiB Software Delivery source ceiling before parsing. File input requires a real
regular file, rejects symlink or reparse resolution, and verifies path and handle identity before,
during, and after the bounded read. The package service then uses strict JSON with explicit depth,
node, and string ceilings, a sealed host-owned dispatch for the two registered
validator/projectors, and the existing atomic `LocalGraphStore`. Pack content cannot select a
module or projector function. The command does not call GitHub or assemble live evidence.

The checked-in composite fixture can be built explicitly:

```bash
bun run openslack graph snapshot build \
  --scenario contract-to-delivery-lite \
  --from packages/organization-graph/src/fixtures/contract-to-delivery-source.json \
  --scenario-instance scenario-contract-delivery-001 \
  --format json
```

This produces a fixture-backed Customer-to-Outcome projection in the same snapshot as the reused
Software Delivery subgraph. For the governed credential-free local path, run:

```bash
bun run demo:contract-delivery
```

That rehearsal proves local principal, plan, Scenario, Workflow, Collaboration, graph-build, and
MCP readback bindings. The business chain remains `demo_fixture`; live GitHub and Qoder Desktop
remain `not_run`.

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

## Run the qualification harnesses

The repository provides two repeatable, fail-closed qualification entrypoints. Their presence is
not qualification evidence; only a successful run against the frozen candidate revision can
advance the corresponding claim.

Run the 17-tool human-attested check from a real Windows or POSIX controlling terminal:

```bash
bun run qualification:human-attested -- \
  --human-principal human:founder \
  --confirm
```

The harness creates an isolated temporary workspace and `qoder_qualification_agent`. That agent
allows only `scenario.instantiate` and `openslack.collaboration.recordEvent`; GitHub writes,
notification delivery, shell, policy, permission, and registry mutation remain unavailable. The
official MCP SDK must discover the exact 17-tool production composition. The human then reviews
one synthetic, local-only workflow-effect decision on `CON` or `/dev/tty` and types the exact
`APPROVE` token. Success requires terminal CAS revision 2, a recorded Collaboration audit
projection, durable readback, and removal of the temporary workspace, subject mapping, and
approval store before the sanitized receipt is emitted. No stdin, command argument, or test
dependency can supply the attestation.

Prepare the stock Qoder Work Desktop check from a clean Windows candidate checkout:

```bash
bun run qualification:qoder-desktop -- prepare --format json
```

Preparation rejects tracked changes, records the candidate commit and tree, installed Qoder build,
OS and architecture, Skill tree hash, credential-free Connector config hash, and fixed call-plan
hash. The generated Windows config pins the same resolved Bun executable that ran preparation, so
it does not depend on the Desktop process inheriting a shell-specific `PATH`. It publishes one
more-than-24-hour locked graph fixture, reserves a separate missing graph instance, preflights all
12 tools through the official MCP SDK, seals each advertised tool's `readOnlyHint`,
`destructiveHint`, `idempotentHint`, and `openWorldHint`, and writes a Connector config, call plan,
sealed v2 manifest, and pending v2 receipt beneath
`.openslack.local/qualification/qoder-desktop/`.

Use the generated Connector and call plan in a new authenticated Desktop conversation. Remove the
old OpenSlack Connector and prior grants first, explicitly enable the new Connector, disable
Auto-run, and never use a wildcard. For each call, record the observed permission outcome as
`prompt_observed` when Desktop requests authorization or
`no_prompt_read_only_observed` when Desktop directly executes the exact sealed read-only tool.
`PermissionRequest` is a conditional Qoder Work hook event that fires when a tool execution
requires authorization, not a promise that every call displays a prompt; see
[Qoder Work Hooks](https://docs.qoder.com/qoderwork/hooks). MCP annotations can inform that client
preflight behavior; see
[MCP Tool Annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).
They are untrusted hints, not OpenSlack authority. Record only structured statuses and SHA-256
evidence references in the pending receipt—never an account name, authentication file,
credential, or raw vendor response. After all 12 calls and automatic, `/` chooser, and
explicit-name Skill invocations are complete, verify the edited receipt:

```bash
bun run qualification:qoder-desktop -- verify \
  --receipt <absolute-path-to-qoder-desktop-receipt.json>
```

Verification rechecks the clean candidate revision, Qoder build, exact tool order, per-tool input
and result bindings, observed permission outcomes, exact sealed annotations, explicit Connector
enablement, disabled Auto-run, removed prior grants, two locked Packs, stale and unavailable
blocker codes, all three Skill modes, Connector credential absence, and the current Config,
call-plan, and Skill hashes. A no-prompt result is accepted only for the exact production 12-tool
catalog when `readOnlyHint=true`, `destructiveHint=false`, and `idempotentHint=true`;
`openWorldHint` must match the sealed catalog but need not be false. Any mutation tool, annotation
drift, unknown permission outcome, wildcard, Auto-run, prior grant, or other mismatch leaves
`QODER_VERIFIED` unclaimed. An annotation never substitutes for OpenSlack's runtime authority
boundary.

## Configure the Qoder Work desktop connector

Open **Extensions → Connectors → + Add → Paste JSON Config**, then adapt one of:

- `templates/qoder-skill/examples/mcp-config.windows.json`
- `templates/qoder-skill/examples/mcp-config.wsl.json`
- `templates/qoder-skill/examples/mcp-config.unix.json`

Those examples use the default 12-tool profile. Credential-free 16-tool examples are:

- `templates/qoder-skill/examples/mcp-config.agent-bound.windows.json`
- `templates/qoder-skill/examples/mcp-config.agent-bound.wsl.json`
- `templates/qoder-skill/examples/mcp-config.agent-bound.unix.json`

Credential-free 17-tool examples are:

- `templates/qoder-skill/examples/mcp-config.human-attested.windows.json`
- `templates/qoder-skill/examples/mcp-config.human-attested.wsl.json`
- `templates/qoder-skill/examples/mcp-config.human-attested.unix.json`

Replace `<agent-id>` with an already active registry entry that has a matching CLI runtime identity
and `scenario.instantiate` grant. Before selecting 17, run in the same OS environment:

```bash
bun run openslack mcp attestation status
bun run openslack mcp attestation bind-local-subject \
  --human-principal <human-id> --confirm
```

The bind command stores only a one-way hash of the current POSIX uid/user or Windows SID.
`--human-principal` is an equality assertion against that mapping, not an identity or credential.
Every decision prompt opens only `/dev/tty` or `CON` and accepts the exact `APPROVE` or `REJECT`
token. A desktop launcher without a controlling TTY cannot start this profile; startup fails
closed without exposing a 16/12-tool fallback.

The examples preserve a workspace path containing spaces as one JSON argument and contain no
credential values. Authorize only the exact names advertised by the selected 12, 16, or 17
profile, keep Auto-run disabled during qualification, and do not add a wildcard allow rule.

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
bunx vitest run apps/mcp/src/__tests__/governed-composition.test.ts
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
The production factory's official MCP SDK preview → confirm → durable Scenario readback is
`AGENT_BOUND_PROFILE_LOCAL_PASS` evidence. The default and explicit `read-only` CLI profiles are
qualified as exact-read-12; explicit `agent-bound` is qualified as exact-agent-16; local SDK and
provider tests qualify exact-human-17 plus one durable workflow-effect decision. Authenticated
Qoder Desktop execution remains a separate pending gate, and a Desktop process without a
controlling TTY is an expected fail-closed outcome.

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
- each call's actual permission outcome, explicit Connector enablement, disabled Auto-run, removed
  prior grants, and confirmation that no wildcard tool grant was used;
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
- `OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID`: remove authority-binding arguments from `read-only`,
  provide `--principal-ref` for `agent-bound`, or provide both `--principal-ref` and
  `--human-principal` for `human-attested`.
- `LOCAL_HUMAN_ATTESTATION_*`: run `openslack mcp attestation status`; bind the same local OS
  subject explicitly, verify owner-only file/ACL state, and use a launcher with `/dev/tty` or
  `CON`. Never redirect MCP stdin/stdout into the attestation prompt.
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

- [Qoder product boundary](../../../design/cdd/workstreams/qoder-work/README.md)
- [Qoder MCP v2 contract](../contracts/qoder-mcp.md)
- [Qoder trust boundary](../../security/qoder-trust-boundary.md)
- [Organization Graph contract](../contracts/organization-graph.md)
- [Skill operating guide](../../../integrations/qoder-work/skills/openslack-organization-control/README.md)
