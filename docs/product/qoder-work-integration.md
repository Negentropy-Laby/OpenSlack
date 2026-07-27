# Qoder Work Integration

| Field             | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Status            | `PLANNED — DESIGN CONTRACT`                                            |
| Product direction | Qoder-first, MCP-first, projection-first                               |
| MVP transport     | Local STDIO MCP                                                        |
| Authority owner   | OpenSlack for plans and governance; external systems for their records |
| Evidence ceiling  | Contract documentation alone proves no implementation or qualification |

This document defines the planned product boundary between Qoder Work and OpenSlack. It is not a
claim that the graph, scenario, mutation, Skill, Workbench, remote Connector, or interview
qualification milestones have shipped.

## Product outcome

Qoder Work is the employee- and manager-facing natural-language workbench. OpenSlack remains the
workflow, agent-runtime, authorization, PRMS, evidence, and projection backend. GitHub, DingTalk,
CRM, ERP, and HR systems remain authoritative for the objects they own.

The intended interaction is:

```text
User intent in Qoder Work
        |
        v
Explicit OpenSlack MCP tool
        |
        +--> bounded read projection
        |
        `--> preview request
                |
                v
        immutable OpenSlack canonical plan
                |
                v
        explicit OpenSlack confirmation and governance
                |
                v
        registered package API and external authority
```

Qoder may choose which tool to call and explain the result. It does not create executable
OpenSlack steps, decide policy, grant authority, or become a project source of truth.

## Foundation reused from QW0–QW2

The integration extends the existing foundation rather than replacing or renaming it.

### QW0: deterministic demonstration fixture

The manufacturing 90-day workflow, schemas, recorded run, and evidence vocabulary remain a
deterministic technical fixture and fallback:

- `.openslack/workflows/ai-org-transformation.ts`;
- `examples/ai-organization-demo/`;
- `docs/demos/ai-organization-commercial-loop.md`.

They validate workflow shape, artifact ordering, evidence labelling, and business-outcome
reporting. They are not developed into a second lead live scenario.

### QW1: business-outcome projection

`packages/collaboration/src/business-outcomes.ts` remains the evidence-backed business reporting
boundary. Scenario and graph views consume its projection or the same typed source evidence; they
do not introduce a second KPI database or invent revenue, approvals, notification delivery, or
manual-hour savings.

### QW2: read-only MCP frontend

The existing packages and command remain:

```text
apps/mcp
packages/qoder-adapter
openslack mcp serve --stdio
```

The implemented QW2 catalog contains exactly nine read-only tools:

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

This server reuses the instance-scoped OpenSlack composition context, imports package APIs, and
does not execute CLI text or parse CLI output. It exposes no shell, generic command, approval,
merge, policy, permission, or other mutation tool. Its current result schema is
`openslack.mcp_result.v1`.

The planned graph-read milestone adds exactly three tools:

```text
openslack_list_scenarios
openslack_query_graph
openslack_explain_graph
```

That future milestone produces a 12-tool read-only catalog. Until those tools and their tests
exist, the implemented catalog remains nine.

## Authority boundary

| Surface                     | Owns                                                            | Must not own                                           |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| Qoder Work                  | User intent, tool selection, result presentation                | Canonical plans, OpenSlack approvals, external records |
| OpenSlack MCP facade        | Tool schemas, transport, actor binding, result mapping          | Shell, arbitrary dispatch, independent policy          |
| OpenSlack Operator          | Canonical action plans and confirmation state                   | GitHub human review                                    |
| Scenario Runtime            | Scenario definitions, instances, and orchestration plans        | External facts it did not create                       |
| GitHub                      | Issues, Pull Requests, checks, reviews, and merges              | OpenSlack local runs and transcripts                   |
| Other enterprise systems    | Their customer, contract, HR, finance, or communication records | OpenSlack workflow and PRMS state                      |
| Organization Graph          | Derived, explainable projection                                 | Authoritative mutation                                 |
| Static artifact or Skill UI | Presentation                                                    | Authentication, mutation, or persistent truth          |

The MCP facade is a fourth OpenSlack frontend alongside CLI, TUI, and chat. It must use typed
package APIs and the shared composition root. It is not a business backend of its own.

## Local MVP

The interview MVP uses:

```text
Qoder Chat
+ OpenSlack Organization Skill
+ local STDIO MCP
+ static HTML graph/outcome artifact
```

STDIO is chosen because it keeps the local demonstration free of a public domain, TLS service,
OAuth deployment, or Connector marketplace review. The process opens no network listener and
reserves stdout for MCP protocol frames.

The planned Skill guides tool selection, business-language presentation, preview-before-mutation,
and recovery. Whether Qoder renders a static response or an advanced interactive Skill component
does not change authority: UI controls may request a tool call but cannot approve GitHub, mint an
OpenSlack plan, or mutate an external system directly.

## Deferred productization

The following are explicitly after the local MVP:

- Streamable HTTP/SSE transport;
- HTTPS deployment and health endpoints;
- OAuth subject-to-principal mapping and revocable scopes;
- public Connector publishing and operational evidence;
- formal Qoder Workbench SDK, manifest, UI assets, and independent workbench state;
- real DingTalk writes and other enterprise-system adapters;
- Notification Delivery default cutover.

A formal Workbench is not a prerequisite for proving the organization runtime. A public remote
Connector must not reuse the local STDIO actor assumption.

## Canonical mutation contract

Governed mutations are a later milestone. They follow one path:

```text
preview
  -> server-generated correlation ID
  -> immutable OpenSlack canonical plan and plan hash
  -> explicit confirmation of that exact plan
  -> registered adapter execution
  -> execution evidence and reconciliation
```

Qoder sends business inputs, not executable steps. OpenSlack resolves the scenario, workflows,
capabilities, targets, actor, and current evidence. A confirmation is invalid after plan expiry,
input change, actor change, permission change, target change, or plan-hash change.

The planned mutation catalog is separate from the 12 read-only tools:

```text
openslack_preview_scenario
openslack_preview_workflow
openslack_confirm_plan
openslack_cancel_plan
openslack_decide_workflow_approval
```

Scenario instantiation and workflow start are effects of a confirmed canonical plan, not duplicate
unbound execution tools.

## Approval vocabulary

These decisions are separate:

1. **Qoder MCP permission** allows the desktop client to call a named tool.
2. **OpenSlack plan confirmation** confirms one immutable canonical plan.
3. **OpenSlack workflow-effect approval** decides a governed OpenSlack effect gate.
4. **GitHub human review** is an authoritative GitHub review by an eligible human identity.

These terms map to the existing [Approval vocabulary](approval-vocabulary.md): plan confirmation is
**Approve Plan**; a workflow-effect decision is **Confirm Operation**, or **Confirm Merge** when the
effect is a merge request; and GitHub human review is **GitHub Review Approval**. Qoder MCP
permission is client authorization, not an approval action. When workflow artifacts are governed,
the eligible current-head GitHub approval may carry one `Workflow-Trust` marker. That marker is a
trust-evidence facet of the fourth decision, not a fifth decision.

No MCP result, Qoder conversation, Skill UI action, OpenSlack agent, or bot identity can originate
or fabricate GitHub approval. GitHub approval is reported as governance state, never emitted as an
actionable OpenSlack approval token.

## Actor and correlation rules

STDIO establishes a local process transport boundary; it does not authenticate a Qoder end-user.

- Read-only calls use a transport actor such as `system:qoder-mcp`.
- A tool argument never supplies mutation authority.
- Mutation mode requires a server-startup binding to an active OpenSlack registry/runtime
  principal and permission snapshot.
- An agent-bound principal cannot decide a human-owned workflow effect;
  `openslack_decide_workflow_approval` requires a separately host-attested authorized human
  binding, otherwise that tool is absent or blocked.
- Missing, inactive, mismatched, or unauthorized principals fail closed.
- The server creates the correlation ID; clients cannot select a colliding ID.
- Scenario instance, workflow run, GitHub objects, graph snapshot, notifications, and final report
  carry the same correlation ID.
- MCP provenance is evidence metadata; it does not require widening the kernel provider enum.

The remote transport later replaces startup binding with an OAuth subject-to-principal mapping.

## Result and evidence rules

`openslack.mcp_result.v1` remains frozen for the nine implemented tools. Graph/scenario work
introduces `openslack.mcp_result.v2` only through one coordinated compatibility change. The v2
contract retains the v1 status vocabulary and adds server-generated correlation, typed authority
sources, governance, immutable plan identity, and execution identity.

All results must:

- use bounded structured sources rather than CLI prose;
- produce semantically identical text and structured MCP content;
- redact secrets before either representation is produced;
- report missing or stale evidence as `blocked`, `failed`, or explicit unknown state;
- keep notification `accepted` distinct from vendor `delivered`;
- identify fixtures as fixtures rather than live external authority.

Local tests and MCP Inspector evidence support `LOCAL_PASS`. Only a current Qoder installation
exercising initialization, exact tool discovery, permission prompts, and every advertised tool can
support `QODER_VERIFIED`.

## Non-goals

This integration does not:

- make Qoder a source of truth;
- expose arbitrary shell, generic CLI dispatch, raw workflow modules, or automatic action
  discovery;
- create a second workflow engine, Agent Runtime, approval service, PRMS, or notification state
  machine;
- let Qoder call GitHub or DingTalk mutations around OpenSlack governance;
- equate a chat confirmation with GitHub review;
- require a large independent frontend;
- claim a public Connector, Workbench, live DingTalk adapter, or Notification Delivery admission;
- claim `QODER_VERIFIED` or `INTERVIEW_READY` from documentation alone.

## Related documents

- [`organization-graph.md`](organization-graph.md)
- [`scenario-runtime.md`](scenario-runtime.md)
- [`../developer/qoder-mcp.md`](../developer/qoder-mcp.md)
- [`../developer/qoder-mcp-contract.md`](../developer/qoder-mcp-contract.md)
- [`../security/qoder-trust-boundary.md`](../security/qoder-trust-boundary.md)
- [`approval-vocabulary.md`](approval-vocabulary.md)
- [`collaboration-layer.md`](collaboration-layer.md)
- [`../demos/ai-organization-commercial-loop.md`](../demos/ai-organization-commercial-loop.md)
