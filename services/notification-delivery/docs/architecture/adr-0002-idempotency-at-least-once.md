# ADR-0002: Inbound Idempotency and Outbound At-Least-Once

## Status

Accepted

## Date

2026-07-20

## Summary

Provide strong inbound deduplication using caller-scoped idempotency keys plus a stable request fingerprint, while
explicitly delivering external HTTP at least once. Endpoint configuration may map the stable notification ID into a
vendor-supported idempotency header or body field.

## Context

Clients must safely retry uncertain submission responses, but accepting different payloads under the same key would
silently lose work. Conversely, after an outbound timeout or process crash, the service cannot know whether the vendor
applied a request; refusing to retry would lose critical notifications.

## Decision

- Unique key: `(caller_id, Idempotency-Key)`.
- Fingerprint v1 is the SHA-256 of the exact byte sequence
  `vendor_id || 0x00 || caller_id || 0x00 || ingress_idempotency_key || 0x00 || decoded_payload_bytes`. The ingress
  idempotency key is therefore an input; outbound Content-Type is not. This documents the shipped algorithm and does
  not authorize changing existing fingerprints or historical rows. Golden vectors freeze ordinary, empty, embedded
  NUL, UTF-8 and non-UTF-8 payload cases. The delimiter framing relies on a contract precondition: caller/principal
  IDs, vendor IDs and ingress idempotency keys pass their authoritative NUL-free regex validation before
  `ValidatedIntake`; `ValidateIntake` alone does not establish that precondition.
- Same key/fingerprint returns the original notification and `202`; same key/different fingerprint returns
  `409 IdempotencyConflict`.
- Outbound retry/recovery is at-least-once; unknown results count as attempts.
- Mapping modes are closed: `none`, `header`, or a single flat JSON-object `body_field`.
- Retry/replay uses the same normalized notification ID; service never claims vendor-side exactly-once.

## Alternatives

| Alternative | Decision |
|---|---|
| exactly-once HTTP | Rejected as unprovable across external timeout/crash boundaries |
| at-most-once | Rejected because lost payment/inventory notifications are unacceptable |
| key-only dedup | Rejected because changed payload under reused key would be hidden |
| service-side vendor payload templates | Rejected; violates delivery-pipe boundary |

## Consequences

Callers can safely converge intake. Vendors that honor idempotency keys can suppress duplicate side effects; vendors
that do not may observe duplicates, which remains a documented business reconciliation risk.

## Validation

Golden fingerprint vectors, same/different payload concurrency, commit-outcome-unknown convergence, retry/replay
stable ID checks and crash-after-send fault injection.

## CDD Requirements Addressed

T0 BL-02, Product Concept lifecycle, Notification Store intake/immutable identity, Vendor Registry outbound mapping,
Delivery DL-15/17.

## Dependencies

Depends on ADR-0001 atomic persistence.
