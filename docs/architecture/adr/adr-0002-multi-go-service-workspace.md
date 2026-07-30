---
schema: openslack.document.v1
id: architecture-adr-multi-go-service-workspace
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-07-30
sources:
  - docs/architecture/architecture.md
  - memory_bank/t1_axioms/tech_context.md
  - services/notification-delivery/go.mod
  - services/notification-delivery/Dockerfile
  - .github/workflows/notification-delivery-service.yml
---

# ADR-0002: Aggregate Independent Go Service Modules with a Development Workspace

- Status: In Review
- Date: 2026-07-30
- Decision owners: Architecture and Project Governance
- Scope: Go service modules, local workspace composition, and CI isolation

## Context

OpenSlack currently uses a TypeScript root workspace and one process-isolated Go
module, `services/notification-delivery`. The planned Organization Graph,
Governance Control, Workflow Control, Repository Observer, remote MCP Gateway,
and Agent Execution Supervisor introduce additional durable service boundaries.
They must be able to evolve, qualify, publish, and roll back independently
without creating a root Go module or changing TypeScript frontend and workflow
ownership.

A developer workspace is useful for local cross-service navigation and
compilation. It is not a release authority. Go workspace selection can change a
module's build list, and `go work sync` may update the workspace modules.
Service CI therefore needs to prove that each module remains complete when the
root workspace is disabled.

This decision does not migrate any runtime authority. It establishes the
governance and verification boundary required before another Go service is
added.

## Decision

Each Go service owns an independent module:

```text
services/<service-name>/go.mod
services/<service-name>/go.sum
```

The repository root may contain a committed `go.work` that lists reviewed
service modules for developer convenience. The repository will not add a root
`go.mod`, and the workspace will not become a shared release or dependency
authority.

Every service CI and release job must:

1. set `GOWORK=off`;
2. assert that `go env GOWORK` returns the literal value `off`;
3. run module-local tidy, formatting, build, vet, and race tests; and
4. add capability-specific database, OpenAPI, container, metrics, SBOM, or
   provenance checks only when that service owns the corresponding capability.

`go mod tidy` is run from one service module at a time. Routine CI must not run
`go work sync`. A `go.work.sum` is committed only when the pinned Go toolchain
actually generates hashes not already covered by module `go.sum` files; an
empty placeholder is forbidden.

The initial workspace contains only:

```text
./services/notification-delivery
```

A new service is added to `go.work` in the same reviewed batch that adds a
real, importable, tested module. Empty health-only service shells are not
eligible.

## Service Boundaries

Go is the preferred implementation language for ADR-approved services that own
durable state, concurrency control, process supervision, or a remote network
boundary. TypeScript remains the authority for Qoder Skill content, CLI/TUI,
the Operator planner, the JavaScript Workflow DSL and runner, and provider
adapters unless a later ADR changes one of those explicit boundaries.

Each durable object has one authority writer in a routing epoch. Shadow
implementations use a separate namespace and cannot change user responses,
approval state, or authoritative storage. Authority transfers require
differential qualification, durable acceptance receipts, an explicit routing
epoch, and a rollback path.

## Alternatives Considered

### One root Go module

Rejected. A root module couples dependency upgrades, qualification, release,
and rollback for services with different risk and capability profiles. It also
makes repository-wide commands appear authoritative when no root Go product
exists.

### No committed workspace

Rejected. Developers would need private workspace files or repetitive
`replace` directives for cross-module work, and repository tooling could not
enumerate the reviewed local module set deterministically.

### Commit a workspace without isolated CI

Rejected. Green checks could depend on workspace-only replacements or
dependencies that are absent from a service release context.

### Convert the existing Notification Delivery service into a shared template

Rejected. Its service-local history, controls, and acceptance evidence are
authority-bound to that product. New services may reuse proven patterns but
must not rewrite its stage, batch, review archive, or implementation history.

## Consequences

Positive consequences:

- services retain independent dependency and release lifecycles;
- local multi-module development has one reviewed module list;
- CI detects accidental workspace coupling;
- capability-specific controls avoid empty outbox, worker, or database
  scaffolding; and
- TypeScript and Go ownership remains explicit during migration.

Costs and risks:

- shared library changes require deliberate version or workspace coordination;
- root `go.work` edits can create cross-module drift if `go work sync` is used
  casually;
- each new service needs an independent CI and deployment qualification track;
  and
- local developers without the pinned Go toolchain use the containerized
  verifier rather than relying on an unverified host installation.

## Validation

This decision is enforced by:

- the registered T2 Go service standard;
- a root `go.work` added by the following GS0-B batch;
- `scripts/go-check.sh` module-local verification;
- `GOWORK=off` assertions in each Go service CI/release job;
- independent service module builds and race tests; and
- PRMS classification, review, and human approval when Red Zone CI paths
  change.

Reversal requires a new ADR that preserves independent release evidence and
provides an atomic migration for every affected module and CI job. Removing
`go.work` alone does not change service authority, and adding a root `go.mod`
without such an ADR is invalid.
