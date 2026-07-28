---
schema: openslack.document.v1
id: governance-basic-law-index
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: project-governance
updated: 2026-07-28
sources:
  - memory_bank/document_map.yaml
  - AGENTS.md
---

# OpenSlack Basic Law Index

These laws are proposed by the documentation migration and are not in force
until an authorized human signs the ratification section in
`active_context.md`. Until then, existing repository governance remains in
force.

## BL-01 — Root Memory Bank Authority

- Status: `Proposed`
- Rule: The root Memory Bank is authoritative for project plans and portfolio state.
- Design test: A project-wide status or ownership claim must trace to a canonical
  Memory Bank YAML record.

## BL-02 — Delivery Authority

- Status: `Proposed`
- Rule: GitHub and OpenSlack are authoritative for task claims, reviews, pull
  requests, and delivery evidence.
- Design test: Memory Bank records must link to observed delivery evidence and
  cannot replace it.

## BL-03 — Independent Claims

- Status: `Proposed`
- Rule: Module maturity, quality gates, release state, live verification, and
  human approval must be stated independently.
- Design test: No green check may imply release, production, or approval.

## BL-04 — Planned and Executing Identity Separation

- Status: `Proposed`
- Rule: Planned ownership and actual execution identity are separate fields;
  missing planned ownership is explicitly `unassigned`.
- Design test: A claim ref or agent run cannot silently rewrite the planned owner.

## BL-05 — Single Authority and Fail-Closed Resolution

- Status: `Proposed`
- Rule: Each fact class has exactly one canonical source. Conflicts or missing
  evidence fail closed.
- Design test: A projection cannot promote or override its canonical source.
