---
schema: openslack.document.v1
id: architecture-traceability-matrix
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: architecture
updated: 2026-07-28
sources:
  - design/cdd/module-index.md
  - memory_bank/t1_axioms/module_support_map.yaml
  - memory_bank/t2_execution/work_assignments.yaml
---

# Architecture Traceability Matrix

| Scope               | CDD                                      | Architecture                                            | Work/evidence authority               |
| ------------------- | ---------------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| Self-Evolution      | `design/cdd/modules/self-evolution.md`   | `docs/architecture/components/self-evolution-kernel.md` | Memory assignments + GitHub/OpenSlack |
| GitHub Task Loop    | `design/cdd/modules/github-task-loop.md` | `docs/architecture/components/github-task-loop.md`      | Memory assignments + GitHub/OpenSlack |
| Operator            | `design/cdd/modules/operator.md`         | `docs/architecture/components/operator.md`              | Memory assignments + GitHub/OpenSlack |
| PR Review and Merge | `design/cdd/modules/pr-review-merge.md`  | `docs/architecture/components/pr-review-merge.md`       | Memory assignments + GitHub/OpenSlack |
| Collaboration       | `design/cdd/modules/collaboration.md`    | `docs/architecture/components/collaboration.md`         | Memory assignments + GitHub/OpenSlack |
| Workstreams         | `design/cdd/workstreams/*/README.md`     | component/integration documents                         | Memory assignments + indexed evidence |

Detailed requirement-level rows are added during Full review. Until then, no
In Review CDD is promoted to Approved.
