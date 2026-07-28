---
schema: openslack.document.v1
id: standard-technical-preferences
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-07-28
sources:
  - package.json
  - services/notification-delivery/go.mod
---

# Technical Preferences

Use strict TypeScript and Node.js 22+ for the root workspace, Bun for dependency
and test orchestration, and Go for the isolated Notification Delivery service.
Prefer deterministic pure functions, explicit schemas, repository-relative
POSIX paths, fail-closed parsing, and package-owned logic with thin CLI
orchestration.
