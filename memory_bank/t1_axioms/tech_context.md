---
schema: openslack.document.v1
id: context-technology
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-07-29
sources:
  - package.json
  - services/notification-delivery/go.mod
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

Notification Delivery currently pins Go 1.26.5, chi v5, pgx v5,
golang-migrate v4, and PostgreSQL 18.4. PostgreSQL unavailability fails intake
and workers closed; there is no local persistence fallback. Capacity evidence
is a machine-specific baseline and must not be promoted into an SLA without a
separate reviewed decision.
