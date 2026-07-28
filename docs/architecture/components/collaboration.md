---
schema: openslack.document.v1
id: architecture-collaboration
status: In Review
authority: canonical
audience:
  - contributors
owner: collaboration
updated: 2026-07-28
sources:
  - design/cdd/modules/collaboration.md
  - docs/architecture/contracts/collaboration-events.md
---

# Collaboration Architecture

`@openslack/collaboration` validates and records bounded events, handoffs, and
decisions, then builds projection-only activity, digest, and room views.
Workflow and integration packages contribute typed evidence without transferring
their mutation or approval authority to a projection.
