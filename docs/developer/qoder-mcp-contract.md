# Qoder MCP Contract

Status: implemented local contract. The stock local surface is the exact 12-tool,
`openslack.mcp_result.v2` server described in [Qoder Work MCP integration](qoder-mcp.md).
Nominal composition ports enable exact agent-governed 16-tool and separately human-attested 17-tool
profiles. An explicitly injected local demo surface appends only the bounded reset tool. This does
not claim Qoder desktop qualification or Scenario rehearsal.

## Composition Boundary

`apps/mcp` is a fourth frontend over the instance-scoped OpenSlack composition context. It calls
typed package APIs and receives explicitly injected projection and planning ports.

It must not:

- execute client-supplied CLI text, shell commands, module paths, or URLs;
- parse CLI stdout as an application API;
- enumerate the Operator `ActionRegistry` as an MCP tool catalog;
- accept approval, actor, capability, risk, or policy authority from tool input;
- turn Qoder connector permission into OpenSlack confirmation or GitHub review.

STDIO is the interview transport. It opens no listening socket and does not authenticate a Qoder
end user. A later remote transport requires HTTPS, OAuth subject mapping, revocable scopes, and a
separate qualification; it does not weaken this contract.

## Catalog Evolution

This section is the single source of truth for exact MCP tool names and catalog counts. Product,
Scenario Runtime, Skill, and security documents link here and must not independently add, rename,
or copy the catalog.

The foundation compatibility layer contains exactly nine read-only handlers:

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

The current production catalog adds exactly:

```text
openslack_list_scenarios
openslack_query_graph
openslack_explain_graph
```

The resulting production read-only catalog is exactly 12 tools. `run.explain` extends
`openslack_get_workflow_progress`; business-language aliases in the Qoder Skill are not duplicate
registrations.

The implemented agent-governed profile appends:

```text
openslack_preview_scenario
openslack_preview_workflow
openslack_confirm_plan
openslack_cancel_plan
```

Scenario instantiation and workflow start are effects of a confirmed canonical plan. There is no
second direct execution tool. No MCP catalog exposes arbitrary commands, direct merge, GitHub
approval, policy writes, registry writes, or permission writes.

The separately human-attested profile appends:

```text
openslack_decide_workflow_approval
```

Its v2 store, per-decision human attestation, and durable audit projection are separate from legacy
Workflow run approvals. An agent-bound composition cannot advertise or invoke it.

`openslack_demo_reset` is present only with explicit `demoMode: true` and a nominal port created by
`createLocalDemoResetPort`. The factory binds one existing canonical
`.openslack.local/demo/<fixture>` child to the same workspace and rejects symlink/reparse or changed
directory identities. Its host callback receives only frozen `{ root, signal, deadlineAt }`
authority. Timeout is an ambiguous effect reported as `reconciliation_required`, never as proof of
no effect. Exact production counts are 12, 16, and 17; exact demo counts are 13, 17, and 18. The
stock CLI remains production-12.

## Result Versions

`openslack.mcp_result.v1` remains frozen as the internal compatibility contract for the nine
foundation handlers. Existing status values and field meanings must not change.

The current server switches every advertised tool atomically to `openslack.mcp_result.v2`:

```ts
interface OpenSlackMcpResultV2<T = unknown> {
  schema: 'openslack.mcp_result.v2';
  correlationId: string;
  status: 'completed' | 'preview' | 'needs_confirmation' | 'blocked' | 'failed';
  summary: string;
  authority: {
    mode: 'projection' | 'governed_mutation';
    sources: string[];
    observedAt: string;
  };
  data?: T;
  governance: {
    risk: 'none' | 'low' | 'medium' | 'high';
    approvalRequired: boolean;
    approvalKind?: 'openslack_confirm' | 'openslack_workflow_effect' | 'github_human_review';
    evidenceFacets?: Array<'workflow_trust'>;
    owner?: string;
    blocker?: string;
  };
  nextActions: Array<{
    id: string;
    label: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    requiresConfirmation: boolean;
  }>;
  evidenceRefs: string[];
  planId?: string;
  planHash?: string;
  confirmationToken?: string;
  executionId?: string;
  approval?: {
    approvalId: string;
    kind: 'openslack_workflow_effect';
    expiresAt: string;
    risk: 'low' | 'medium' | 'high';
  };
  error?: { code: string; message: string };
}
```

The actionable `approval` object is intentionally limited to
`kind: 'openslack_workflow_effect'`. Plan confirmation uses the bound `planId`; GitHub human review
and its optional `Workflow-Trust` marker are evidence-only governance state and never receive an
MCP approval token. `evidenceFacets: ['workflow_trust']` is valid only with
`approvalKind: 'github_human_review'`; the facet is deduplicated, omitted when absent, and rejected
with every other approval kind.

Compatibility requirements:

- v1 fixtures for all nine foundation tools convert to v2 without changing business meaning;
- text content and structured content derive from the same sanitized value;
- v2 retains the v1 status vocabulary;
- GitHub human review appears only as governance evidence, never as an actionable approval token;
- one server process advertises one result version across its complete catalog;
- the transition is complete before `QODER_VERIFIED` is claimed.

## Actor Binding

The server generates `correlationId`; clients cannot choose a colliding identifier.

Read-only STDIO calls use a transport actor such as `system:qoder-mcp`. Mutation mode requires a
server-startup binding to one active OpenSlack registry/runtime principal and its permission
snapshot. The server rejects a missing, inactive, mismatched, or unauthorized principal.

An agent-bound principal can preview and confirm only actions granted to that agent. It cannot
decide a human-owned workflow effect. `openslack_decide_workflow_approval` is advertised only when
the composition root supplies an independently authenticated per-decision attestation port. Every
call must attest the exact run, approval, decision, reason hash, required capability, business
correlation, and approval expiry; an agent-only or transport-only composition omits the tool or
returns `blocked`. Qoder's permission prompt, explicit wording, and a client-supplied actor name
are not human attestation.

Tool arguments cannot supply or override:

- actor or GitHub identity;
- workspace root;
- capability grants;
- approval provenance;
- correlation ownership.

A future remote server maps an authenticated OAuth subject to an OpenSlack principal at the
composition boundary. It does not trust an actor string from JSON-RPC input.

## Canonical Plan and Confirmation

Preview input is intent, not executable steps. OpenSlack resolves the selected scenario, registered
workflows, reviewed adapters, target repository, current source versions, actor, capabilities,
risk, and effects into the only canonical `ActionPlan`.

A persisted pending plan binds:

```text
planId / planHash / actorId / workspaceId / correlationId
createdAt / expiresAt / state
canonical ActionPlan / effect manifest
source versions and current-head SHAs / permission snapshot
action catalog / executor binding / build nonce / process nonce
```

Confirmation performs a bounded strict read, verifies expiry and bindings, recomputes the plan
hash, revalidates the sealed registry, rereads source versions, resolves current permission
evidence, and atomically claims the plan for one execution. The raw confirmation capability is
returned only at the v2 result root; only its hash is persisted, and it never appears in
`nextActions`, audit events, or evidence. Replay, drift, actor mismatch, and partial-failure retry
fail closed. Reconciliation produces a fresh preview.

The isolated workflow-effect decision path uses one atomic pending-to-approved/rejected CAS.
Transport arguments cannot replace its principal, capability, workspace, or business correlation.
That CAS also persists a deterministic `auditProjection.status: pending` marker. A successful
Collaboration append advances the record to `recorded`; a failure leaves the terminal v2 decision
authoritative and retries only the projection using the same event ID.
The projection sink writes only through a composition-bound, identity-checked O_APPEND descriptor;
it does not reopen `events.jsonl` after an outer directory check.

OpenSlack plan confirmation, OpenSlack workflow-effect approval, Qoder connector permission, and
GitHub human review remain four independent decisions. They use the canonical
[Approval vocabulary](../product/approval-vocabulary.md): plan confirmation maps to **Approve
Plan**; workflow-effect approval maps to **Confirm Operation**, or **Confirm Merge** for a merge
effect; and GitHub human review maps to **GitHub Review Approval**. Connector permission is
authorization rather than approval. A `Workflow-Trust` marker is a current-head evidence facet of
the GitHub review decision, not a fifth decision.

## Bounds and Failure Semantics

Every tool uses a closed input schema with explicit text, item, timeout, evidence, and output-byte
limits. Unknown properties fail with `INVALID_TOOL_INPUT`.

Projection failures use stable codes:

```text
READ_PROJECTION_FAILED
READ_PROJECTION_TOO_LARGE
SOURCE_EVIDENCE_UNAVAILABLE
SOURCE_EVIDENCE_STALE
```

Governed mutation adds stable fail-closed codes for expired plans, hash drift, source drift,
permission drift, registry drift, actor mismatch, replay, and uncertain execution. Workflow
decisions distinguish durable-decision reconciliation from derived-audit-projection
reconciliation. Raw source prose, vendor responses, credentials, nested confirmation capabilities,
and secret-bearing paths never enter MCP output.

## Qualification Evidence

Local SDK/Inspector evidence proves only `LOCAL_PASS`. `QODER_VERIFIED` additionally records:

- Qoder Work build and operating system;
- connector configuration hash without credentials;
- exact `tools/list`;
- initialize and bounded call results for every tool in the selected exact profile;
- timestamps and OpenSlack commit;
- explicit blocked/unknown results for unavailable evidence.

The qualification artifact is evidence, not authority, and does not imply Scenario rehearsal,
Notification Delivery admission, or GitHub approval.

## Related Documents

- [Current Qoder MCP operation](qoder-mcp.md)
- [Qoder product boundary](../product/qoder-work-integration.md)
- [Qoder trust boundary](../security/qoder-trust-boundary.md)
- [Human approval](../security/human-approval.md)
- [Approval vocabulary](../product/approval-vocabulary.md)
