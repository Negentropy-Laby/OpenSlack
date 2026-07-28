---
schema: openslack.document.v1
id: evidence-gate-run-index
status: In Review
authority: index
audience:
  - reviewers
owner: qa
updated: 2026-07-29
sources:
  - memory_bank/control-plane.json#/release
---

# Gate Run Index

Gate runs must record command, revision, environment, result, and scope. The
current release gate state is canonical at
`memory_bank/control-plane.json#/release`; this directory indexes immutable
supporting records added by reviewed changes.

- Notification Delivery history:
  `memory_bank/t3_archive/gate_runs/notification-delivery.md`
