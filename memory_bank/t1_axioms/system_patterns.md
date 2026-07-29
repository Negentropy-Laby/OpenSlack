---
schema: openslack.document.v1
id: context-system-patterns
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-07-29
sources:
  - docs/architecture/architecture.md
  - docs/architecture/control-manifest.md
  - services/notification-delivery/docs/architecture/control-manifest.md
---

# System Patterns

- Fail closed when identity, evidence, or authority bindings are missing.
- Keep project control state canonical and projections reproducible.
- Separate planning identity from executing identity.
- Prefer sealed, bounded contracts at process and trust boundaries.
- Keep human approval distinct from agent analysis and execution.
- Keep one root Memory Bank; service governance contributes scoped sections,
  support bindings, and evidence records without creating a second authority.

## Notification Delivery Patterns

- Transactional outbox: intake state and delivery visibility commit together.
- At-least-once delivery: ingress deduplication is strong; outbound duplicate
  effects remain an explicit risk.
- Bounded lifecycle: claim, attempt, retry, deadline termination, dead state,
  and manual replay have sealed transition contracts.
- Data ownership: only a logical component writes its owned tables; cross-
  component behavior uses typed in-process interfaces.
- Safe transport: endpoint selection is registry-owned; DNS resolution,
  address policy, pinned dialing, TLS host identity, no redirects, and no
  environment proxy fail closed.
- Reliability signals: outbox depth, oldest pending age, and dead count are
  Store-derived; Reliability Observability projects them without taking
  delivery-state ownership.
