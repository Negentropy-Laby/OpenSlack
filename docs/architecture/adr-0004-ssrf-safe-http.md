# ADR-0004: SSRF-Safe Outbound HTTP and Secret References

## Status

Accepted

## Date

2026-07-20

## Summary

Only Registry-approved HTTPS endpoints may be contacted. Delivery validates every resolved address, dials a pinned
approved IP with original-host TLS verification, rejects redirects/proxies and resolves opaque credentials only for
the current attempt.

## Context

An outbound notification service can become a high-value SSRF/open-proxy primitive. URL allowlists alone do not stop
DNS rebinding, redirect chains, IPv6/private ranges or implicit environment proxies. Storing plaintext credentials
with endpoint configuration expands breach and logging risk.

## Decision

- Caller submits `vendor_id` and payload only; Registry owns canonical scheme/host/port/path and Header policy.
- HTTPS only; URL userinfo/fragment and unapproved method/port are invalid.
- Resolve all A/AAAA answers and fail the entire attempt if any address is forbidden or lacks the exact exception.
- Dial a selected validated `netip.Addr` directly; TLS `ServerName` remains the original hostname.
- MVP uses per-attempt keep-alive-disabled transport, no environment proxy and a redirect callback that always fails.
- Read only status and bounded Retry-After, never response body.
- Registry stores `env://NAME`; startup allowlist controls names and Delivery keeps secret bytes only in attempt scope.

## Alternatives

| Alternative | Decision |
|---|---|
| caller-supplied URL | Rejected: open-proxy/SSRF boundary violation |
| hostname allowlist without pinned dial | Rejected: DNS rebinding |
| follow redirects then revalidate | Rejected for MVP: expands request count and policy surface |
| static plaintext credential in DB | Rejected |
| Vault/KMS-only MVP | Deferred; sound but adds external infrastructure not required by the assignment |

## Consequences

The transport is deliberately conservative and gives up connection reuse in MVP. Private endpoints require explicit
hostname+port+CIDR exceptions. Environment secrets require restart for rotation and should evolve to managed secrets
when operational need is proven.

## Validation

IPv4/IPv6 special-range tables, mixed safe/unsafe answers, DNS rebinding, original-host TLS, redirect, proxy,
credential/log scanning, Header injection and timeout tests.

## CDD Requirements Addressed

T0 BL-05, Vendor Registry endpoint/credential policy, Delivery DL-10..13/17/20 and security threat model.

## Dependencies

Depends on ADR-0001 for Registry persistence and ADR-0003 for privileged configuration.

