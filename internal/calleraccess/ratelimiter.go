// Package calleraccess implements per-principal in-memory token bucket rate limiting.
// It is not a cross-replica guarantee; that is acceptable for the single-process MVP.
package calleraccess

import (
	"sync"
	"time"
)

// RateLimiter is a per-principal in-memory token bucket.
type RateLimiter struct {
	callerRate       float64
	operatorReadRate float64
	operatorMutRate  float64
	mu               sync.Mutex
	buckets          map[string]*bucket
}

type bucket struct {
	tokens   float64
	lastSeen time.Time
}

// NewRateLimiter builds a rate limiter with the given per-minute rates.
func NewRateLimiter(callerRate, operatorReadRate, operatorMutRate int) *RateLimiter {
	return &RateLimiter{
		callerRate:       float64(callerRate) / 60.0,
		operatorReadRate: float64(operatorReadRate) / 60.0,
		operatorMutRate:  float64(operatorMutRate) / 60.0,
		buckets:          make(map[string]*bucket),
	}
}

// Allow consumes one token from the bucket for (principalID, opClass). It returns
// true if allowed and the retry-after duration if rejected (bounded by the configured max).
func (rl *RateLimiter) Allow(principalID, opClass string) (bool, time.Duration) {
	if rl == nil {
		return true, 0
	}
	rate := rl.rateFor(opClass)
	key := principalID + "::" + opClass

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[key]
	now := time.Now()
	if !ok {
		b = &bucket{tokens: 1.0}
		rl.buckets[key] = b
	}
	elapsed := now.Sub(b.lastSeen).Seconds()
	b.tokens = min(1.0, b.tokens+elapsed*rate)
	b.lastSeen = now

	if b.tokens < 1.0 {
		retryAfter := time.Duration((1.0 - b.tokens) / rate * float64(time.Second))
		if retryAfter < time.Second {
			retryAfter = time.Second
		}
		if retryAfter > DefaultRateLimitRetryAfterMax {
			retryAfter = DefaultRateLimitRetryAfterMax
		}
		return false, retryAfter
	}
	b.tokens -= 1.0
	return true, 0
}

func (rl *RateLimiter) rateFor(opClass string) float64 {
	switch opClass {
	case "caller":
		return rl.callerRate
	case "operator_read":
		return rl.operatorReadRate
	case "operator_mutation":
		return rl.operatorMutRate
	default:
		return rl.callerRate
	}
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
