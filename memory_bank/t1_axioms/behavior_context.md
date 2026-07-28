---
schema: openslack.document.v1
id: context-behavior
status: In Review
authority: canonical
audience:
  - contributors
owner: product
updated: 2026-07-28
sources:
  - design/cdd/product-concept.md
  - standards/approval-vocabulary.md
---

# Behavior Context

OpenSlack presents safe, observable workflows to humans while keeping
side-effect authority explicit. Preview, confirmation, GitHub approval,
mergeability, release, and live verification are separate user-visible states.

When evidence is absent or inconsistent, the user experience must show the
blocker and stop. It must not infer success from an adjacent green signal.
