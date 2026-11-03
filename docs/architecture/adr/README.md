---
schema: openslack.document.v1
id: architecture-adr-index
status: In Review
authority: index
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-11-03
sources:
  - docs/architecture/architecture.md
  - docs/architecture/adr/adr-0001-single-root-memory-bank.md
  - docs/architecture/adr/adr-0002-multi-go-service-workspace.md
  - docs/architecture/adr/adr-0003-harness-closed-loop-repair.md
  - docs/architecture/adr/adr-0004-run-storage-recovery.md
  - docs/architecture/adr/adr-0005-task-claim-v2-single-host.md
---

# Architecture Decision Records

Significant new decisions receive immutable ADRs here. Existing implementation
facts migrated from older documents remain In Review until the Full
architecture review identifies which decisions need formal ADR extraction.

| ADR                                                | Status    | Decision                                                                                                 |
| -------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| [ADR-0001](adr-0001-single-root-memory-bank.md)    | In Review | Use one root Memory Bank and one JSON control plane                                                      |
| [ADR-0002](adr-0002-multi-go-service-workspace.md) | In Review | Aggregate independent Go modules in a development workspace                                              |
| [ADR-0003](adr-0003-harness-closed-loop-repair.md) | Accepted  | Preserve governed execution, full evidence and owned process shutdown across Bridge failures             |
| [ADR-0004](adr-0004-run-storage-recovery.md)       | Accepted  | Inspect and reconcile run storage without replaying execution or deleting unresolved evidence            |
| [ADR-0005](adr-0005-task-claim-v2-single-host.md)  | Proposed  | Separate single-host Task Claim authority from exact Cleanup permission; no implementation or activation |
