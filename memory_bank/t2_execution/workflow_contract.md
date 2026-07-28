---
schema: openslack.document.v1
id: execution-workflow-contract
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-07-29
sources:
  - memory_bank/control-plane.json#/assignments
  - standards/approval-vocabulary.md
  - services/notification-delivery/production/stage.txt
  - services/notification-delivery/docs/development-plan.md
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

`memory_bank/control-plane.json#/assignments` is canonical for planned
allocations, dependencies, and acceptance criteria. Its execution identity,
claim, Issue, PR, review, merge, and delivery fields are time-stamped observed
snapshots only. Every action or status promotion must reverify those fields
against live GitHub/OpenSlack authority.

## Fail-Closed Rules

- An open Issue with a merged associated PR is `reconciliation_required`.
- A status promotion without evidence is rejected.
- `.openslack/modules.yaml` may update module telemetry only.
- Missing identity or conflicting sources stop the transition.

## Notification Delivery Execution Contract

Notification Delivery participates in this project workflow as the
`notification-delivery` workstream. Its service-local stage file remains an
implementation routing input, not a second project state authority.

- Current service stage: `Implementation`.
- Local evidence: B1-B6 mechanical acceptance and independent review are
  indexed by root T3.
- Delivery gates remain independent: local submission readiness does not claim
  PX2, runtime admission, OpenSlack release, or live verification.
- Service work must link the affected service CDD/ADR, exact acceptance
  evidence, executing identity, claim ref when claimed, and PR when delivered.
- New gate and review evidence is written directly to the appropriate flat root
  T3 record or to the service-owned machine receipt named by that record.
- The former service-local workflow contract is superseded by this section;
  its exact historical text remains available through Git.
