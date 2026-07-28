---
schema: openslack.document.v1
id: context-technology
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-07-28
sources:
  - standards/technical-preferences.md
  - package.json
---

# Technology Context

- Runtime: Node.js 22 or later; Bun is the package manager and test runner.
- Main language: strict TypeScript.
- Service exception: Notification Delivery is a process-isolated Go service.
- State: Git, GitHub, repository YAML/JSON, and service-owned PostgreSQL where
  explicitly bounded.
- Validation: offline deterministic generation, JSON Schema, TypeScript,
  Vitest, workspace validation, and PRMS.

Version details remain in package manifests and service module files; this page
records only cross-project constraints.
