---
schema: openslack.document.v1
id: cdd-workstream-notification-delivery
status: In Review
authority: canonical
audience:
  - contributors
owner: product
updated: 2026-07-28
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Notification Delivery

Notification Delivery is OpenSlack's process-isolated path for durable Slack and webhook
notifications. OpenSlack durably records the final vendor bytes and route identity before handing
the notification to an independent Go service. The service then owns PostgreSQL-backed outbox
processing, bounded retries, vendor delivery, and dead-letter recovery.

It is a repository service and cross-process integration, not a sixth OpenSlack product module.

## Current Lifecycle

| Field               | Value                            |
| ------------------- | -------------------------------- |
| Repository import   | `PASS`                           |
| IB6 receipt closed  | `true`                           |
| PX2 exit            | `PENDING_POST_MERGE_AUDIT`       |
| Repository          | `services/notification-delivery` |
| Runtime admission   | `GATED`                          |
| IB7 default cutover | `NOT_AUTHORIZED`                 |
| Release             | `UNRELEASED`                     |
| LIVE_VERIFIED       | `NOT_CLAIMED`                    |

The [IB6 receipt](../../../../integration/gates/ib6-history-import.json) proves repository history
import and productization closure only. It does not prove PX2 exit, runtime admission, external
delivery, release, production readiness, or live verification.

## Why It Exists

Direct HTTP delivery couples GitHub event processing to vendor availability. It also leaves the
caller responsible for durable retries, crash recovery, dead-letter handling, and determining
whether an ambiguous network result was accepted.

The durable path separates those concerns:

```text
OpenSlack GitHub event
  -> final Slack or webhook bytes
  -> content-addressed Blob
  -> durable route queue
  -> Notification Delivery Service
  -> PostgreSQL transactional outbox
  -> approved vendor endpoint
```

The process boundary keeps OpenSlack's task loop and local queue separate from the service's
database, delivery worker, vendor registry, and operational API.

## What `202 Accepted` Means

A strict `202 Accepted` means the service has durably accepted the notification and OpenSlack may
transfer delivery authority to it. It does **not** mean Slack, a webhook receiver, or any other
vendor has received the notification.

Before the receipt is durably committed, OpenSlack may retry the same immutable idempotency key.
After the route becomes `accepted`, the service permanently owns vendor delivery for that route.
OpenSlack must not direct-send it, re-render its bytes, or reroute it.

Use [metadata-only reconciliation](../../../../docs/user/guides/notification-delivery-operations.md#reconcile-one-route)
to distinguish service acceptance from a verified vendor delivery projection.

## Product Modes

| Mode                      | Path                                                 | Intended use                                                                        |
| ------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Local Console Mode        | OpenSlack -> local console                           | Local observation without the delivery service or an external vendor                |
| Direct Compatibility Mode | OpenSlack -> Slack or webhook                        | Historical direct path retained for migration and draining existing records         |
| Durable Delivery Mode     | OpenSlack Blob/queue -> service -> PostgreSQL outbox | Durable handoff and service-owned delivery; new-record admission is not the default |

Console routes use the local backend. Slack and webhook routes may use the direct compatibility
backend or the notification-service backend under the explicit v2 contract. The service accepts
only server-approved vendor identities and endpoints; it is not an arbitrary URL proxy.

## Supported Sinks

- `console` for local-only observation.
- `slack` for direct compatibility or durable service delivery.
- `webhook` for direct compatibility or durable service delivery.

Supported sink names do not imply that durable runtime admission is enabled. The current lifecycle
table remains authoritative for that boundary.

## Non-Goals

Notification Delivery does not claim:

- exactly-once delivery or cross-notification ordering;
- payload templating, field mapping, schema conversion, or caller-selected URLs;
- automatic replay of dead records;
- fallback from an accepted service record to direct delivery;
- multi-region active-active operation or a Kafka-based backbone;
- PX2 exit, IB7 cutover, release, production readiness, or `LIVE_VERIFIED`.

## Where To Go Next

| Goal                                  | Read                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Check readiness and operate the queue | [Operations guide](../../../../docs/user/guides/notification-delivery-operations.md)                      |
| Find the exact CLI flags              | [CLI reference](../../../../docs/user/cli-reference.md)                                                   |
| Decide where to change code           | [Developer entrypoint](../../../../docs/contributor/notification-delivery/README.md)                      |
| Understand authority transfer         | [Cross-process integration contract](../../../../docs/architecture/integrations/notification-delivery.md) |
| Review the security boundary          | [Security boundary](../../../../docs/security/notification-delivery-boundary.md)                          |
| Inspect gate and test evidence        | [Evidence map](../../../../docs/evidence/notification-delivery-evidence.md)                               |
| Understand the Go service internals   | [Notification Delivery Service README](../../../../services/notification-delivery/README.md)              |

## Overview

This workstream coordinates OpenSlack's durable route queue with the
process-isolated Notification Delivery service.

## User Promise

Users can observe durable acceptance, bounded retry, dead-letter recovery, and
vendor delivery evidence without coupling GitHub processing to vendor
availability.

## Data Model

Final vendor bytes, content-addressed blob, route identity, durable queue item,
service outbox record, attempt, delivery result, and dead-letter state.

## Edge Cases

Ambiguous network results, duplicate delivery, expired authorization, invalid
vendor targets, history import, and process crash fail closed or reconcile
through explicit evidence.

## Dependencies

OpenSlack delivery packages and the service-local Go/PostgreSQL boundary.

## Configuration

Runtime admission, vendor allowlists, credentials, release, and cutover are
independent gates. Root documentation does not rewrite service-local CDD,
Memory Bank, receipts, or workspace manifest.

## Acceptance Criteria

- PX2, runtime admission, release, and live verification remain separate claims.
- Existing service documentation verification continues to pass.
- Root evidence indexes service-local history without duplicating it.
