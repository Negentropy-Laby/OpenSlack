---
schema: openslack.document.v1
id: governance-active-context
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: project-governance
updated: 2026-07-29
sources:
  - memory_bank/t0_core/basic_law_index.md
  - memory_bank/control-plane.json
  - docs/reference/document-path-migration-v1.yaml
---

# Active Governance Context

- Constitution version: `0.1-draft`
- Portfolio lifecycle: `active_development`
- CDD compatibility stage: `Implementation`
- Review mode: `Full`
- Ratification: `PENDING_HUMAN_SIGN_OFF`

The documentation control plane is operational as an In Review governance
proposal. The five basic laws remain `Proposed`; implementation of the tooling
does not itself ratify them.

The repository is consolidating service governance into this single root
Memory Bank. `memory_bank/control-plane.json` is the sole structured project
governance file; `.openslack/modules.yaml` remains the separate module telemetry
authority. No service or package may own another `memory_bank/` directory.

## Notification Delivery Context

- Scope: `services/notification-delivery/`
- Local lifecycle: B1-B6 are implemented, mechanically verified, independently
  reviewed, and recorded as local submission-ready.
- Independent non-claims: PX2, runtime admission, OpenSlack release, and live
  verification remain separate and are not promoted by the consolidation.
- Accepted scoped laws: ND-BL-01 through ND-BL-06 in
  `basic_law_index.md`.
- Architecture: Go service using PostgreSQL transactional outbox,
  at-least-once delivery, bounded retry/dead state, guarded replay, and
  SSRF-safe approved endpoints.
- Evidence: `t3_archive/reviews/notification-delivery-implementation.md`,
  `t3_archive/gate_runs/notification-delivery.md`, and service-owned
  `docs/testing/` receipts.

## Ratification

No human sign-off has been recorded. An authorized human must review each law
and amend this section through a pull request before any law becomes `Accepted`.

## Changelog

| Version     | Date       | State     | Change                                                                                                                               |
| ----------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `0.1-draft` | 2026-07-28 | In Review | Established the root T0–T3 control plane and proposed BL-01 through BL-05.                                                           |
| `0.2-draft` | 2026-07-29 | In Review | Consolidated Notification Delivery governance under the only root Memory Bank without changing either law set's ratification status. |
