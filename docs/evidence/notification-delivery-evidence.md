---
schema: openslack.document.v1
id: evidence-notification-delivery
status: In Review
authority: canonical
audience:
  - contributors
owner: qa
updated: 2026-07-28
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Notification Delivery Evidence Map

This page indexes authoritative evidence without copying its contents. A receipt owns its exact
gate result; narrative documentation does not replace it.

## Current Gate Boundary

| Gate or claim             | Current repository fact          | Authority                                                                                                  |
| ------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `IB6-HISTORY-IMPORT`      | `PASS`; `closed=true`            | [`integration/gates/ib6-history-import.json`](../../integration/gates/ib6-history-import.json)             |
| `PX2-EXIT`                | `PASS`                           | [`integration/gates/ib6-px2-post-merge-audit.json`](../../integration/gates/ib6-px2-post-merge-audit.json) |
| Post-import qualification | No passing sealed receipt exists | Future protected run and sealed report; current schema/workflow are contracts, not run evidence            |
| Runtime admission         | `GATED`                          | [Cross-process integration contract](../architecture/integrations/notification-delivery.md)                |
| IB7 default cutover       | `NOT_AUTHORIZED`                 | Same integration boundary                                                                                  |
| Release / `LIVE_VERIFIED` | `UNRELEASED` / `NOT_CLAIMED`     | Same integration boundary; requires later independent evidence and authorization                           |

IB6 proves repository import history and the governed productization chain. The independent PX2
receipt proves only the protected post-merge audit. Neither is live delivery evidence and neither
can substitute for qualification, IB7, release, or production readiness.

## IB6 History Import

| Evidence                  | Path                                                                                                                                                      | Purpose                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Final receipt             | [`integration/gates/ib6-history-import.json`](../../integration/gates/ib6-history-import.json)                                                            | Gate result, closure, source/history binding, authorization, non-claims |
| PX2 audit receipt         | [`integration/gates/ib6-px2-post-merge-audit.json`](../../integration/gates/ib6-px2-post-merge-audit.json)                                                | Append-only post-merge ruleset, review, and ancestry binding            |
| PX2 receipt schema        | [`notification-delivery-px2-post-merge-audit.v1.schema.json`](../reference/schemas/integration/notification-delivery-px2-post-merge-audit.v1.schema.json) | Mechanical PX2 receipt shape                                            |
| Receipt schema            | [`notification-delivery-ib6-history-import.v1.schema.json`](../reference/schemas/integration/notification-delivery-ib6-history-import.v1.schema.json)     | Mechanical receipt shape                                                |
| Order explanation         | [`notification-delivery-ib6-order-supersession.md`](notification-delivery/ib6-order-supersession.md)                                                      | Prose ordering and deferred-release boundary                            |
| Source manifest v2        | [`source-manifest.v2.json`](../../services/notification-delivery/integration/source-manifest.v2.json)                                                     | Frozen source, imported tree, history and pre-Phase-F binding           |
| Source manifest v2 schema | [`source-manifest.v2.schema.json`](../../services/notification-delivery/integration/schemas/source-manifest.v2.schema.json)                               | Mechanical source-manifest shape                                        |

The historical pre-Phase-F pending value inside the predecessor source manifest and receipt binding
is retained as provenance. It is not the current gate state.

## Platform Queue Evidence

| Evidence             | Path                                                                                            | Purpose                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| G3 queue receipt     | [`docs/evidence/integration-gates/g3-queue.json`](integration-gates/g3-queue.json)              | Local queue, migration, router, and governed-operations gate                     |
| Integration contract | [`notification-delivery-integration.md`](../architecture/integrations/notification-delivery.md) | Body, Blob, receipt, client, states, recovery, reconciliation, and gate ordering |

G3 is local integration evidence. It does not prove external E2E delivery or service production
readiness.

## Service Implementation Evidence

| Evidence                | Path                                                                                                       | Purpose                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Acceptance criteria map | [`ac-evidence.json`](../../services/notification-delivery/docs/testing/ac-evidence.json)                   | Requirement-to-test/evidence mapping             |
| Acceptance report       | [`acceptance-report.json`](../../services/notification-delivery/docs/testing/acceptance-report.json)       | Standalone implementation acceptance baseline    |
| Fault drill             | [`fault-drill-report.md`](../../services/notification-delivery/docs/testing/fault-drill-report.md)         | Service failure-injection and recovery evidence  |
| PITR report             | [`pitr-report.md`](../../services/notification-delivery/docs/testing/pitr-report.md)                       | Isolated backup/restore rehearsal                |
| Capacity report         | [`capacity-report.md`](../../services/notification-delivery/docs/testing/capacity-report.md)               | Machine-local capacity baseline, not an SLA      |
| Marker scan             | [`marker-scan-report.md`](../../services/notification-delivery/docs/testing/marker-scan-report.md)         | Bounded marker and disclosure checks             |
| IB4 local report        | [`ib4-r1-local-report.json`](../../services/notification-delivery/docs/testing/ib4-r1-local-report.json)   | Local integration/reconciliation evidence        |
| Workspace manifest      | [`workspace-manifest.sha256`](../../services/notification-delivery/docs/testing/workspace-manifest.sha256) | Imported service subtree file-integrity contract |

These records describe service implementation and local acceptance. Imported standalone acceptance
does not declare the current OpenSlack roadmap, module maturity, runtime admission, release, or
live status.

## Post-Import Qualification Contract

| Contract or input               | Path                                                                                                                        | Current meaning                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Report schema                   | [`notification-import-qualification.schema.json`](../../packages/github/src/notification-import-qualification.schema.json)  | Metadata-only sealed report contract                                       |
| Environment manifest v2         | [`environment-manifest.v2.json`](../../deploy/notification-import-qualification/environment-manifest.v2.json)               | Pending external-input contract with fixed repository and route identities |
| Environment manifest schema     | [`environment-manifest.v2.schema.json`](../../deploy/notification-import-qualification/environment-manifest.v2.schema.json) | Mechanical v2 environment validation                                       |
| Protected workflow              | [`notification-import-qualification.yml`](../../.github/workflows/notification-import-qualification.yml)                    | Future externally backed single-run orchestration                          |
| Historical supersession receipt | [`g5-import-qualification-supersession.json`](../../integration/gates/g5-import-qualification-supersession.json)            | Historical gate-order decision; not a post-import PASS receipt             |

A future run writes a sealed metadata-only report under the protected local qualification evidence
directory and exposes it through:

```bash
openslack github notifications qualification status
openslack github notifications qualification report
```

At the time of this index, the repository contains no passed post-import qualification receipt.
`QUALIFICATION_NOT_RUN` or an absent sealed report is not an error to paper over; it preserves the
external-input and IB7 authorization boundary.
