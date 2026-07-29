---
schema: openslack.document.v1
id: cdd-workstream-qoder-work
status: In Review
authority: canonical
audience:
  - contributors
owner: product
updated: 2026-07-30
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Qoder Work Integration

| Field             | Value                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| Status            | `LOCAL STOCK CONNECTOR QODER_VERIFIED — REMOTE PRODUCTIZATION DEFERRED`           |
| Product direction | Qoder-first, MCP-first, projection-first                                          |
| MVP transport     | Local STDIO MCP                                                                   |
| Authority owner   | OpenSlack for plans and governance; external systems for their records            |
| Evidence ceiling  | Candidate-bound qualification proves only the reviewed local stock Connector path |

This document defines the product boundary between Qoder Work and OpenSlack. Current local
graph/scenario reads, optional governed mutation ports, the credential-free Contract-to-Delivery
local rehearsal, and the checked-in Skill remain separately scoped. The final Windows candidate
qualified the exact stock 12-tool STDIO Connector and all three Skill trigger modes as
`QODER_VERIFIED`; it does not claim a formal Workbench, a remote Connector, OAuth, Marketplace
publication, live Contract-to-Delivery execution, or interview readiness.

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
- `docs/examples/ai-organization-commercial-loop.md`.

They validate workflow shape, artifact ordering, evidence labelling, and business-outcome
reporting. They are not developed into a second lead live scenario.

### QW1: business-outcome projection

`packages/collaboration/src/business-outcomes.ts` remains the evidence-backed business reporting
boundary. Scenario and graph views consume its projection or the same typed source evidence; they
do not introduce a second KPI database or invent revenue, approvals, notification delivery, or
manual-hour savings.

### QW2/QG4: read-only MCP frontend

The existing packages and command remain:

```text
apps/mcp
packages/qoder-adapter
openslack mcp serve --stdio
```

The exact tool names and counts are owned by the
[Qoder MCP Catalog Evolution contract](../../../../docs/architecture/contracts/qoder-mcp.md#catalog-evolution).
The implemented QW2 foundation contains nine compatibility handlers.

The server reuses the instance-scoped OpenSlack composition context, imports package APIs, and
does not execute CLI text or parse CLI output. The read-only profiles expose no mutation tool; no
profile exposes shell, generic command, human workflow decision without independent attestation,
GitHub approval/direct merge, policy, registry, or permission mutation. The frozen
`openslack.mcp_result.v1` type remains an internal compatibility boundary for these nine handlers.

The production QG4 catalog adds exactly three graph/scenario reads:

```text
openslack_list_scenarios
openslack_query_graph
openslack_explain_graph
```

The default and explicit `read-only` local production catalogs are therefore exactly 12 tools.
Explicit CLI `agent-bound` selects the production composition and appends exactly four
preview/confirm tools for a 16-tool profile. Explicit CLI `human-attested` adds the separately
attested workflow-effect decision for a 17-tool profile after its OS-subject mapping and
controlling-TTY self-test. An explicitly injected local demo profile adds only
`openslack_demo_reset` to one of those profiles. Every
advertised production/demo result is `openslack.mcp_result.v2`; no CLI profile advertises demo
tools.

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

The checked-in Skill guides tool selection, business-language presentation,
preview-before-mutation, explicit confirmation, and recovery. Whether Qoder renders a static
response or an advanced interactive Skill component
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

Implemented governed mutations follow one path:

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

The agent-governed mutation catalog appends these four tools to the 12 read-only tools:

```text
openslack_preview_scenario
openslack_preview_workflow
openslack_confirm_plan
openslack_cancel_plan
```

Scenario instantiation and workflow start are effects of a confirmed canonical plan, not duplicate
unbound execution tools.

A fifth tool is present only in a separately human-attested 17-tool profile:

```text
openslack_decide_workflow_approval
```

Preview persists only the confirmation capability hash. The root v2 preview result returns the
one-time capability, but `nextActions`, evidence, audit, and durable records never contain its raw
value. Confirmation revalidates source, permission, catalog, executor, build, and process bindings,
then uses one atomic execution claim. A claimed timeout requires reconciliation and cannot be
replayed.

Workflow-effect decisions use an isolated v2 CAS store and a fresh independently authenticated
host attestation for the exact run, approval, decision, reason hash, required capability,
correlation, and expiry. The original business correlation remains authoritative. The terminal CAS
persists a deterministic pending audit projection; a successful append records its receipt. A
failed projection remains visible for projection-only reconciliation and never invites repetition
of the already terminal business decision.

## Approval vocabulary

These decisions are separate:

1. **Qoder MCP permission** allows the desktop client to call a named tool.
2. **OpenSlack plan confirmation** confirms one immutable canonical plan.
3. **OpenSlack workflow-effect approval** decides a governed OpenSlack effect gate.
4. **GitHub human review** is an authoritative GitHub review by an eligible human identity.

These terms map to the existing [Approval vocabulary](../../../../memory_bank/t2_execution/approval-vocabulary.md): plan confirmation is
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
  `openslack_decide_workflow_approval` requires a separately authenticated host attestation for
  each exact decision, otherwise that tool is absent or blocked.
- Explicit user wording is necessary presentation intent, but Qoder permission, IM identity, and
  client actor text are not the attestation.
- Missing, inactive, mismatched, or unauthorized principals fail closed.
- The server creates the correlation ID; clients cannot select a colliding ID.
- Scenario instance, workflow run, GitHub objects, graph snapshot, notifications, and final report
  carry the same correlation ID.
- MCP provenance is evidence metadata; it does not require widening the kernel provider enum.

The remote transport later replaces startup binding with an OAuth subject-to-principal mapping.

## Result and evidence rules

`openslack.mcp_result.v1` remains frozen for the nine foundation handlers. The current MCP server
upgrades every advertised tool atomically to `openslack.mcp_result.v2`. The v2 contract retains
the v1 status vocabulary and adds server-generated correlation, typed authority sources,
governance, immutable plan identity, and execution identity.

All results must:

- use bounded structured sources rather than CLI prose;
- produce semantically identical text and structured MCP content;
- redact secrets before either representation is produced;
- report missing or stale evidence as `blocked`, `failed`, or explicit unknown state;
- keep notification `accepted` distinct from vendor `delivered`;
- identify fixtures as fixtures rather than live external authority.

Local tests and MCP Inspector evidence support `LOCAL_PASS`. The current candidate-bound Qoder
Work `0.9.12.0` evidence additionally proves initialization, exact tool discovery, the observed
permission outcome for every stock read-only tool, all 12 fixed calls, and automatic, `/` chooser,
and explicit-name Skill triggers. That evidence supports `QODER_VERIFIED` only for the reviewed
local stock Connector and installed Skill.

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

- [`organization-graph.md`](../organization-graph/README.md)
- [`scenario-runtime.md`](../scenario-runtime/README.md)
- [`../developer/qoder-mcp.md`](../../../../docs/architecture/integrations/qoder-mcp.md)
- [`../developer/qoder-mcp-contract.md`](../../../../docs/architecture/contracts/qoder-mcp.md)
- [`../security/qoder-trust-boundary.md`](../../../../docs/security/qoder-trust-boundary.md)
- [`approval-vocabulary.md`](../../../../memory_bank/t2_execution/approval-vocabulary.md)
- [`collaboration-layer.md`](../../modules/collaboration.md)
- [`../demos/ai-organization-commercial-loop.md`](../../../../docs/examples/ai-organization-commercial-loop.md)

## Overview

Qoder Work integrates an exact read-only MCP frontend and a governed host
composition without changing the stock CLI tool contract.

## User Promise

Users can inspect the advertised tool surface, permissions, Skill workflow, and
qualification evidence without confusing connector permission with approval.

## Data Model

Tool descriptor, host composition, principal binding, permission snapshot,
scenario catalog, approval evidence, and qualification result.

## Edge Cases

Unauthenticated Desktop, mismatched tool counts, unbound executors, stale
catalogs, or nominal TTY identity do not become verified host evidence.

## Dependencies

`@openslack/qoder-adapter`, MCP, Scenario Runtime, and an authenticated Qoder
Desktop environment.

## Configuration

The stock MCP surface remains read-only. Additional governed tools belong to an
explicit host composition.

## Acceptance Criteria

- Local contract tests and authenticated Desktop qualification are separate.
- Observed permission outcomes and all three Skill triggers are verified before
  `QODER_VERIFIED`.
- No client permission becomes GitHub or OpenSlack approval.
