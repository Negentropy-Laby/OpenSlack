# Requirements Traceability

> **Status**: Approved design trace
> **Implementation evidence**: 290/290 canonical AC + 4/4 NSBR mapped to existing tests; final cross-batch review Approved

## Coverage Result

`tr-registry.yaml` enumerates all **290 canonical acceptance criteria** from the six approved module CDDs, plus four
explicitly non-AC Notification Store boundary coverage mappings (`NSBR-05a..d`). All **294 trace identifiers**
inherit at least one architecture component, one Accepted ADR and one planned test type from their requirement
family.

| CDD | Canonical AC | Primary architecture owner |
|---|---:|---|
| Notification Store | 79 | Notification Store + PostgreSQL |
| Vendor Registry | 152 | Vendor Registry + PostgreSQL |
| Caller Access | 15 | HTTP API + Caller Access |
| Delivery | 20 | Delivery + safe HTTP transport |
| Operations Control | 14 | Operator API + Operations Control |
| Reliability Observability | 10 | metrics collector + Store projection |
| **Total** | **290** | six logical modules in one service |

The four boundary mappings make the mechanical trace-identifier total 294 but are not counted as AC. The YAML
registry is the mechanical source for coverage; this Markdown file explains the mapping and does not duplicate every
ID.

## Architecture-to-Requirement Matrix

| Architecture component | CDD families | ADR | Planned test types |
|---|---|---|---|
| HTTP API / composition | NS-INTAKE, NS-SECURITY, CALLER-ACCESS | ADR-0002, ADR-0003 | contract, integration, security negative |
| Caller Access | CALLER-ACCESS, VR-ACTOR-SCOPE, OPERATIONS-CONTROL | ADR-0003 | contract, concurrency, fault injection, security negative |
| Vendor Registry | all VR families, DELIVERY | ADR-0001, ADR-0003, ADR-0004 | contract, integration, concurrency, migration, security negative |
| Notification Store | all NS families, DELIVERY, OPERATIONS-CONTROL, RELIABILITY-OBSERVABILITY | ADR-0001, ADR-0002, ADR-0003 | logic, integration, concurrency, migration, fault injection |
| Delivery worker | DELIVERY, NS-STATE, NS-LEASE, NS-BOUNDARY | ADR-0001, ADR-0002, ADR-0004 | logic, integration, concurrency, fault injection, security negative |
| Safe HTTP transport / secret resolver | DELIVERY, VR-SECURITY | ADR-0004 | contract, integration, fault injection, security negative |
| Operations Control | OPERATIONS-CONTROL, NS-QUERY | ADR-0001, ADR-0003 | contract, integration, concurrency, fault injection |
| Reliability collector | RELIABILITY-OBSERVABILITY, NS-METRICS | ADR-0001, ADR-0003 | contract, logic, integration, fault injection |
| PostgreSQL | stateful NS/VR/Caller families | ADR-0001, ADR-0002, ADR-0003 | integration, concurrency, migration, fault injection |

## Decisive B-01 Trace

`DL-02`, `DL-07`, `DL-08`, `AC-STATE-04a` and `AC-ATT-04` converge on one contract:

1. a retryable HTTP/transport attempt may start before `cycle_send_cutoff`;
2. if result classification occurs at or after the cutoff, Delivery submits actual-result
   `die(permanent_failure, deadline_exceeded)` in the current Store write;
3. Store preserves the actual `http_status` or `error_code`, increments `attempt_count` exactly once, forbids
   `next_attempt_at`, clears the lease and atomically enters `dead`;
4. the planned contract/integration/fault-injection test asserts `dead_at <= cycle_deadline`;
5. an attempt that never sends remains the separate non-counting `policy_termination` history.

This closes the earlier second-claim timing gap without changing the at-least-once boundary.

## Review Scenarios

The architecture review must explicitly cover:

- idempotency conflict and confirmed rollback versus outcome unknown;
- lease claim/result/recovery races;
- vendor disable or credential rotation between attempts;
- DNS rebinding, forbidden A/AAAA, redirect, proxy and TLS hostname mismatch;
- API Key rotation/revocation and scope/capability attenuation;
- preview/execute replay races and partial results;
- Store unavailable during intake, delivery result, query and metric collection;
- alert collection failure without false zero or false resolution.

## Change Rule

A new or changed CDD AC must be added to `tr-registry.yaml` and
[`../testing/ac-evidence.json`](../testing/ac-evidence.json) in the same change, with component, ADR, test type and
existing test-function evidence. No AC may rely only on prose or an untracked implementation detail.
