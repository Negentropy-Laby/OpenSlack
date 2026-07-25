package delivery

import (
	"testing"
	"time"
)

// detRNG is a deterministic, advancing RNG for tests. Int63n(n) returns a
// reproducible residue sequence so test runs are stable.
type detRNG struct{ seed int64 }

func (d *detRNG) Int63n(n int64) int64 {
	if n <= 0 {
		return 0
	}
	v := d.seed % n
	d.seed++
	return v
}

// TestExponentialBound verifies the closed-form bound min(cap, base*2^attempt)
// with exact values and cap/overflow saturation. Constants follow the pinned
// delivery config (design/registry/entities.yaml): RETRY_BASE_DELAY=1s,
// RETRY_DELAY_CAP=1h.
func TestExponentialBound(t *testing.T) {
	const base = 1 * time.Second
	const capD = 1 * time.Hour
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{0, 1 * time.Second},
		{1, 2 * time.Second},
		{2, 4 * time.Second},
		{3, 8 * time.Second},
		{10, 1024 * time.Second},
		{11, 2048 * time.Second}, // base*2048 = 2048s ~= 34.1min < 1h
		{12, 1 * time.Hour},      // base*4096 = 4096s ~= 68.3min > 1h -> cap
		{13, 1 * time.Hour},      // capped
		{50, 1 * time.Hour},      // would overflow -> cap
	}
	for _, c := range cases {
		got := exponentialBound(base, c.attempt, capD)
		if got != c.want {
			t.Errorf("exponentialBound(attempt=%d) = %s, want %s", c.attempt, got, c.want)
		}
	}
}

// TestExponentialBound_NegativeAttemptClampsToZero confirms attemptCount < 0 is
// treated as 0 (defensive - the caller should never pass negative).
func TestExponentialBound_NegativeAttemptClampsToZero(t *testing.T) {
	got := exponentialBound(1*time.Second, -5, 1*time.Hour)
	if want := 1 * time.Second; got != want {
		t.Errorf("exponentialBound(attempt=-5) = %s, want %s", got, want)
	}
}

// TestFullJitter_WithinRange drives many samples and asserts each lies in
// [0, bound) - the uniform(0, bound) invariant from delivery.md.
func TestFullJitter_WithinRange(t *testing.T) {
	const base = 1 * time.Second
	const capD = 1 * time.Hour
	bound := exponentialBound(base, 3, capD) // 8s
	rng := &detRNG{seed: 7}
	for i := 0; i < 5000; i++ {
		got := FullJitter(rng, 3, base, capD)
		if got < 0 || got >= bound {
			t.Fatalf("FullJitter sample %d = %s; want in [0, %s)", i, got, bound)
		}
	}
}

// TestFullJitter_ExactValueLocksBound verifies the bound passed to Int63n is
// exactly exponentialBound(...): for a deterministic seed x, FullJitter must
// return x mod bound. A wrong bound argument (off-by-one) would change the
// residue and fail this assertion. This locks what the range test above only
// samples.
func TestFullJitter_ExactValueLocksBound(t *testing.T) {
	const base = 1 * time.Second
	const capD = 1 * time.Hour
	bound := exponentialBound(base, 3, capD) // 8s
	cases := []int64{
		0,
		1,
		int64(bound) - 1,   // just below bound -> residue bound-1
		int64(bound),       // exactly bound -> wraps to 0
		int64(bound) + 1,   // wraps to 1
		2*int64(bound) + 3, // wraps to 3
		7_777_777_777,      // large value below bound -> itself
	}
	for _, x := range cases {
		rng := &detRNG{seed: x}
		got := FullJitter(rng, 3, base, capD)
		want := time.Duration(x % int64(bound))
		if got != want {
			t.Errorf("FullJitter(seed=%d) = %s, want %s (= %d mod %d)", x, got, want, x, bound)
		}
	}
}

// TestFullJitter_ZeroBoundReturnsZero covers the degenerate base=0 case.
func TestFullJitter_ZeroBoundReturnsZero(t *testing.T) {
	rng := &detRNG{}
	for i := 0; i < 100; i++ {
		if got := FullJitter(rng, 5, 0, 1*time.Hour); got != 0 {
			t.Fatalf("FullJitter with base=0 = %s, want 0", got)
		}
	}
}

// TestFullJitter_NilRNGPanics asserts a wiring bug surfaces loudly.
func TestFullJitter_NilRNGPanics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("FullJitter with nil RNG did not panic")
		}
	}()
	FullJitter(nil, 1, 1*time.Second, 1*time.Hour)
}

func TestNextAttemptTimeComposesRetryAfterCapJitterAndCutoff(t *testing.T) {
	now := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	const base = 10 * time.Second
	const delayCap = time.Hour
	const retryAfterCap = time.Hour

	twoHours := 2 * time.Hour
	if got := NextAttemptTime(now, now.Add(2*time.Hour), 0, &twoHours, base, delayCap, retryAfterCap, &detRNG{seed: int64(3 * time.Second)}); got == nil || !got.Equal(now.Add(time.Hour)) {
		t.Fatalf("Retry-After cap: got=%v want=%v", got, now.Add(time.Hour))
	}
	twoSeconds := 2 * time.Second
	if got := NextAttemptTime(now, now.Add(2*time.Hour), 0, &twoSeconds, base, delayCap, retryAfterCap, &detRNG{seed: int64(3 * time.Second)}); got == nil || !got.Equal(now.Add(3*time.Second)) {
		t.Fatalf("max(jitter, hint): got=%v want=%v", got, now.Add(3*time.Second))
	}
	if got := NextAttemptTime(now, now.Add(30*time.Minute), 0, &twoHours, base, delayCap, retryAfterCap, &detRNG{seed: int64(3 * time.Second)}); got == nil || !got.Equal(now.Add(30*time.Minute)) {
		t.Fatalf("cutoff clamp: got=%v want=%v", got, now.Add(30*time.Minute))
	}
	if got := NextAttemptTime(now, now.Add(2*time.Hour), 0, nil, base, delayCap, retryAfterCap, &detRNG{seed: int64(3 * time.Second)}); got == nil || !got.Equal(now.Add(3*time.Second)) {
		t.Fatalf("invalid/missing hint jitter fallback: got=%v want=%v", got, now.Add(3*time.Second))
	}
	if got := NextAttemptTime(now, now, 0, &twoHours, base, delayCap, retryAfterCap, &detRNG{seed: int64(3 * time.Second)}); got != nil {
		t.Fatalf("at cutoff got=%v want=nil", got)
	}
}
