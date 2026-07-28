---
schema: openslack.document.v1
id: context-knowledge-graph
status: In Review
authority: index
audience:
  - contributors
owner: project-governance
updated: 2026-07-29
sources:
  - memory_bank/control-plane.json#/authorities
  - docs/architecture/traceability-matrix.md
  - services/notification-delivery/design/cdd/module-index.md
---

# Governance Knowledge Graph

The durable graph is expressed through stable document IDs and structured
references:

`basic law -> CDD -> architecture/control -> assignment -> Issue/claim/PR -> evidence index`

`memory_bank/control-plane.json#/authorities` owns fact authority. The traceability matrix
maps product requirements to implementation and evidence. The runtime
Organization Graph remains a projection feature and does not replace this
governance graph.

Notification Delivery adds a scoped chain without adding another Memory Bank:

`ND-BL -> service CDD -> service ADR/control -> Go component/test -> root T3 index`

Its component DAG is:

`Notification Store <- Delivery, Operations Control, Reliability Observability`

`Vendor Registry <- Delivery`

`Caller Access <- Operations Control`

The full support edges are machine-readable at
`memory_bank/control-plane.json#/support/notificationDelivery`.
