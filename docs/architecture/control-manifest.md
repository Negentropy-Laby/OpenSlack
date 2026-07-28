---
schema: openslack.document.v1
id: architecture-control-manifest
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-07-28
sources:
  - memory_bank/t0_core/basic_law_index.md
  - docs/architecture/architecture.md
---

# Architecture Control Manifest

## Must

- Read canonical YAML before editing a generated state view.
- Bind task execution to observed Issue, claim, branch, and PR evidence.
- Preserve package, process, identity, and approval boundaries.
- Record missing ownership as `unassigned`.
- State local, hosted, release, live, and approval results separately.

## Must Not

- Hand-edit generated roadmap or state Markdown.
- Treat `.openslack/modules.yaml` as portfolio, assignment, release, or approval authority.
- Rewrite Notification Delivery service-local history or its workspace manifest.
- Infer approval, production readiness, or live verification.
- introduce a second authority for an existing fact class.
