---
schema: openslack.document.v1
id: memory-bank-index
status: In Review
authority: index
audience:
  - contributors
  - reviewers
owner: project-governance
updated: 2026-07-29
sources:
  - memory_bank/control-plane.json#/authorities
  - docs/architecture/adr/adr-0001-single-root-memory-bank.md
---

# OpenSlack Project Memory Bank

This root Memory Bank is the project-wide governance control plane. It records
portfolio status, release gates, planned ownership, cross-module dependencies,
and evidence indexes for all OpenSlack contributors.

It is intentionally separate from `.openslack/`, which is a developer/runtime
workspace and may contain identity-scoped local state. GitHub and OpenSlack
remain authoritative for actual Issue claims, pull requests, reviews, and
delivery evidence.

This is the repository's only `memory_bank/` directory. Packages, services, and
developer workspaces contribute scoped facts and evidence here; they must not
create another Memory Bank.

## Tiers

- `t0_core/`: proposed laws and current portfolio/release state.
- `t1_axioms/`: architecture, technology, UX, QA, and traceability context.
- `t2_execution/`: work assignment, workflow contracts, executable standards,
  and the generated roadmap.
- `t3_archive/`: durable indexes for gates, reviews, releases, QA, and amendments.

`control-plane.json` is the only structured governance file in this directory;
YAML is forbidden here. Its `/authorities`, `/portfolio`, `/release`,
`/assignments`, `/support`, and `/migrations` sections are stable authority
boundaries. Generated Markdown projections are read-only and are refreshed
with `bun run docs:generate`.

Within `/assignments`, planned allocations are canonical project facts.
Execution identity, claim, Issue/PR, review, merge, and delivery data are
reviewed snapshots of GitHub/OpenSlack and must be reverified before use.

Notification Delivery laws and current context are merged into the existing
T0-T2 documents. Its support bindings live at
`control-plane.json#/support/notificationDelivery`, and its normalized
amendment, gate, and implementation-review records live in the existing flat
T3 directories. Exact former source text remains recoverable through Git
history; no duplicate original archive is maintained.
