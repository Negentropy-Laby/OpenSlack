---
schema: openslack.document.v1
id: contributor-notification-delivery-index
status: In Review
authority: index
audience:
  - contributors
owner: project-governance
updated: 2026-07-28
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Notification Delivery Developer Guide

This page routes a change to its owning repository boundary. It is not another architecture
specification. The cross-process contract remains
[`notification-delivery-integration.md`](../../architecture/integrations/notification-delivery.md), and service
implementation details remain under `services/notification-delivery`.

## Start By Change Location

| Change                                            | Primary owner                                                                                                    | Contract or evidence to review                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Route configuration, final bytes, Blob, queue     | [`packages/github`](../../../packages/github/src)                                                                | [Cross-process contract](../../architecture/integrations/notification-delivery.md)                |
| Handoff client, receipt, recovery, reconciliation | [`packages/github`](../../../packages/github/src)                                                                | [Security boundary](../../security/notification-delivery-boundary.md)                             |
| PostgreSQL, outbox, worker, vendor delivery       | [`services/notification-delivery`](../../../services/notification-delivery)                                      | [Service architecture](../../../services/notification-delivery/docs/architecture/architecture.md) |
| Service HTTP API                                  | [`openapi.yaml`](../../../services/notification-delivery/docs/api/openapi.yaml)                                  | Client and service contract tests                                                                 |
| Cross-process authority transfer                  | [`notification-delivery-integration.md`](../../architecture/integrations/notification-delivery.md)               | [Repository boundaries](repository-boundaries.md)                                                 |
| Gate status                                       | Governed receipt, beginning with [`ib6-history-import.json`](../../../integration/gates/ib6-history-import.json) | [Evidence map](../../evidence/notification-delivery-evidence.md)                                  |
| Product, operator, or security navigation         | Root `docs/**` entrypoints                                                                                       | [Product page](../../../design/cdd/workstreams/notification-delivery/README.md)                   |

## Implementation Surfaces

### Platform Side

`packages/github` owns the OpenSlack half of the handoff:

- v2 route parsing and routing epoch;
- immutable Slack/webhook body materialization;
- content-addressed Blob persistence;
- route queue, retry horizon, recovery history, and receipt storage;
- the write-only handoff client and separate read-only operations client;
- metadata-only vendor evidence and reconciliation;
- notification operations and qualification report verification.

### Service Side

`services/notification-delivery` is an independent Go module and process. It owns:

- caller authentication and vendor registry;
- PostgreSQL notification/outbox state;
- claim leases, delivery attempts, bounded retry, `dead`, and replay;
- safe outbound HTTP transport;
- service operations API, metrics, deployment assets, backups, and PITR procedures.

Start with the [service README](../../../services/notification-delivery/README.md), then use its
direct links to design, OpenAPI, architecture, data model, threat model, runbook, and tests.

### Cross-Process Contract

The [integration contract](../../architecture/integrations/notification-delivery.md) uniquely owns the semantics
that both sides must agree on: final bytes, idempotency identity, Blob and receipt formats, strict
`202`, authority transfer, HTTP classification, retry and reconciliation.

## Common Questions

### I am changing route, queue, Blob, receipt, client, or reconciliation behavior. Where?

Change `packages/github` and update the cross-process contract when observable handoff behavior
changes. Do not move PostgreSQL or vendor-worker policy into the TypeScript platform.

### I am changing PostgreSQL, outbox, worker, or vendor delivery behavior. Where?

Change the Go service. Update its architecture, data model, threat model, runbook, or OpenAPI as
needed. Do not use service documentation to declare OpenSlack module maturity or release status.

### I changed OpenAPI. What else must move?

Update the implementing Go handler/domain behavior, service contract tests, any affected
`packages/github` client parser, and the cross-process contract. Follow
[Change And Test Guide](change-and-test-guide.md#service-openapi).

### Why does a service documentation change affect a workspace manifest?

The imported service subtree has a content manifest enforced by Go contract tests. Any affected
service file must have its existing SHA-256 entry updated, and a new in-scope file must be added in
strict path order. The manifest does not hash itself.

### Which tests and risk zone apply?

Use [Change And Test Guide](change-and-test-guide.md). Files under `docs/**` are Green, while the
repository `README.md`, platform implementation, and service subtree make a change Yellow unless a
more protected path applies. `.github/**` workflow changes are Red. Risk classification does not
replace required checks or human approval.

## Related Reading

- [Repository boundaries](repository-boundaries.md)
- [Change and test guide](change-and-test-guide.md)
- [Operations guide](../../user/guides/notification-delivery-operations.md)
- [Security boundary](../../security/notification-delivery-boundary.md)
- [Evidence map](../../evidence/notification-delivery-evidence.md)
