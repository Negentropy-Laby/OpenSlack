// Package delivery contains the delivery module's leaf utilities.
//
// This file began as the stdlib-only leaf of the Pre-Implementation Test
// Framework Baseline and remains independently testable without external I/O.
package delivery

import "time"

// RNG is the minimal random source that FullJitter depends on. Production wires
// a crypto/rand-derived source; tests wire a deterministic source.
type RNG interface {
	Int63n(n int64) int64
}

// FullJitter samples the full-jitter backoff delay per design/cdd/delivery.md
// (section "Retry-After and full-jitter", lines 90-101):
//
//	jitter = uniform(0, min(RETRY_DELAY_CAP, RETRY_BASE_DELAY * 2^attempt_count))
//
// It is pure given an injected RNG: no I/O, no clock, no side effects. The
// caller composes the result with Retry-After and the cycle_send_cutoff clamp
// (a future, time-dependent helper); this leaf deliberately stays pure so it can
// be unit-tested deterministically.
//
// attemptCount is the number of prior attempts (0 for the first retry). A nil
// RNG panics - silence would hide a wiring bug in a security-relevant path.
func FullJitter(r RNG, attemptCount int, baseDelay, capDelay time.Duration) time.Duration {
	if r == nil {
		panic("delivery: FullJitter requires a non-nil RNG")
	}
	if baseDelay < 0 {
		baseDelay = 0
	}
	if capDelay < 0 {
		capDelay = 0
	}
	bound := exponentialBound(baseDelay, attemptCount, capDelay)
	if bound <= 0 {
		return 0
	}
	// uniform(0, bound): Int63n(bound) is in [0, bound).
	return time.Duration(r.Int63n(int64(bound)))
}

// exponentialBound returns min(capDelay, baseDelay * 2^attemptCount) with
// overflow saturation: once baseDelay<<attemptCount would overflow int64 (or
// exceeds the cap), the cap is returned. attemptCount < 0 is treated as 0.
func exponentialBound(base time.Duration, attemptCount int, cap time.Duration) time.Duration {
	if attemptCount < 0 {
		attemptCount = 0
	}
	if attemptCount > 62 {
		return cap
	}
	shifted := int64(base) << uint(attemptCount)
	// Detect overflow of the shift (skipped for attemptCount == 0); saturate to cap.
	if attemptCount != 0 && shifted>>uint(attemptCount) != int64(base) {
		return cap
	}
	bound := time.Duration(shifted)
	if bound > cap {
		return cap
	}
	return bound
}

// NextAttemptTime computes the clamped next-attempt timestamp.
// Returns nil if the result should be an actual-result die at cutoff.
//
// The algorithm is:
//  1. jitter = FullJitter(rng, attemptCount, baseDelay, delayCap)
//  2. if retryAfter is valid: effective = min(max(0, retryAfterAt - now), retryAfterCap); candidate = max(jitter, effective)
//  3. else: candidate = jitter
//  4. if now < cycleSendCutoff: next = min(cycleSendCutoff, now + candidate); return &next
//  5. else return nil (B-01 atomic die at deadline_exceeded)
func NextAttemptTime(
	now, cycleSendCutoff time.Time,
	attemptCount int,
	retryAfter *time.Duration,
	baseDelay, delayCap, retryAfterCap time.Duration,
	rng RNG,
) *time.Time {
	if rng == nil {
		panic("delivery: NextAttemptTime requires a non-nil RNG")
	}
	jitter := FullJitter(rng, attemptCount, baseDelay, delayCap)
	candidate := jitter
	if retryAfter != nil {
		effective := *retryAfter
		if effective > retryAfterCap {
			effective = retryAfterCap
		}
		if effective < 0 {
			effective = 0
		}
		if effective > candidate {
			candidate = effective
		}
	}
	if now.Before(cycleSendCutoff) {
		next := now.Add(candidate)
		if next.After(cycleSendCutoff) {
			next = cycleSendCutoff
		}
		return &next
	}
	return nil
}
