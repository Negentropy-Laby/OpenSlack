---
schema: openslack.document.v1
id: execution-workflow-contract
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-07-28
sources:
  - memory_bank/t2_execution/work_assignments.yaml
  - standards/approval-vocabulary.md
---

# Work Assignment and Status Contract

## State Machine

`planned -> ready -> claimed -> running -> review -> done`

`blocked`, `reconciliation_required`, and `cancelled` are explicit terminal or
repair branches. Transitions require evidence in the same reviewed change.

## Identity

- `planned_owner`: accountable plan owner or literal `unassigned`.
- `execution.agent_id`: observed executing identity; never inferred from the plan.
- `execution.claim_ref`: observed deterministic claim reference.

## External Evidence

Issue, claim, PR, review, checks, and delivery evidence are verified in
GitHub/OpenSlack before this mirror changes. The first phase intentionally has
no bidirectional or scheduled synchronization.

## Fail-Closed Rules

- An open Issue with a merged associated PR is `reconciliation_required`.
- A status promotion without evidence is rejected.
- `.openslack/modules.yaml` may update module telemetry only.
- Missing identity or conflicting sources stop the transition.
