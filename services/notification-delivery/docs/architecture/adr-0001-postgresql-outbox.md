# ADR-0001: PostgreSQL Transactional Outbox and Concurrency

## Status

Accepted

## Date

2026-07-20

## Summary

Use PostgreSQL 18.4 as the only persistent state and coordination authority. Notification intake, outbox visibility,
lease/state changes and append-only attempt history are transactionally coupled; workers claim with
`FOR UPDATE SKIP LOCKED`.

## Context

Returning `202` before durable, schedulable state exists can lose critical notifications. Writing a database fact and
publishing directly to a broker creates a dual-write failure window. The MVP also needs query, replay and audit state
without operating several data systems.

## Decision

- Pending notification rows are the outbox; dead rows are the DLQ.
- Intake stores immutable identity/body/fingerprint and schedulable visibility in one transaction.
- Claim locks eligible rows with `FOR UPDATE SKIP LOCKED`, records one lease/claimed event and commits.
- Result/recovery/replay transactions atomically update state/version/counts/timestamps and append history.
- Vendor admin transactions atomically update record/version, audit and idempotency receipt.
- pgx v5 is the PostgreSQL-native driver; SQL and transaction boundaries are explicit, without an ORM.

## Alternatives

| Alternative | Decision |
|---|---|
| Kafka/RabbitMQ as direct work queue | Rejected: database/queue dual write or extra relay and infrastructure |
| PostgreSQL outbox plus broker relay | Deferred until measured database wake/throughput limits |
| SQLite | Rejected as concurrent-worker production authority |
| PostgreSQL + MySQL portability layer | Rejected: duplicate behavior/locking implementation without MVP benefit |

## Consequences

Positive: one atomic truth source, simple recovery/query/replay, multiple workers without duplicate lease ownership.

Negative: PostgreSQL availability bounds intake/delivery; append-only growth requires measurement and later retention;
polling latency may eventually require LISTEN/NOTIFY.

## Validation

- failure injection before/after commit proves no partial notification/outbox/attempt state;
- concurrent claims yield one lease;
- stale lease/version result writes have zero side effects;
- migrations preserve immutable identity and append-only history.

## CDD Requirements Addressed

Notification Store BL-03/NS-BR-01/02/03, Delivery DL-14/16, Operations replay atomicity, Vendor Registry receipt/audit
atomicity, Reliability global query.

## Dependencies

None. Enables ADR-0002 through ADR-0004 and the master architecture.

