---
schema: openslack.document.v1
id: governance-basic-law-index
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: project-governance
updated: 2026-07-29
sources:
  - memory_bank/control-plane.json#/authorities
  - AGENTS.md
  - services/notification-delivery/design/cdd/product-concept.md
  - services/notification-delivery/docs/architecture/control-manifest.md
---

# OpenSlack Basic Law Index

These laws are proposed by the documentation migration and are not in force
until an authorized human signs the ratification section in
`active_context.md`. Until then, existing repository governance remains in
force.

## BL-01 — Root Memory Bank Authority

- Status: `Proposed`
- Rule: The root Memory Bank is authoritative for project plans and portfolio state.
- Design test: A project-wide status or ownership claim must trace to a canonical
  Memory Bank YAML record.

## BL-02 — Delivery Authority

- Status: `Proposed`
- Rule: GitHub and OpenSlack are authoritative for task claims, reviews, pull
  requests, and delivery evidence.
- Design test: Memory Bank records must link to observed delivery evidence and
  cannot replace it.

## BL-03 — Independent Claims

- Status: `Proposed`
- Rule: Module maturity, quality gates, release state, live verification, and
  human approval must be stated independently.
- Design test: No green check may imply release, production, or approval.

## BL-04 — Planned and Executing Identity Separation

- Status: `Proposed`
- Rule: Planned ownership and actual execution identity are separate fields;
  missing planned ownership is explicitly `unassigned`.
- Design test: A claim ref or agent run cannot silently rewrite the planned owner.

## BL-05 — Single Authority and Fail-Closed Resolution

- Status: `Proposed`
- Rule: Each fact class has exactly one canonical source. Conflicts or missing
  evidence fail closed.
- Design test: A projection cannot promote or override its canonical source.

## Notification Delivery Scoped Laws

The following accepted laws govern only
`services/notification-delivery/`. They were signed for the service on
2026-07-18 and retain that scope after consolidation. They do not ratify
OpenSlack BL-01 through BL-05, which remain Proposed.

### ND-BL-01 — Delivery-Only Thesis

- Status: `Accepted (2026-07-18)`
- Rule: Notification Delivery is an internal outbound HTTP delivery pipeline,
  not a message broker, workflow engine, multi-region platform, or open proxy.
  Architecture evolution is triggered by measured conditions and requires an
  ADR before changing this law.

### ND-BL-02 — At-Least-Once and Ingress Deduplication

- Status: `Accepted (2026-07-18)`
- Rule: Delivery is at-least-once. Ingress deduplication uses the server-derived
  caller identity, `Idempotency-Key`, and immutable request fingerprint.
  Same-key/same-fingerprint requests return the original notification; a
  same-key/different-fingerprint request fails with
  `409 IdempotencyConflict`. Outbound idempotency fields are injected only
  when the approved endpoint configuration declares support.

### ND-BL-03 — Transactional Outbox

- Status: `Accepted (2026-07-18)`
- Rule: Intake persistence and delivery visibility commit in one PostgreSQL
  transaction. The outbox row is the delivery-state authority; direct
  database-plus-queue dual writes are forbidden.

### ND-BL-04 — Bounded Retry and Manual Dead-Letter Replay

- Status: `Accepted (2026-07-18)`
- Rule: Retry is bounded by attempt and wall-clock limits. Exhaustion enters an
  explicit `dead` state; dead rows are the DLQ and can return to delivery only
  through authorized manual replay.

### ND-BL-05 — Approved Targets and SSRF-Safe Delivery

- Status: `Accepted (2026-07-18)`
- Rule: Callers reference an approved vendor, never an arbitrary URL.
  Delivery enforces HTTPS, validates every resolved address, pins the approved
  address for connection, rejects non-public addresses unless a vendor-scoped
  exception exists, disables redirects and environment proxies, and does not
  interpret response bodies.

### ND-BL-06 — Reliability Requires Observable Evidence

- Status: `Accepted (2026-07-18)`
- Rule: Outbox depth, oldest pending age, dead count, and the executable
  dead-count alert are required before the service may claim reliability.

The supporting CDD, ADR, and executable-evidence bindings are canonical in
`memory_bank/control-plane.json#/support/notificationDelivery`. The original
service-local law document is recoverable through Git history and is not
duplicated as a second archive.
