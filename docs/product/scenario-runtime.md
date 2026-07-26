# Scenario Runtime

| Field                   | Value                                                     |
| ----------------------- | --------------------------------------------------------- |
| Status                  | `PLANNED — DESIGN CONTRACT`                               |
| Product direction       | One-scenario-first                                        |
| Lead interview scenario | Contract-to-Delivery Lite                                 |
| Pack format             | Declarative `openslack.scenario_pack.v1`                  |
| Execution authority     | OpenSlack canonical plan through registered host adapters |

This document defines the planned Scenario Runtime product contract. It does not claim that
`@openslack/scenario-runtime`, Scenario Packs, scenario MCP tools, Contract-to-Delivery Lite, or
scenario lifecycle events have been implemented.

## Product outcome

Scenario Runtime maps a bounded business objective to existing OpenSlack workflows and reviewed
adapters without introducing a second workflow engine:

```text
Business input
     |
     v
sealed Scenario Pack catalog
     |
     v
read-only preview
     |
     v
OpenSlack canonical plan
     |
     v
existing Workflow / Agent Runtime / GitHub Task Loop / PRMS
     |
     v
Scenario instance evidence and Organization Graph projection
```

A Scenario Pack declares ontology, projections, workflow references, capabilities, policies,
views, notification intents, and bounded fixtures. The host owns every executable adapter and
authorization decision.

## Foundation reused from QW0–QW2

### QW0

The manufacturing 90-day workflow already proves stable workflow phases, role routing, artifacts,
fixture replay, and evidence vocabulary. Scenario Runtime reuses those conventions and the
existing Workflow Runtime. The manufacturing workflow remains a technical fixture/fallback, not a
second competing live interview story.

### QW1

`BusinessOutcomeProjection` supplies evidence-backed outcome reporting for a scenario instance.
Scenario Runtime passes scenario/correlation scope and versioned configured estimates into that
existing projection; it does not introduce another economics calculator or revenue model.

### QW2

The existing read-only `apps/mcp` frontend and `packages/qoder-adapter` are extended in place.
Scenario Runtime does not create `apps/mcp-server`, rename the Qoder adapter, parse CLI output, or
auto-export its internal methods as tools.

The first read-only additions are:

```text
openslack_list_scenarios
openslack_query_graph
openslack_explain_graph
```

Governed scenario preview and execution tools come only after the runtime, pack loader, actor
binding, immutable plan store, and audit contracts exist.

## Definition and instance

A **scenario definition** is the immutable, locked interpretation of one Scenario Pack version.
It describes allowed types, mappings, workflows, capabilities, policies, views, notifications, and
fixture inputs.

A **scenario instance** binds one definition hash to:

- one server-generated scenario instance ID;
- one server-generated correlation ID;
- bounded target authority references;
- one immutable canonical plan ID and hash;
- zero or more workflow run IDs;
- lifecycle state and timestamps;
- evidence and recovery references.

The planned lifecycle is:

```text
previewed
  -> instantiating
  -> active
  -> completed

active or instantiating
  -> blocked
  -> active

instantiating or active
  -> failed or cancelled
```

State transitions require typed evidence. A scenario is not completed merely because a workflow
process exited successfully; required outcomes and governance may still be incomplete.

## Scenario Pack

The planned closed layout is:

```text
scenarios/<scenario-id>/
├── scenario.yaml
├── scenario.lock.json
├── ontology.yaml
├── projections.yaml
├── workflows.yaml
├── capabilities.yaml
├── policies.yaml
├── views.yaml
├── notifications.yaml
└── fixtures/
```

`scenario.yaml` declares `schema: openslack.scenario_pack.v1`, the pack identity/version, and the
closed file set. `scenario.lock.json` pins the exact bytes of every declared file except the lock
itself.

Allowed declarations:

```text
types and bounded fields
registered projector IDs
registered workflow IDs
registered capability IDs
policy constraints
view definitions
notification intent mappings
bounded demo fixtures
```

Forbidden content:

```text
raw command or shell
module or entrypoint path
JavaScript or TypeScript executable
arbitrary URL
credential reference or value
unregistered capability
embedded approval or merge decision
dynamic code or dynamic UI
```

Links in a view select only host-registered deep-link templates. A pack cannot supply an arbitrary
URL.

## Pack loading and trust

Scenario Pack is separate from `openslack.plugin.v1`. The current declarative plugin contract
contains only `action_alias` and `workflow_alias`; it is not widened into a general scenario or
executable extension mechanism.

The Scenario Pack loader reuses the Plugin Host's safety methods, not its schema:

- closed schemas and duplicate-key rejection;
- exact-byte deterministic lock;
- bounded file count and byte size;
- fatal UTF-8;
- realpath containment and symlink rejection;
- host-owned capability, workflow, projector, adapter, and target decisions.

A pack cannot register code, grant itself a capability, raise trust, select an unreviewed adapter,
approve an effect, or become executable because its hash is valid. Integrity is necessary but not
authorization.

## Capability compatibility

The planned Workflow permission shape adds:

```ts
capabilities?: string[];
```

Legacy fields remain supported:

```text
github
git
filesystem
openslack
```

A compatibility normalizer maps legacy namespace/value pairs into canonical dotted IDs:

```text
github: ["issues:read"]     -> github.issues.read
git: ["push"]               -> git.push
filesystem: ["read"]        -> filesystem.read
openslack: ["prms:doctor"]  -> openslack.prms.doctor
```

Mixed legacy and canonical declarations normalize, deduplicate, and sort deterministically.
Existing workflows retain their effective permissions. Unknown namespaces, unknown capability
IDs, wildcards, conflicting aliases, and malformed values fail closed.

Only a sealed host catalog maps capability IDs to reviewed adapters, target constraints, risk
metadata, and approval requirements. A workflow, Scenario Pack, Skill, or MCP request cannot add
to that catalog.

## Canonical planning

Preview is read-only. It returns the objects, workflows, targets, side-effect manifest,
capabilities, risk, owners, approval points, evidence, and expected outcomes that OpenSlack would
use.

The client does not provide executable steps. OpenSlack resolves:

```text
scenario definition and exact hash
normalized bounded input
target scope and authority versions
server-bound actor and permissions
registered workflow and adapter IDs
capability/risk decisions
current evidence
```

The result becomes an immutable canonical plan. Confirmation binds the exact plan ID/hash, actor,
permission snapshot, target scope, and input hash. Any mismatch, expiry, or policy change requires
a new preview.

Planned governed tools are:

```text
openslack_preview_scenario
openslack_preview_workflow
openslack_confirm_plan
openslack_cancel_plan
openslack_decide_workflow_approval
```

Instantiation and workflow start are effects recorded by a confirmed plan, not separate unbound
tools. GitHub review remains an external human decision and is never represented by an executable
OpenSlack approval token.

## Idempotence and recovery

Instantiation is idempotent by:

```text
scenario definition hash
+ normalized input hash
+ target scope
```

Repeated execution cannot silently create duplicate scenario instances or duplicate declared
effects. Each execution attempt has its own execution ID while retaining the immutable plan ID.

Remote side effects are not described as transactionally rolled back. On partial execution, the
runtime records:

- effects completed and their authority references;
- the failed or uncertain step;
- evidence available at the failure boundary;
- current owner and allowed recovery action;
- reconciliation result before retry.

Recovery resumes from persisted evidence and revalidates authority versions, actor permissions,
policy, and idempotency keys. Unknown remote outcome blocks replay until reconciliation.

`openslack_demo_reset` is a demo-only tool. It may be registered only with `demo_mode=true` for an
explicit local/loopback fixture workspace. It resets local fixtures, scenario instances, and graph
snapshots inside the configured demo root. It is absent from normal `tools/list` and never deletes
or rewrites live GitHub objects.

## Scenario and Collaboration boundary

Business-domain types such as Customer, Contract, Project, Milestone, Deliverable, Acceptance, and
Outcome belong to scenario ontology and Organization Graph.

The existing Collaboration event model remains the shared coordination record. The planned
runtime adds only a `scenario` coordination object and bounded lifecycle events needed to connect:

```text
scenario instance
workflow run
handoff and decision
GitHub objects
notification intent
graph snapshot
business outcome
```

This avoids expanding the task/PR Dashboard into an industry-wide database.

## One-scenario MVP

There is one lead live story:

> A company has signed an AI workflow transformation contract. Establish a delivery project and
> complete security review, GitHub integration, and demonstration materials within two weeks.

Contract-to-Delivery Lite adds only:

```text
Customer
Contract
Project
Milestone
Deliverable
Acceptance
Outcome
```

It reuses the real software-delivery subgraph:

```text
Contract
  -> activates Project
  -> decomposes to Milestone
  -> contains Work Item
  -> implemented by GitHub Issue
  -> produces Pull Request
  -> reviewed by Human Review
  -> accepts Deliverable
  -> contributes to Outcome
```

The `software-delivery` pack/projector is reusable foundation, not a second live interview
scenario. The employee-onboarding example, if shown, is a static fixture only and makes no live
execution claim.

## Notification boundary

Scenario Packs declare notification intents, not vendor operations. The host maps allowed intent
types such as approval requested, workflow blocked, owner action required, completion, and failure
to an explicitly configured route.

The default MVP route is console, with a direct local webhook as an option. The imported
Notification Delivery Service remains an optional qualification/deep-dive path while runtime
admission, default cutover, release, and live verification remain gated.

Notification acceptance is not vendor delivery, and neither state determines scenario, workflow,
PRMS, review, or acceptance status.

## MVP and deferred scope

The MVP includes:

- Scenario Pack schema, lock, loader, and sealed catalog;
- capability normalization that preserves legacy workflow behavior;
- atomic local scenario instance store and recovery evidence;
- declarative `software-delivery` foundation;
- one live Contract-to-Delivery Lite pack;
- preview-first OpenSlack canonical plans;
- Organization Graph and BusinessOutcome projection;
- console/direct-local notification intent;
- a static read-only HTML artifact.

Deferred:

- formal Qoder Workbench;
- public remote Connector and OAuth;
- real DingTalk writeback;
- full CRM, ERP, or HR adapters;
- employee-onboarding live execution;
- Notification Delivery admission/default cutover;
- arbitrary third-party executable packs.

## Non-goals

Scenario Runtime does not:

- replace OpenSlack Workflow Runtime, Operator, Agent Runtime, PRMS, or GitHub Task Loop;
- permit executable Scenario Packs;
- turn `openslack.plugin.v1` into a dynamic code loader;
- let a pack grant capabilities, trust, approval, or adapter registration;
- promise transactional rollback of external systems;
- make graph or scenario state authoritative over GitHub or enterprise systems;
- allow Qoder or an agent to approve a GitHub PR;
- create a second competing live MVP scenario;
- claim `SCENARIO_REHEARSED`, `QODER_VERIFIED`, or `INTERVIEW_READY` from design documentation.

## Related documents

- [`qoder-work-integration.md`](qoder-work-integration.md)
- [`organization-graph.md`](organization-graph.md)
- [`dynamic-workflows.md`](dynamic-workflows.md)
- [`approval-vocabulary.md`](approval-vocabulary.md)
- [`notification-delivery.md`](notification-delivery.md)
- [`../developer/scenario-pack.md`](../developer/scenario-pack.md)
- [`../security/scenario-pack-boundary.md`](../security/scenario-pack-boundary.md)
- [`../demos/ai-organization-commercial-loop.md`](../demos/ai-organization-commercial-loop.md)
