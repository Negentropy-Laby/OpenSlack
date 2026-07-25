# Delivery B-01 — Owner Adjudication

> **Date**: 2026-07-20
> **Scope**: the single 24-hour finalization blocker recorded by Cross-CDD Review Run 02
> **Authority**: project owner approval of the implementation-before-code documentation plan
> **Decision**: accepted; authorize one narrow Store/Delivery contract correction and fresh reviews

## Counterexample

An HTTP attempt may start immediately before `cycle_send_cutoff`, consume the full
`HTTP_HARD_TIMEOUT`, and finish close to `cycle_deadline`. If that result is first committed as
`retry`, a second claim is required to write `deadline_exceeded`; that extra claim can put
`dead_at` after the 24-hour bound even when Store and Delivery are otherwise healthy.

## Ruling

The attempt result itself closes the cycle when it finishes at or after `cycle_send_cutoff`:

1. A retryable HTTP or transport result that finishes before `cycle_send_cutoff` remains `retry`;
   its `next_attempt_at` is clamped to the cutoff.
2. A retryable HTTP or transport result that finishes at or after `cycle_send_cutoff` is submitted
   in the same Store write as actual-result
   `die(outcome_class=permanent_failure, reason=deadline_exceeded)`.
3. The actual result keeps its `http_status` or stable `error_code`, increments `attempt_count`,
   forbids `next_attempt_at`, and atomically writes attempt history plus `dead_at`.
4. A deadline detected before any outbound attempt remains
   `die(policy_termination, deadline_exceeded)` and does not increment `attempt_count`.

This preserves at-least-once accounting, avoids a second claim, and does not add a queue, deadline
ledger, retry table, new state, or new module ownership.

## Authorized Change Surface

- `design/cdd/delivery.md`: result classification, cutoff behavior, edge cases, and existing AC.
- `design/cdd/notification-store.md`: the existing actual-result `die` union and matching AC.
- The two corresponding review logs and status mirrors after review.

T0's 24-hour promise, `MAX_AGE`, module graph, retry count, replay behavior, and all unrelated
Store/Delivery contracts remain unchanged.
