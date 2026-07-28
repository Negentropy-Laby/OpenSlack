---
schema: openslack.document.v1
id: context-architecture
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-07-28
sources:
  - docs/architecture/README.md
  - design/cdd/module-index.md
---

# Architecture Context

OpenSlack is a Git-backed collaboration system with five product modules and
cross-cutting workstreams. Product modules define user-facing ownership;
packages and services implement workflows without becoming additional product
modules.

The authority chain is:

`CDD requirement -> architecture/control -> structured assignment -> GitHub/OpenSlack execution -> indexed evidence`

Runtime module telemetry is projected from `.openslack/modules.yaml`. Project
portfolio, ownership, release, approval, and live-verification claims are
outside that registry and remain in their dedicated authorities.
