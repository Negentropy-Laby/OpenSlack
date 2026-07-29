---
schema: openslack.document.v1
id: context-ux-accessibility
status: In Review
authority: canonical
audience:
  - contributors
owner: ux
updated: 2026-07-29
sources:
  - design/ux/product-roadmap.md
  - docs/contributor/tui-style-guide.md
  - services/notification-delivery/design/ux/surface-profile.md
  - services/notification-delivery/design/accessibility-requirements.md
---

# UX and Accessibility Context

OpenSlack has CLI, TUI, chat, and documentation-driven surfaces. Status language
must be precise, scannable, and available as text rather than color alone.
Interactive confirmation must expose the exact action, actor, scope, and
remaining gates. Dynamic state is linked, not copied into translated guides.

Notification Delivery is headless. Its applicable accessibility obligation is
API ergonomics rather than a visual WCAG surface: stable versioned errors,
sanitized status, idempotent asynchronous acceptance, enumeration-safe
failures, preview-before-execute replay, partial-batch results, and clear
OpenAPI/runbook guidance. A future CLI or GUI requires a new accessibility
review.
