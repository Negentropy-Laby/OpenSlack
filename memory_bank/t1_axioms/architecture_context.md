---
schema: openslack.document.v1
id: context-architecture
status: In Review
authority: canonical
audience:
  - contributors
owner: architecture
updated: 2026-07-29
sources:
  - docs/architecture/README.md
  - design/cdd/module-index.md
  - docs/architecture/integrations/notification-delivery.md
  - services/notification-delivery/docs/architecture/architecture.md
---

# Architecture Context

OpenSlack is a Git-backed collaboration system with five product modules and
cross-cutting workstreams. Product modules define user-facing ownership;
packages and services implement workflows without becoming additional product
modules.

The authority chain is:

`CDD requirement -> architecture/control -> structured assignment -> GitHub/OpenSlack execution -> indexed evidence`

Runtime module telemetry is projected from `.openslack/modules.yaml`. Project
portfolio, ownership, release, approval, and live-verification claims are
outside that registry and remain in their dedicated authorities.

## Notification Delivery

Notification Delivery remains a process-isolated Go service and a project
workstream, not a sixth OpenSlack product module. Its six logical components
are Notification Store, Vendor Registry, Caller Access, Delivery, Operations
Control, and Reliability Observability.

Its load-bearing decisions remain service-owned:

- PostgreSQL is the sole persistent state and transactional-outbox authority.
- Ingress is strongly deduplicated while outbound delivery is at-least-once.
- Workers claim with bounded leases; retry/dead policy is owned by Delivery.
- Only approved vendor endpoints are dialed through DNS-pinned, redirect-free,
  proxy-free SSRF controls.
- Caller and operator authority comes from server-derived API-key identity,
  vendor scope, and capability attenuation.

The detailed architecture and ADRs stay under
`services/notification-delivery/docs/architecture/`. Their project-level
support bindings are indexed at
`memory_bank/control-plane.json#/support/notificationDelivery`.
