---
schema: openslack.document.v1
id: standard-traceability
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-07-29
sources:
  - docs/architecture/traceability-matrix.md
  - memory_bank/t2_execution/workflow_contract.md
---

# Traceability Standard

This is the executable T2 traceability contract for planning and delivery.

Each active requirement traces from a stable CDD document ID to architecture,
an assignment or backlog record, planned owner, blockers, and evidence. External
Issue/PR references use full GitHub URLs in structured assignment fields.
Evidence must identify its scope and cannot promote an unrelated state.
