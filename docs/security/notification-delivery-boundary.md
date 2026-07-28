---
schema: openslack.document.v1
id: security-notification-delivery-boundary
status: In Review
authority: canonical
audience:
  - security
owner: security
updated: 2026-07-28
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Notification Delivery Security Boundary

This page describes the trust boundary between OpenSlack and the process-isolated Notification
Delivery Service. The service's internal implementation controls remain authoritative in its
[threat model](../../services/notification-delivery/docs/security/threat-model.md). Exact body,
receipt, retry, and HTTP rules remain authoritative in the
[cross-process integration contract](../architecture/integrations/notification-delivery.md).

## Authority Transfer

### Before strict `202`

OpenSlack owns the immutable handoff attempt. It persists final vendor bytes in a
content-addressed Blob and a route reference before network delivery. A retry must reuse the same
route identity, vendor, idempotency key, Blob, encoder, and bytes.

### After strict `202`

After OpenSlack durably commits a valid acceptance receipt:

- the service permanently owns vendor delivery for that route record;
- OpenSlack may observe only sanitized status and reconciliation evidence;
- OpenSlack must never direct-send, rerender, or reroute the accepted record; and
- a service status query does not transfer authority back.

`202 Accepted` proves durable intake, not vendor delivery.

## Principal Separation

The handoff caller and status auditor are distinct principals:

| Principal         | Allowed capability                                                          | Forbidden capability                                       |
| ----------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Handoff caller    | Submit immutable notification bytes for an approved vendor identity         | Service operations reads, replay, or vendor administration |
| Read-only auditor | Read version, sanitized notification state, and append-only attempt history | Submit notifications, replay, or mutate service state      |

OpenSlack must not reuse the caller credential for reconciliation. Operator access inside the
service is separately scoped and does not widen either OpenSlack principal.

## Credential Separation

- Configuration stores credential references, not secret values.
- Handoff and auditor secrets are resolved only for the bounded request callback.
- Vendor credentials remain behind service-owned vendor configuration.
- OpenSlack sends a vendor ID, never an endpoint URL or vendor secret.
- Logs, queue views, receipts, evidence, and documentation must not contain credential values.

## Non-Disclosure Boundary

Root operations and reconciliation surfaces are payload-blind. They may expose bounded metadata
such as route identity, vendor identity, state, counts, timestamps, digests, sizes, config versions,
and closed error codes.

They must not expose:

- GitHub event prose or notification payload bytes;
- Blob paths or retained raw bodies;
- caller, auditor, operator, or vendor secrets;
- service-approved endpoint values; or
- raw vendor response bodies.

Vendor delivery proof is a protected metadata-only record. It is not a copy of the vendor request
or response.

## SSRF And Redirect Boundary

The service, not the caller, selects an approved endpoint version. Safe outbound transport
requires:

- HTTPS except explicitly bounded insecure loopback in local testing;
- endpoint policy and DNS/IP validation;
- DNS pinning for the approved resolution;
- private, loopback, link-local, multicast, and otherwise forbidden address rejection; and
- redirects disabled.

OpenSlack applies the same no-redirect posture to handoff and operations clients and verifies the
configured service origin and expected deployment digest.

## No Direct Fallback

An accepted service record can never be imported into or claimed by direct delivery. Service
unavailability, a remote `dead` state, missing vendor evidence, or ambiguous network results do not
authorize fallback.

This prevents double ownership and avoids a second sender using different bytes, credentials, or
delivery semantics.

## Quarantine

Protocol conflicts, unexpected success status, idempotency conflict, deployment digest mismatch,
and other integrity failures fail closed. Quarantine is not a retry queue.

A governed retry or archive decision requires matching read-only reconciliation evidence. Archive
is append-only and terminal; it does not delete data or return authority to OpenSlack.

## Metadata-Only Reconciliation

Reconciliation joins three identities without reading payloads:

1. the local committed acceptance receipt;
2. the service's sanitized status and attempt history through the auditor principal; and
3. vendor evidence matching route ID, vendor ID, idempotency key, body digest and size, source, and
   timestamps.

Only a consistent three-party result may project `delivered`. Unavailable, missing, pending, dead,
or conflicting evidence remains explicit and fail-closed.

## Lifecycle Boundary

These controls document the implemented trust contract. They do not claim PX2 exit, runtime
admission, external configuration, post-import qualification, IB7 cutover, release, production
readiness, or `LIVE_VERIFIED`.

For operator tasks, use the
[Notification Delivery operations guide](../user/guides/notification-delivery-operations.md). For
evidence status, use the [evidence map](../evidence/notification-delivery-evidence.md).
