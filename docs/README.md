---
schema: openslack.document.v1
id: docs-index
status: In Review
authority: index
audience:
  - all
owner: project-governance
updated: 2026-07-28
sources:
  - memory_bank/document_map.yaml
  - design/cdd/module-index.md
---

# OpenSlack Documentation

English documents are authoritative. The [Chinese guide](zh-CN/README.md)
explains navigation and team operations without copying dynamic state.

## By Audience

- [Users](user/README.md): install, CLI, core workflows, and operations guides.
- [Contributors](contributor/README.md): onboarding, module development, plugins,
  and cross-repository work.
- [Architecture](architecture/README.md): system, components, integrations,
  contracts, ADRs, traceability, and controls.
- [Security](security/README.md): trust and permission boundaries.
- [Operations](operations/README.md): release, automation, packaging, and recovery.
- [Reference](reference/README.md): schemas, vocabularies, and migration map.
- [Evidence](evidence/README.md): test, qualification, and review evidence indexes.
- [Examples](examples/README.md): runnable or rehearsable examples.
- [Archive](archive/README.md): historical plans and superseded material.

## Current State

- Project portfolio: `memory_bank/t0_core/project_state.yaml`
- Release gates: `memory_bank/t0_core/release_state.yaml`
- Planned assignments: `memory_bank/t2_execution/work_assignments.yaml`
- Module telemetry: [generated module status](status/current.md)
- Generated project roadmap: `production/project-roadmap.md`

## Notification Delivery Boundary

- Product CDD: `design/cdd/workstreams/notification-delivery/README.md`
- Operations: `docs/user/guides/notification-delivery-operations.md`
- Contributor entrypoint: `docs/contributor/notification-delivery/README.md`
- Security: `docs/security/notification-delivery-boundary.md`
- Evidence index: `docs/evidence/notification-delivery-evidence.md`
- Service-owned documentation: `services/notification-delivery/docs/README.md`

Run `bun run docs:verify` before submitting documentation changes.
