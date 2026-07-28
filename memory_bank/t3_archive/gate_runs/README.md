---
schema: openslack.document.v1
id: evidence-gate-run-index
status: In Review
authority: index
audience:
  - reviewers
owner: qa
updated: 2026-07-28
sources:
  - memory_bank/t0_core/release_state.yaml
---

# Gate Run Index

Gate runs must record command, revision, environment, result, and scope. The
current release gate state is canonical in `release_state.yaml`; this directory
indexes immutable supporting records added by reviewed changes.
