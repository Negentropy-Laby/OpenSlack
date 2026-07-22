# Test Strategy

> Implemented test strategy. Current local evidence is indexed in `ac-evidence.json` and summarized in
> `acceptance-report.json`; GitHub-hosted CI has not run in this workspace.

## Test Layers

| Layer | Purpose | Examples |
|---|---|---|
| Contract | closed inputs/results/errors | OpenAPI, transition unions, ActorContext |
| Logic | deterministic policy | fingerprint, jitter, deadlines, Header mapping |
| Integration | PostgreSQL atomicity and HTTP seams | intake, claim, result, replay, Registry admin |
| Concurrency | races and OCC | double claim, stale result, replay race, receipt replay |
| Migration | history/invariant preservation | upgrade, rollback/restore, enum expansion |
| Fault injection | unknown outcomes and dependencies | commit loss, crash-after-send, DNS/TLS timeout |
| Security negative | trust-boundary rejection | SSRF, redirect, scope, secret/log leakage |
| Capacity baseline | measurement, not SLA | submission rate, backlog drain, table/query growth |

## Critical Scenarios

1. Same caller/key/fingerprint converges to one notification; different fingerprint returns 409 with no new state.
2. Intake rollback exposes neither notification nor outbox; successful commit exposes both.
3. Two workers compete: one valid lease; stale/expired holder cannot write a result.
4. Crash after possible send: recovery records `unknown_result`, increments attempt and permits at-least-once retry.
5. Retryable result before cutoff schedules no later than cutoff.
6. Attempt starts at `cycle_send_cutoff - epsilon`, finishes after cutoff and before deadline: the current write is
   actual-result `die(deadline_exceeded)`, retains status/error, increments once, has no `next_attempt_at`, and commits
   `dead_at <= cycle_deadline`.
7. A no-send cutoff uses policy termination and does not increment attempt count.
8. Vendor rotate/disable between attempts is observed by the next latest snapshot.
9. Any forbidden A/AAAA, redirect, proxy, DNS rebinding or TLS hostname mismatch produces no second request.
10. Preview followed by version change causes execute skip; key revocation between preview/execute rejects the request.
11. Store query failure exports no false metric zero; dead alert requires continuous successful samples.
12. Routine pepper rotation: after deploying active+previous and restarting, a key issued pre-rotation still
    authenticates (verifies under the previous `pepper_id`), a key issued post-rotation authenticates under the new
    `pepper_id`, and a referenced `pepper_id` with no loaded pepper makes startup fail-closed.
13. Backlog Path B: N attempts started before `cycle_send_cutoff`, each returning retryable at/after cutoff — each
    dies as an actual-result `die(deadline_exceeded)` in its own write, counts once, has no second claim, and
    `dead_at <= cycle_deadline` for all N (under the structural conditions in
    `design/cdd/reviews/deadline-backlog-pressure-analysis-2026-07-20.md`).
14. Backlog Path A: N pending rows become eligible inside the finalization window — each dies as a non-counting
    `policy_termination(deadline_exceeded)` and `dead_at <= cycle_deadline` for all N under the same structural
    conditions; the break-point N where honest-failure activates is recorded as a capacity measurement, not an SLA.

## Data and Oracles

- Use deterministic fake clock and randomness for logic; PostgreSQL transaction time remains the integration oracle.
- Use a controllable local vendor stub that can delay headers, return status/Retry-After, close sockets and count
  requests; it must never be used to weaken destination validation in production code.
- Assert database state, attempt history and response together after every atomic operation.
- Security tests scan logs/metrics/responses for forbidden payload, secret and credential-reference markers.

## OpenAPI and Documentation Checks

- Parse OpenAPI 3.1 and both YAML registries.
- Verify every local Markdown link, referenced path and unique ADR/TR ID.
- Compare OpenAPI operation IDs, errors and projections to CDD/entity registry.
- Reject unresolved placeholders, stale phase claims and incompatible status mirrors in active documents.

## Capacity Baseline

No pass/fail throughput or latency target is invented before implementation. The first benchmark report must record:

- CPU/memory, Go/PostgreSQL versions and database placement;
- dataset size, payload distribution, vendor latency/failure mix and worker count;
- sustained/burst input, p50/p95/p99 intake commit latency, backlog drain rate and oldest-age behavior;
- table/index growth and query plans.
- the relationship of backlog drain rate and oldest-pending-age to the deadline finalization window (see
  `design/cdd/reviews/deadline-backlog-pressure-analysis-2026-07-20.md`) — recorded as structural headroom, not an SLA.

Results establish evolution triggers; they do not retroactively become an external SLA without an ADR.

## Exit Criteria

All 290 canonical CDD AC and four NSBR mappings are linked to existing tests. Critical logic, race, security,
migration, OpenAPI, Prometheus, Compose, crash-after-send, pepper, capacity and PITR checks pass locally. Formal
batch approval still depends on the recorded fresh independent reviews.

本轮运行证据分别冻结在 [`capacity-report.md`](capacity-report.md)、
[`fault-drill-report.md`](fault-drill-report.md)、[`pitr-report.md`](pitr-report.md) 和
[`marker-scan-report.md`](marker-scan-report.md)；`acceptance-report.json` 只汇总结果，不替代这些原始参数
与失败记录。
