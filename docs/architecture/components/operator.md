---
schema: openslack.document.v1
id: architecture-operator
status: In Review
authority: canonical
audience:
  - contributors
owner: operator
updated: 2026-07-28
sources:
  - design/cdd/modules/operator.md
---

# Operator Architecture

The CLI orchestrates registered package actions. `@openslack/operator` resolves
intent into typed action candidates; risk, parameter, confirmation, permission,
and executor gates run after routing. Provider output is data, never executable
code or an unregistered command.
