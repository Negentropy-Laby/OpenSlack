---
schema: openslack.document.v1
id: context-behavior
status: In Review
authority: canonical
audience:
  - contributors
owner: product
updated: 2026-07-29
sources:
  - design/cdd/product-concept.md
  - standards/approval-vocabulary.md
  - services/notification-delivery/docs/operations/runbook.md
---

# Behavior Context

OpenSlack presents safe, observable workflows to humans while keeping
side-effect authority explicit. Preview, confirmation, GitHub approval,
mergeability, release, and live verification are separate user-visible states.

When evidence is absent or inconsistent, the user experience must show the
blocker and stop. It must not infer success from an adjacent green signal.

For Notification Delivery, submit, status query, preview, execute, partial
batch result, and operational recovery remain explicit API behaviors.
Submission is asynchronous and idempotent; replay is preview-first,
version-checked, justified, and authorized. Service-local implementation
approval is shown separately from OpenSlack runtime admission, release, and
live verification.
