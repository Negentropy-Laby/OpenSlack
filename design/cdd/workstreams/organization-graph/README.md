---
schema: openslack.document.v1
id: cdd-workstream-organization-graph
status: In Review
authority: canonical
audience:
  - contributors
owner: product
updated: 2026-08-02
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Organization Graph

| Field              | Value                                                                        |
| ------------------ | ---------------------------------------------------------------------------- |
| Status             | `COMPOSITE GRAPH + LOCAL REHEARSAL IMPLEMENTED — LIVE QUALIFICATION PENDING` |
| Product direction  | Projection-first                                                             |
| First source model | Software delivery evidence                                                   |
| Lead scenario      | Contract-to-Delivery Lite                                                    |
| Authority          | Derived and rebuildable; never authoritative mutation state                  |

The `@openslack/organization-graph` package, local snapshot store, bounded query/explain APIs,
software-delivery projector, Contract-to-Delivery Lite composite projector, and read-only MCP
tools implement the graph core described here. The governed local rehearsal explicitly assembles
the fixture-backed source only after durable Scenario and Workflow evidence, publishes through the
sealed graph builder, and verifies query/explain through the official MCP SDK. Live multi-system
evidence and the offline HTML artifact remain later milestones.

## Product outcome

Organization Graph reconstructs an explainable view of organizational work from authoritative
systems and OpenSlack evidence:

```text
GitHub / OpenSlack run evidence / future enterprise systems
                         |
                         v
              bounded typed source snapshots
                         |
                         v
              deterministic projectors
                         |
                         v
         versioned graph snapshot and deltas
                         |
             +-----------+-----------+
             |                       |
             v                       v
       bounded MCP query       static HTML artifact
```

The graph answers:

- what business and delivery objects exist in one scenario instance;
- how they relate;
- which authority supplied each fact;
- which owner, blocker, and next action are visible;
- which source evidence is missing;
- how the projection changed between cursors.

It does not replace GitHub, Collaboration events, workflow/run storage, PRMS, Notification
Delivery, CRM, ERP, HR, or DingTalk.

## Foundation reused from QW0–QW2

### QW0

The fixed manufacturing workflow and recorded run remain deterministic fixture input for
projector and rendering tests. They establish stable phase, artifact, evidence, and correlation
shapes, but do not become a second lead graph scenario.

### QW1

`BusinessOutcomeProjection` remains the business-metric boundary. Graph nodes may link to its
evidence-backed outcome snapshot, and the static artifact may render it beside the graph. The
graph does not recalculate economic truth, create a KPI database, or upgrade configured estimates
to observed facts.

### QW2

`apps/mcp` and `packages/qoder-adapter` remain the transport and business-language boundaries. The
planned graph tools are added to that existing frontend after the graph package and projectors
exist:

```text
openslack_list_scenarios
openslack_query_graph
openslack_explain_graph
```

The graph package never imports MCP, CLI, GitHub, PRMS, workflow, or notification implementations.
Composition adapters gather typed snapshots and inject them into pure projectors.

## Authority contract

Every graph fact has explicit provenance.

An authority reference contains:

```text
provider
object type
object ID
external or OpenSlack version
observation time
```

The provider describes where the fact came from, not who may mutate it. Examples include GitHub,
OpenSlack, a visibly non-live demo fixture, and future DingTalk/CRM/ERP/HR adapters.

Rules:

- GitHub owns Issue, Pull Request, Check, Review, and Merge facts.
- OpenSlack owns its local workflow runs, events, handoffs, decisions, plans, and receipts.
- Enterprise adapters may project only facts supplied by their bound systems.
- A demo fixture is always identified as non-live and cannot be reported as observed external
  authority.
- A graph write updates only derived projection state. It never authorizes a source mutation.
- A graph read never initializes missing authority state or silently converts missing evidence to
  authoritative zeroes.

## Product model

The first schema family is:

```text
openslack.graph_snapshot.v1
openslack.graph_delta.v1
```

A graph node includes:

- a stable ID;
- ontology type, title, and optional state;
- scenario definition and instance IDs;
- authority reference;
- bounded owners and properties;
- source event and evidence references;
- projector version;
- validity interval.

A graph edge includes:

- a stable ID and relationship type;
- source and target node IDs;
- scenario instance ID;
- optional authority reference;
- source event and evidence references;
- projector version;
- validity interval.

A snapshot includes:

- opaque source cursor;
- scenario instance ID;
- generation time and projector version;
- canonically ordered nodes and edges;
- completeness statement;
- integrity hash.

A delta includes:

- from/to cursors;
- node and edge upserts;
- explicit node and edge closures;
- evidence references;
- integrity hash.

Closing a derived object preserves history. Projectors do not silently erase a node or edge when
the underlying evidence disappears.

## Stable identity and integrity

Stable node and edge IDs derive from scenario instance, ontology type, and authority object
identity. Display names, titles, ordering, or local filesystem paths are not identity.

The integrity contract is:

1. validate the closed schema and all bounds;
2. sort nodes, edges, properties, and references canonically;
3. serialize canonical JSON;
4. exclude only `generatedAt` and `integrityHash` from the content digest;
5. calculate SHA-256;
6. verify the digest before accepting a stored snapshot as projection evidence.

Identical source content produces the same content hash across Windows and Linux path
environments. Changing a source cursor, authority version, graph object, relationship,
completeness statement, or evidence reference changes the hash.

## Completeness and explanation

Every snapshot reports:

```text
sources requested
sources observed
missing sources
warnings
```

Incomplete evidence produces an incomplete projection, not an invented fact.

`graph.explain` returns bounded:

- authority and version;
- source events and evidence references;
- projector version;
- completeness and truncation state;
- the relationship path used to reach the result.

It does not expose raw transcripts, credential material, webhook payload prose, or unbounded source
objects.

## Query bounds

The product hard maximums are:

```text
depth             3
nodes             200
edges             500
response bytes    512 KiB
property depth    8
property keys     64 per object
property items    200 per array
evidence refs     50 per node or edge
```

Queries are deterministic and report truncation. Pagination cursors are opaque and bound to the
normalized query hash; a cursor for one scenario, filter, depth, or evidence setting cannot be
reused for another.

These are ceilings, not targets. Composition adapters may impose tighter live-read deadlines,
page limits, and record limits.

## Local projection store

The MVP store is local and rebuildable:

```text
.openslack.local/graph/
  snapshots/
  deltas/
  cursors/
  locks/
```

The store accepts only fatal UTF-8, strict schema-valid, regular files within the configured graph
root. It rejects traversal, symlinks, alternate data streams, non-regular files, oversized files,
oversized directories, duplicate JSON keys, and same-file identity changes during a read.

Writes use explicit modes, atomic write-and-rename, a per-scenario lock, and compare-and-swap cursor
publication. A partial write or stale writer cannot publish a new current cursor. Stored bytes are
projection cache/evidence only; they never outrank a fresh authoritative observation.

Neo4j or another graph database is not required for the MVP.

## First projector: software delivery

The first projector consumes an injected, bounded software-delivery source snapshot. It changes no
existing GitHub behavior.

| Source object             | Graph meaning              |
| ------------------------- | -------------------------- |
| Issue                     | `core.work_item`           |
| Label                     | State, risk, or capability |
| Assignee                  | `assigned_to`              |
| Claim ref                 | `execution_lease`          |
| Worktree                  | `execution_context`        |
| Commit                    | `artifact_revision`        |
| Pull Request              | `reviewable_deliverable`   |
| Check                     | `verification_evidence`    |
| Current-head human Review | `human_decision`           |
| Merge                     | `accepted_transition`      |
| Closed Issue              | `outcome`                  |

Additional injected evidence includes workflow and agent-run summaries, current-head PRMS reports,
handoffs, and decisions.

Synthetic or cached PR observations remain informational. Stale human reviews never become a
current decision, and a green check never becomes approval. A missing authority version or
current-head binding appears as incomplete evidence.

## Separation from current Collaboration views

The Collaboration `ObjectKind` remains a coordination and delivery-observation model for issues,
PRs, plans, modules, agents, handoffs, decisions, workspaces, workflows, pushes, profile-sync jobs,
and notification routes. GS3-A/GS3-B/GS3-C additionally permit `graph` only as the
scenario-instance handle for digest-only read-mirror, bounded canary, or global read-authority
observations. Customer, Contract,
Project, Milestone, Acceptance, and
other business-domain entities still belong to scenario ontology and are never copied into
Collaboration event metadata.

The existing Team Dashboard remains task/PR-oriented:

```text
task counts
PR counts
blockers
handoffs
decisions
recent events
```

Scenario View is a separate graph projection. The planned Scenario Runtime adds only the minimum
`scenario` coordination object and lifecycle events needed to bind a scenario instance to existing
events and runs.

## MVP boundary

The implemented local graph slice includes:

- pure graph contracts, canonicalization, integrity, bounded query, explanation, and local store;
- a deterministic software-delivery projector;
- one locked Contract-to-Delivery Lite Pack whose reviewed local Workflow reuses the
  software-delivery subgraph in the same snapshot;
- the Scenario list plus bounded graph query/explain tools;
- a strict file/stdin builder with sealed Software Delivery and Contract-to-Delivery dispatch;
- fixture build, store readback, and official MCP SDK query/explain evidence;
- a default-off, workspace/scenario/epoch/build-bound Go query/explain canary with explicit
  higher-epoch TypeScript rollback, v2 epoch-bound cursors, the same bounded snapshot-freshness
  gate as TypeScript, no per-request fallback, and redacted Collaboration audit;
- a separate default-off global Go head/query/explain authority bound to one workspace/tenant,
  epoch, expiry, origin, and build. TypeScript projectors complete publication only after durable Go
  acceptance receipts; authority reads use dedicated v2 epoch-bound routes and required redacted
  audit, while rollback is an explicit higher global TypeScript epoch;
- a governed local rehearsal assembler that preserves `demo_fixture` business authority and calls
  the explicit sealed graph builder outside the read tools.

The static artifact owns no network fetch, authentication, mutation API, or persistent state.

## Deferred scope

After contract stability:

- DingTalk, CRM, ERP, and HR source projectors;
- live multi-system Contract-to-Delivery data;
- static, read-only HTML graph/outcome/evidence artifact;
- formal Qoder Workbench graph UI;
- remote Connector graph streaming;
- larger-scale graph databases or cross-workspace federation;
- writeback initiated from graph interactions.

## Non-goals

Organization Graph does not:

- become a business database or event source;
- add customer/contract/project types to every Collaboration event;
- replace Team Dashboard;
- infer approval, acceptance, delivery, revenue, or ownership without typed evidence;
- perform GitHub, DingTalk, CRM, ERP, or HR mutation;
- read external APIs from the pure graph package;
- accept arbitrary URLs, HTML, executable properties, or credentials;
- claim `GRAPH_REBUILT`, `SCENARIO_REHEARSED`, or `INTERVIEW_READY` from design documentation.

## Related documents

- [`qoder-work-integration.md`](../qoder-work/README.md)
- [`scenario-runtime.md`](../scenario-runtime/README.md)
- [`collaboration-layer.md`](../../modules/collaboration.md)
- [`module-04-pr-review-merge-steward.md`](../../modules/pr-review-merge.md)
- [`../developer/qoder-mcp.md`](../../../../docs/architecture/integrations/qoder-mcp.md)
- [`../developer/organization-graph-contract.md`](../../../../docs/architecture/contracts/organization-graph.md)
- [`../security/qoder-trust-boundary.md`](../../../../docs/security/qoder-trust-boundary.md)

## Overview

Organization Graph is a deterministic projection of explicitly supplied
software-delivery evidence.

## User Promise

Users can query and explain relationships while retaining provenance and
knowing when source batches are incomplete.

## Data Model

Stable entities, typed edges, source completeness, provenance, snapshot hash,
delta, query, and explanation.

## Edge Cases

Synthetic, stale, incomplete, expired, or self-review evidence remains
informational and cannot become current authority.

## Dependencies

`@openslack/organization-graph` and registered source projectors.

## Configuration

Snapshot builds accept bounded files or stdin. The default and explicit rollback path publishes
through CAS to the workspace-local graph store; an explicitly configured GS3-C path publishes only
through a tenant/epoch/build-bound durable Go receipt.

## Acceptance Criteria

- Rebuilds are deterministic.
- No network or authoritative mutation occurs in the projector.
- Queries preserve source completeness and provenance.
