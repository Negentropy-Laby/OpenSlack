# Deadline Backlog Pressure Analysis (Advisory 2 closure, Architecture scope)

> **Stage**: Architecture
> **Status**: Architecture-scope analysis; closes Architecture-review advisory 2 at Architecture scope.
> **Implementation evidence**: none; this is a structural model + test design that Pre-Implementation later executes.
> **Date**: 2026-07-20
> **Authority class**: dated review-adjacent analysis under `design/cdd/reviews/`. It CHARACTERIZES an existing
> contract (Delivery CDD + B-01 + existing constants). It does NOT add a queue, ledger, retry table, state, module,
> ADR, AC, CTRL row, config key, or schema column. Strictly smaller footprint than
> `delivery-deadline-adjudication.md`, which AUTHORIZED a contract correction.

## Advisory and scope

Advisory 2 (verbatim, 退役原件 `docs/architecture/architecture-review-2026-07-20.md:51`；现存档于
`docs/architecture/architecture-review-archive.md`):

> "At Pre-Implementation, prove `DEADLINE_CLAIM_BUDGET` under backlog pressure as well as the single-row cutoff-epsilon case."

This document closes advisory 2 **at Architecture scope**: it produces the structural model and the AC-mapped test
design that Pre-Implementation later executes. It does NOT run the Architecture→Pre-Implementation gate; the review's
closing line stands: *"These advisories do not authorize this project to enter Pre-Implementation."*

**Non-goals (hard):** no code/migration/test/CI; no new ADR, mechanism, queue/ledger/retry-table/state/module; no
numeric SLA; no schedule-not-established item (multi-worker, sweeper cadence/leader-election, LISTEN/NOTIFY, priority
claim ordering) is built or assumed; no new CTRL row, AC, config key, or schema column.

## Inputs and constants (cited, not redefined)

From `design/cdd/delivery.md:181-189`:

- `MAX_AGE = 24h`, `MAX_ATTEMPTS = 25` (T0-fixed upper bounds)
- `HTTP_HARD_TIMEOUT = H = 10s` (1s..30s)
- `RESULT_COMMIT_MARGIN = M = 5s` (>0)
- `DEADLINE_CLAIM_BUDGET = B = 5s` (>0 and < H+M)
- `LEASE_TTL = 30s` (must cover preflight + HTTP + commit margin)

Derived:

- `cycle_deadline = delivery_cycle_started_at + MAX_AGE`
- `cycle_send_cutoff = cycle_deadline − H − M` ⇒ finalization-window width = H + M = 15s
- B = 5s < 15s

Operational substrate (cited):

- single-process MVP — one binary, one process (`docs/architecture/architecture.md:43-44`)
- claim uses `FOR UPDATE SKIP LOCKED` with eligible/cycle-age ordering (`architecture.md` ## Persistence and Transactions; `data-model.md:25-26`)
- day-1 metrics expose only depth, oldest pending age, dead count (CTRL-018; `reliability-observability.md`)

## Model variables (analytic — NOT config)

These are analytic quantities measured at the Pre-Implementation load test. They are NOT registered config and are NOT
pinned here (schedule not established; `notification-store.md:905,910-912`):

- `W` — in-process delivery-worker concurrency (Architecture-scope decision per `delivery.md:193`, not pinned here)
- `W_eff ≤ W` — effective concurrent claim capacity under SKIP LOCKED contention
- `t_c` — one claim transaction latency
- `t_d` — one die-write transition latency
- `t_final_a = t_c + t_d` — no-send path-a per-row finalization cost
- `t_sweep` — the worker's in-process run_once loop cadence (NOT an external scheduler — CTRL-024)
- `N_a` — no-send rows eligible at/after cutoff (path-a)
- `N_b` — rows with an HTTP attempt already in flight at cutoff (path-b)
- `H_max_residual ≤ H` — residual HTTP time of in-flight send rows at cutoff
- `N_a_max = floor((H + M − t_sweep) · W_eff / (t_c + t_d))` — structural capacity bound on path-a rows that can
  finalize within the window

## Two finalization paths under backlog (restated, unchanged)

Per `delivery.md:103-108` and the B-01 ruling (`delivery-deadline-adjudication.md:15-30`):

- **(a) no-send path-a** — an eligible row claimed at/after `cycle_send_cutoff` dies as a non-counting
  `policy_termination(deadline_exceeded)` (CTRL-007). Per-row finalization cost `t_final_a`, per-row budget B.
- **(b) send-then-actual-result-die path-b** — an attempt started BEFORE cutoff returns a retryable result at/after
  cutoff and dies in the SAME Store write as an actual-result `die(permanent_failure, deadline_exceeded)` (CTRL-006).
  It counts +1; its HTTP was bounded by H and started before cutoff.

## Single-row case (N=1) — SUBSUMED, not re-proven

The single-row cutoff-epsilon case is `test-strategy.md` scenario #6 and the Decisive B-01 Trace
(`requirements-traceability.md:41-53`; AC set `DL-02, DL-07, DL-08, AC-STATE-04a, AC-ATT-04` at line 43). For N=1:
`t_sweep + t_final_a ≤ B` for path-a; for path-b the HTTP is bounded by H and started before cutoff, and
`LEASE_TTL = 30s > H + M` keeps the lease valid across the result write, so `dead_at ≤ cycle_deadline`.

## N-row structural derivation (analytic core)

1. Finalization-window width = `cycle_deadline − cycle_send_cutoff` = H + M = 15s.
2. At the instant path-a rows become eligible AT `cycle_send_cutoff`, path-b rows are `state=in_flight` (claimed
   pre-cutoff, holding workers up to H). They are NOT in the eligible claim queue. They starve path-a via
   **worker-slot exhaustion**, not claim-queue age-ordering.
3. The `N_a` no-send path-a rows ARE at the head of the eligible claim queue (claim orders by oldest
   `delivery_cycle_started_at`) and drain FIFO once a worker frees.
4. Worst-case (last) path-a row dies at approximately `cycle_send_cutoff + t_sweep + N_a·(t_c+t_d)/W_eff`, adjusted
   downward by send-row worker-slot depletion over the `H_max_residual` prefix.
5. Per-row `DEADLINE_CLAIM_BUDGET` requires each row's claim-to-die latency, once claimed, to be ≤ B.

## `dead_at ≤ cycle_deadline` — PRECISE conditional invariant

The die **classification** (and the no-second-claim property) is backlog-independent and per-row atomic for BOTH
paths. But `dead_at ≤ cycle_deadline` (the `dead_at` mutable field + dead-list index per `data-model.md:21-22,28`;
value sourced from authoritative PostgreSQL transaction time, `data-model.md` (## Transaction Time and OCC)) holds **iff** all of:

- **C1 — throughput-capacity precondition (measured at Pre-Impl):** `N_a ≤ N_a_max`, adjusted downward by send-row
  depletion.
- **C2 — per-row finalization budget:** `t_sweep + t_final_a ≤ B` for path-a; AND for path-b the send-path HTTP is
  bounded by H with the result write completing by `cycle_deadline − M`.
- **C3 — sweep-cadence headroom:** `t_sweep + N_a·(t_c+t_d)/W_eff ≤ H+M`.
- **C4 — health precondition** (identical to `delivery.md:106` + B-01): Store and Delivery healthy, hard timeout +
  commit margin hold, SKIP LOCKED claim + valid lease available, `LEASE_TTL` covers the write, AND per-write commit
  latency stays within `RESULT_COMMIT_MARGIN` under N-row contention.

Under C1–C4 the B-01 single-row guarantee extends to every row of N. This **extends the evidence/analysis** of the
existing bound; it does NOT strengthen or weaken CTRL-008 (anchored to the `delivery.md:106` health precondition and
the `delivery.md:165-166` honest-failure path).

## Breakdown conditions B1–B5

`dead_at > cycle_deadline` CAN occur iff any of:

- **B1 — static volume:** `N_a > N_a_max` (the capacity ceiling is exceeded).
- **B2 — dynamic throughput collapse:** `t_c` inflates / `W_eff` drops under SKIP LOCKED contention, DB load, or
  connection-pool saturation (degrades the capacity C1 assumes).
- **B3 — worker-slot starvation:** in-flight path-b send rows (`state=in_flight`, holding workers up to H) delay the
  path-a tail. (B1 is the capacity ceiling; B2/B3 are the mechanisms that erode it.)
- **B4 — health loss** (Store/Delivery unavailable): explicitly OUTSIDE the guarantee — honest worker-health signal
  per `delivery.md:165-166`, truthful pending/in-flight retained, no fabricated achievement.
- **B5 — Store ready=true but commit-slow:** per-write commit latency inflated by N-row contention in the
  finalization window past `RESULT_COMMIT_MARGIN` — honest-failure activates (worker-health signal, no fabricated
  achievement, truthful late `dead_at` recorded).

## No-starvation necessary (not sufficient) conditions

To avoid a path-a tail delay it is NECESSARY that `W > N_b_inflight_at_cutoff`, or that path-a rows are older than
path-b rows so age-ordering drains cheap rows first. These are necessary, not sufficient for the bound — full drain
also requires C1. `W` is an Architecture-scope decision (`delivery.md:193` — "并发数和调度机制属于 Architecture") but
is NOT pinned in this slice (no numeric value before implementation; schedule not established). The model SURFACES the
headroom for Pre-Implementation to check.

## Day-1 leading indicators (CTRL-018 — no new metric)

The existing day-1 metric set is sufficient as leading/confirming/trailing indicators; no new gauge is proposed:

- `rc_wsman_oldest_pending_age_seconds` rising toward `MAX_AGE` — LEADING
- `rc_wsman_outbox_pending` rising — CONFIRMING
- `rc_wsman_dead_notifications > 0` for 5m (RO-07 fixed alert) — TRAILING

Operator interpretation: runbook Signals table (`runbook.md:5-13`); deeper procedure: Backlog Triage
(`runbook.md:17-24`).

## Evolution-trigger mapping

Per `architecture.md` (## Evolution Boundaries):

- finalization-window pile-up → add worker concurrency (raise W)
- high poll-idle / claim latency → LISTEN/NOTIFY wake (cut t_sweep)
- slow-vendor head-of-line blocking → vendor fairness

All metric-triggered, Calendar Due = N/A (`notification-store.md:910-912`). This analysis INFORMS those triggers but
does NOT build, assume, or schedule them. All mechanisms are in-process or PostgreSQL-native (CTRL-024-compliant).

## Test design for Pre-Implementation (AC-mapped)

- **Scenario family 1 — single-row cutoff-epsilon (SUBSUMED):** `test-strategy.md` scenario #6; traces
  `DL-02/DL-07/DL-08/AC-STATE-04a/AC-ATT-04` (Decisive B-01 Trace set, `requirements-traceability.md:43`). Not
  re-proven here.
- **Scenario family 2 — backlog Path B:** N rows, each attempt started pre-cutoff, each retryable at/after cutoff.
  Assert per-row actual-result die in its OWN write, +1, no second claim, `dead_at ≤ cycle_deadline` for ALL N under
  C1–C4. Assert over the SET (MAX oldest-age row), not the mean.
- **Scenario family 3 — backlog Path A:** N pending rows, tight cutoff window. Assert non-counting
  `policy_termination`, `dead_at ≤ cycle_deadline` for ALL N under C1–C4. MEASURE headroom distribution without an
  SLA (feeds the evolution trigger only).
- **Scenario family 4 — capacity-baseline extension:** drain rate, oldest-age vs `MAX_AGE` pressure, structural
  break-point N, honest-failure activation at the break-point. MEASUREMENT establishing an evolution trigger; NOT a
  retroactive SLA.
- **Fault-injection matrix:**
  - 5a — worker stall
  - 5b — slow vendor near H
  - 5c — Store degraded, ready=false
  - 5d — clock-skew guard (`dead_at` from Store authoritative transaction time, `data-model.md` (## Transaction Time and OCC))
  - 5e — Store ready=true but commit latency inflated by N-row contention exceeding M

Classification: **fault_injection** (already in `DELIVERY.planned_test_types`) for the structural pass/fail assertions
+ capacity-baseline MEASUREMENTS recorded in the project-wide Capacity Baseline section of `test-strategy.md`.
`capacity_baseline` is NOT added to the DELIVERY family (verified `tr-registry.yaml:399` DELIVERY has only
`[contract, logic, integration, concurrency, fault_injection, security_negative]`; `capacity_baseline` appears only on
VR-QUERY at line 216). Adding `capacity_baseline` to DELIVERY is a possible Pre-Implementation SHA-pinned edit, flagged
NOT done here.

## Invariants preserved

- **CTRL-006** (retryable actual result at/after cutoff dies in the current Store write and counts once): PRESERVED —
  the die classification is backlog-independent and per-row atomic; the model adds no second claim, no second write,
  no attempt-count drift. (Corrected: `dead_at ≤ cycle_deadline` is conditional on per-write commit latency per C4,
  not unconditional.)
- **CTRL-007** (no-send deadline termination is non-counting policy history): PRESERVED and load-bearing under
  backlog — overloaded rows that miss their claim budget still die via this exact non-counting path when eventually
  claimed.
- **CTRL-008** (attempts stop at 25 or one cycle reaches 24h): PRESERVED — NOT strengthened. The analysis extends the
  EVIDENCE of the existing single-row `dead_at ≤ cycle_deadline` bound to every row of N under C1–C4, without changing
  the invariant. `MAX_AGE=24h` and `MAX_ATTEMPTS=25` unchanged; under all load the cycle still ends in `dead`.
- **CTRL-018** (metrics expose only depth/oldest-age/dead count): PRESERVED — the model introduces NO new gauge;
  analytic parameters are Pre-Implementation benchmark observations, not day-1 Prometheus metrics.
- **CTRL-024** (no Kafka/Redis/independent DLQ/scheduler/service mesh): PRESERVED — the model uses ONLY the existing
  in-process run_once loop + SKIP LOCKED claim + lease/OCC. `t_sweep` is the worker's own polling cadence
  (in-process), NOT an external scheduler.
- **B-01 ruling** (no second claim, no queue/ledger/retry-table/new state/new module): PRESERVED.
- **no-SLA-before-implementation** (`test-strategy.md:51`; `tech_context.md:33,35`): PRESERVED — every statement is a
  STRUCTURAL headroom inequality; NO numeric latency/throughput target invented. `dead_at ≤ cycle_deadline` is an
  existing structural bound, not a newly invented SLA.
- **Authority Rule** (`entities.yaml:9`): PRESERVED — no new identifier introduced; no authority reassignment.
- **`LEASE_TTL=30s`** (`delivery.md:189`): PRESERVED and relied upon as part of C4.
- **Transaction Time/OCC** (`data-model.md` (## Transaction Time and OCC)): PRESERVED — `dead_at` sourced from PostgreSQL transaction time;
  clock-skew fault case (5d) asserts a worker local clock cannot fabricate early/late `dead_at`.

## What this slice PROVES vs LEAVES

**PROVES at design level:** the structural conditions C1–C4 under which the B-01 single-row guarantee extends to every
row of an N-row simultaneous-finalization backlog; the breakdown surface B1–B5; that closing advisory 2 requires NO
new mechanism/state/module/queue/ledger/CTRL row/AC/config key/schema column; the explicit connection between
Capacity-Baseline drain-rate/oldest-age measurements and deadline convergence (which `test-strategy.md` currently
omits).

**LEAVES to Pre-Implementation:** numeric measurement (`W, t_c, t_d, t_sweep, W_eff`), the empirical `N_a_max`, the
decision of whether day-1 W suffices or an Evolution Boundaries trigger fires, and the actual fault-injection/
capacity execution.

## Dependencies and traceability

Cites: ADR-0001 (SKIP LOCKED claim + lease + OCC atomicity), the B-01 ruling (`delivery-deadline-adjudication.md`),
the Decisive B-01 Trace (`requirements-traceability.md:41-53`), Delivery CDD (`DL-02/DL-07/DL-08`), Notification Store
CDD (`AC-STATE-04a, AC-ATT-04`), CTRL-006/007/008/018/024, `test-strategy.md` scenarios #5/#6 + Capacity Baseline,
`architecture.md` (Deployment View 43-44; ## Persistence and Transactions; ## Evolution Boundaries), `data-model.md`
(Notification Store fields/indexes 21-22,28; ## Transaction Time and OCC),
`delivery.md:103-108,165-166,181-189,193`, `reliability-observability.md`, `runbook.md:5-13,17-24`. Adds NO new AC ⇒
Change Rule satisfied vacuously ⇒ NO `tr-registry.yaml` change.
