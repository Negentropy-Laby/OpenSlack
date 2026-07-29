---
schema: openslack.document.v1
id: standard-technical-preferences
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-07-30
sources:
  - memory_bank/t1_axioms/tech_context.md
  - package.json
  - services/notification-delivery/go.mod
  - docs/architecture/adr/adr-0002-multi-go-service-workspace.md
---

# Technical Preferences

This is the executable T2 implementation baseline derived from project
technology context and package manifests.

Use strict TypeScript and Node.js 22+ for the root workspace and Bun for
dependency and test orchestration. TypeScript remains the preferred language
for Qoder Skill integration, CLI/TUI, the Operator planner, the JavaScript
Workflow DSL and runner, and provider adapters.

Use Go for independently deployed durable services only after an ADR defines
their process, state, authority, and rollback boundaries. Each service owns an
independent Go module and release track; root `go.work` is developer
aggregation, not dependency or release authority. Service CI and release jobs
must prove module independence with `GOWORK=off`.

Prefer deterministic pure functions, explicit schemas, repository-relative
POSIX paths, fail-closed parsing, package-owned logic with thin transport
orchestration, one authority writer per record and routing epoch, and durable
receipts at process boundaries. Apply database, outbox, worker, and public
network controls according to the service capabilities defined by the
registered Go service standard.
