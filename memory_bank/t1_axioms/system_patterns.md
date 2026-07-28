---
schema: openslack.document.v1
id: context-system-patterns
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-07-28
sources:
  - docs/architecture/architecture.md
  - docs/architecture/control-manifest.md
---

# System Patterns

- Fail closed when identity, evidence, or authority bindings are missing.
- Keep project control state canonical and projections reproducible.
- Separate planning identity from executing identity.
- Prefer sealed, bounded contracts at process and trust boundaries.
- Keep human approval distinct from agent analysis and execution.
- Index service-local governance; do not duplicate or rewrite it at root.
