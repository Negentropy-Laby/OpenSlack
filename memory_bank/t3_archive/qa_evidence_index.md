---
schema: openslack.document.v1
id: evidence-qa-index
status: In Review
authority: index
audience:
  - reviewers
owner: qa
updated: 2026-11-24
sources:
  - docs/evidence/README.md
---

# QA Evidence Index

- Root documentation validation: `bun run docs:verify`
- Migration closure: `bun run docs:migration-check`
- Module telemetry: `bun run openslack status verify`
- Notification documentation: `bun run docs:notification-verify`
- Full code gates: recorded per pull request; no result is inferred here.
- [Workflow and maintenance closeout evidence](../../docs/evidence/README.md#workflow-qualification-closeout)
