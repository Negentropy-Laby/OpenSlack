---
schema: openslack.document.v1
id: memory-bank-index
status: In Review
authority: index
audience:
  - contributors
  - reviewers
owner: project-governance
updated: 2026-07-28
sources:
  - memory_bank/document_map.yaml
---

# OpenSlack Project Memory Bank

This root Memory Bank is the project-wide governance control plane. It records
portfolio status, release gates, planned ownership, cross-module dependencies,
and evidence indexes for all OpenSlack contributors.

It is intentionally separate from `.openslack/`, which is a developer/runtime
workspace and may contain identity-scoped local state. GitHub and OpenSlack
remain authoritative for actual Issue claims, pull requests, reviews, and
delivery evidence.

## Tiers

- `t0_core/`: proposed laws and current portfolio/release state.
- `t1_axioms/`: architecture, technology, UX, QA, and traceability context.
- `t2_execution/`: work assignment and workflow contracts plus generated roadmap.
- `t3_archive/`: durable indexes for gates, reviews, releases, QA, and amendments.

The authority for each fact is declared once in `document_map.yaml`. Generated
Markdown projections are read-only and are refreshed with
`bun run docs:generate`.
