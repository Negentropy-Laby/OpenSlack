---
schema: openslack.document.v1
id: architecture-adr-single-root-memory-bank
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-07-29
sources:
  - memory_bank/README.md
  - memory_bank/control-plane.json
  - docs/architecture/architecture.md
---

# ADR-0001: Use One Root Memory Bank and One JSON Control Plane

- Status: In Review
- Date: 2026-07-29
- Decision owners: Project Governance and Architecture
- Scope: Repository documentation governance

## Context

OpenSlack has project-wide planning, release, assignment, architecture, and
evidence state. Notification Delivery was developed from an earlier template
and retained a second `memory_bank/` inside its service directory. That local
tree accurately recorded service history but created two places that appeared
to own T0-T3 governance.

The root project must allocate work across modules, workstreams, developers,
and agents. A service may own implementation documents and machine receipts,
but it cannot own a separate portfolio control plane. The previous root design
also split closely related structured facts across five YAML files, increasing
the chance of partial updates and ambiguous authority.

The consolidation must preserve these boundaries:

- OpenSlack project laws and Notification Delivery scoped laws have different
  ratification histories.
- Module telemetry remains authoritative in `.openslack/modules.yaml`.
- GitHub and OpenSlack remain authoritative for claims, reviews, PRs, and
  delivery evidence.
- Service implementation readiness does not imply runtime admission, release,
  or live verification.
- Historical source text may be recovered through Git; the repository does not
  need a duplicate original-document archive.

## Decision

The repository will contain exactly one directory named `memory_bank`, at the
project root.

`memory_bank/control-plane.json` is the sole structured governance control
file. Its stable JSON Pointer sections own:

- `/authorities` and `/documents`: fact authority and governed-document map;
- `/portfolio`: module and workstream portfolio state;
- `/release`: release train and independent gates;
- `/assignments`: canonical planned allocations plus reviewed snapshots of
  externally observed execution;
- `/support`: product-module and Notification Delivery support bindings; and
- `/migrations/memoryBankConsolidation`: source-to-target consolidation
  provenance.

No YAML or YML file is allowed under `memory_bank/`. The existing T0, T1, T2,
and T3 directories remain flat at their current tier boundaries; no
workstream-specific Memory Bank hierarchy is introduced.

`/assignments` does not take live execution authority from GitHub or OpenSlack.
It is canonical for planning fields such as `planned_owner`, dependencies, and
acceptance criteria. Execution identity, claim ref, Issue/PR state, review,
merge, and delivery fields are time-stamped observations; consumers must
reverify them against GitHub/OpenSlack before acting or promoting status.

Notification Delivery content is handled by type:

- scoped laws become ND-BL-01 through ND-BL-06 in the root T0 law index;
- current context is merged into existing root T0 and T1 documents;
- execution rules become a section of the existing root workflow contract;
- support bindings move into `/support/notificationDelivery`; and
- amendments, gate history, and implementation reviews become flat records in
  the existing root T3 directories.

The generated Markdown projection paths remain unchanged. Generation loads the
control plane once and renders project state, release state, and roadmap views.
Verification rejects nested Memory Banks, Memory Bank YAML, unresolved JSON
Pointers, stale projections, duplicate authorities, missing support targets,
or consolidation sources that still exist.

## Alternatives Considered

### Keep the service Memory Bank and add a root index

Rejected. An index clarifies navigation but does not remove the competing
T0-T3 authority surface or prevent service-local state from being mistaken for
project portfolio state.

### Move the service tree unchanged under a root workstreams directory

Rejected. This preserves a nested governance silo, conflicts with the flat
tier design, and makes workstream structure look like a second portfolio
hierarchy.

### Retain separate root YAML files

Rejected. Multiple structured authorities permit partial updates and require
cross-file joins for every status view. YAML also remains vulnerable to
format-specific ambiguity across tools.

### Store all governance in Markdown

Rejected. Markdown is suitable for reasoning and evidence but not for strict,
deterministic schema validation and projection generation.

## Consequences

Positive consequences:

- one discoverable project governance entry point;
- one atomic structured update surface;
- explicit JSON Pointer authority for every governed fact class;
- service history remains traceable without a duplicate source archive;
- project and service law scopes remain distinguishable; and
- CI can enforce the topology directly.

Costs and risks:

- `control-plane.json` is a multi-contributor merge hot spot;
- a malformed aggregate edit can affect several projections at once;
- old service Memory Bank links are intentionally broken and must be updated;
- service workspace-manifest hashes must be regenerated; and
- the Red Zone contributor instructions require independent human approval.

Performance implications are limited to documentation tooling and CI. A single
JSON read replaces several YAML reads; schema and link validation remain
linear in governed documents and support edges. Runtime product and service
request paths do not load this control plane.

The control plane mitigates merge pressure through stable section ordering,
ID-stable arrays, deterministic formatting, and narrow edits to the relevant
JSON Pointer section.

## Validation

The decision is enforced by:

- `bun run docs:generate`;
- `bun run docs:verify`;
- `bun run docs:migration-check`;
- `bun run docs:notification-verify`;
- Notification Delivery contract tests and workspace-manifest verification;
- root and service TypeScript tests; and
- repository workflow validation and PRMS on the bot-authored PR.

Reversing this decision requires a new ADR and one atomic reviewed migration
commit that changes the schema, loader, all affected source records,
projections, and links together. A partial rollback is invalid because it
would either restore sources rejected by the new verifier or leave the old
loader without its inputs. The replacement must retain a single unambiguous
authority for every fact class.
