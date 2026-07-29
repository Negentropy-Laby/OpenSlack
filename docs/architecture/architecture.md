---
schema: openslack.document.v1
id: architecture-master
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-07-30
sources:
  - design/cdd/product-concept.md
  - design/cdd/module-index.md
  - .openslack/modules.yaml
  - memory_bank/control-plane.json
  - memory_bank/t1_axioms/tech_context.md
---

# OpenSlack Master Architecture

## System Context

OpenSlack converts human or agent intent into governed repository work. Chat,
CLI, TUI, and MCP are bounded frontends. GitHub and Git own task and delivery
facts; the root Memory Bank owns project planning and portfolio state.

## Product Modules

The five modules are product ownership boundaries. Packages may support more
than one module and do not define the project hierarchy.

## Workstreams and Services

Workstreams coordinate cross-module implementation. Notification Delivery is a
process-isolated Go service with service-owned CDD and implementation
documentation. The single root Memory Bank owns project governance and indexes
the service boundary without rewriting its stage, batch, review archive, or
implementation history.

## Authority Flow

1. Product requirements are approved in CDDs.
2. Architecture and the control manifest constrain implementation.
3. Work assignments plan ownership without inventing execution identity.
4. GitHub/OpenSlack records claims, PRs, reviews, checks, and delivery.
5. Evidence indexes and project YAML are reconciled by reviewed pull request.

## Data and Trust Boundaries

- Repository governance files: versioned and reviewed.
- Developer-local `.openslack`/tool state: identity-scoped and not project state.
- GitHub: external work and review authority.
- Notification service: process and database boundary.
- Negentropy/Qoder/Aby: explicit external host boundaries; no implicit authority.

## Failure Semantics

All governance boundaries fail closed. Projection staleness, conflicting
authority, missing identity, missing approval, or unverifiable promotion blocks
the corresponding action without upgrading adjacent state.
