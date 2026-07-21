// Package delivery contains the delivery module's leaf utilities.
//
// This file is the first real production leaf of the Pre-Implementation Test
// Framework Baseline. It is stdlib-only (no external require) so the baseline
// unit test compiles against the minimal go.mod. It is AUTHORED-BUT-NOT-COMPILED
// in the current (Go-less) shell; compilation is verified in CI.
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
