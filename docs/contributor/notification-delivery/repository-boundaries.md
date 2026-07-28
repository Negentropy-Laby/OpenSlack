---
schema: openslack.document.v1
id: contributor-notification-delivery-boundaries
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-07-28
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Notification Delivery Repository Boundaries

The integration is split across an OpenSlack platform boundary, an independent Go service
boundary, and governed evidence. Each fact has one owner.

## Ownership Map

```text
packages/github
  route + final bytes + Blob + queue + handoff client + receipt
                    |
                    | strict 202 transfers authority
                    v
services/notification-delivery
  caller access + PostgreSQL outbox + worker + vendor delivery

integration contract = shared wire and authority semantics
governed receipt     = gate outcome
```

| Boundary                             | Owns                                                                                                            | Does not own                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/github`                    | Route identity, routing epoch, final vendor bytes, Blob, queue, receipt, client, local recovery, reconciliation | PostgreSQL state, service delivery worker, vendor registry, or service replay    |
| `services/notification-delivery`     | PostgreSQL, outbox, delivery attempts, approved endpoints and credentials, vendor delivery, service API         | OpenSlack product modules, runtime admission, default cutover, or release status |
| Integration contract                 | Idempotency, body, receipt, strict `202`, authority transfer, HTTP outcomes, reconciliation invariants          | Gate result or evidence PASS                                                     |
| Gate receipt                         | The exact governed result, scope, binding, authorization, and non-claims                                        | Runtime behavior or narrative replacement                                        |
| Root product and operations docs     | Audience-facing positioning, task flow, lifecycle boundaries, and navigation                                    | Service implementation algorithms or a duplicate OpenAPI                         |
| Service implementation documentation | Go architecture, data model, security implementation, operations, tests, and imported provenance                | OpenSlack module or release declarations                                         |

## Authority Before And After `202`

Before a valid acceptance receipt is durably committed, OpenSlack owns retry of the immutable
handoff. It may retry only with the same route identity, vendor, idempotency key, Blob, encoder, and
final bytes.

After the route is `accepted`, the Notification Delivery Service owns vendor delivery. OpenSlack
may read sanitized status and reconcile evidence, but it must not:

- direct-send the accepted record;
- change its destination or body;
- turn a status query into a replay;
- use the caller credential as the auditor credential; or
- infer vendor delivery from `202`.

The complete rules live in the
[cross-process integration contract](../../architecture/integrations/notification-delivery.md).

## Configuration And Credential Ownership

OpenSlack configuration identifies:

- the canonical service endpoint;
- a reference to the handoff caller credential;
- the expected service deployment digest; and
- route-owned vendor IDs.

The service owns the approved endpoint and credential versions behind those vendor IDs. OpenSlack
does not submit a vendor URL or vendor secret with a notification.

The read-only operations client uses a separate auditor credential reference. That principal can
query sanitized version, notification status, and attempt history; it cannot submit or replay.

## Status And Evidence Ownership

- `.openslack/modules.yaml` owns the five-module registry and generated status.
- The [IB6 receipt](../../../integration/gates/ib6-history-import.json) owns
  `IB6-HISTORY-IMPORT=PASS`, `closed=true`, and the pending PX2 value.
- A future sealed qualification report will own that run's result only.
- No documentation page may turn IB6 into PX2, IB7, release, production, or live evidence.

See the [evidence map](../../evidence/notification-delivery-evidence.md) for the current distinction
between committed repository evidence and work that has not run.
