// Package delivery implements the Delivery module: SSRF-safe outbound HTTP,
// request construction, attempt classification, and the worker pool that drives
// the Notification Store outbox.
//
// B4 scope: delivery worker, safe transport, request builder, classifier, and
// backoff composition. It does not own any table/queue/DLQ; pending/dead rows
// in Notification Store are the outbox and DLQ per ADR-0001.
package delivery

import (
	"fmt"
	"time"
)

const (
	// T0 convergence invariants.
	DefaultMaxAttempts = 25
	DefaultMaxAge      = 24 * time.Hour

	// Retry/backoff defaults.
	DefaultRetryBaseDelay  = 1 * time.Second
	DefaultRetryDelayCap   = 1 * time.Hour
	DefaultRetryAfterCap   = 1 * time.Hour
	DefaultHTTPHardTimeout = 10 * time.Second

	// Lease/commit budget defaults.
	DefaultResultCommitMargin  = 5 * time.Second
	DefaultDeadlineClaimBudget = 5 * time.Second
	DefaultLeaseTTL            = 30 * time.Second
)

// Config holds the delivery module's runtime configuration. All fields are
// required and validated at worker construction time so misconfiguration fails
// closed.
type Config struct {
	MaxAttempts           int
	MaxAge                time.Duration
	RetryBaseDelay        time.Duration
	RetryDelayCap         time.Duration
	RetryAfterCap         time.Duration
	HTTPHardTimeout       time.Duration
	ResultCommitMargin    time.Duration
	DeadlineClaimBudget   time.Duration
	LeaseTTL              time.Duration
	DefaultAllowedPorts   map[int]struct{}
	DefaultForbiddenCIDRs []string
}

// DefaultConfig returns the delivery module defaults. It is safe to mutate the
// returned value before validating.
func DefaultConfig() Config {
	return Config{
		MaxAttempts:         DefaultMaxAttempts,
		MaxAge:              DefaultMaxAge,
		RetryBaseDelay:      DefaultRetryBaseDelay,
		RetryDelayCap:       DefaultRetryDelayCap,
		RetryAfterCap:       DefaultRetryAfterCap,
		HTTPHardTimeout:     DefaultHTTPHardTimeout,
		ResultCommitMargin:  DefaultResultCommitMargin,
		DeadlineClaimBudget: DefaultDeadlineClaimBudget,
		LeaseTTL:            DefaultLeaseTTL,
		DefaultAllowedPorts: map[int]struct{}{443: {}},
		DefaultForbiddenCIDRs: []string{
			"0.0.0.0/8",
			"127.0.0.0/8",
			"10.0.0.0/8",
			"100.64.0.0/10",
			"172.16.0.0/12",
			"192.168.0.0/16",
			"169.254.0.0/16",
			"192.0.0.0/24",
			"192.0.2.0/24",
			"198.18.0.0/15",
			"198.51.100.0/24",
			"203.0.113.0/24",
			"224.0.0.0/4",
			"240.0.0.0/4",
			"fc00::/7",
			"fe80::/10",
			"2001:db8::/32",
			"::1/128",
		},
	}
}

// Validate checks that the configuration satisfies the design invariants. It
// returns a non-nil error for any violation so the composition root can fail
// closed at startup.
func (c Config) Validate() error {
	if c.MaxAttempts < 1 {
		return fmt.Errorf("delivery config: MaxAttempts must be >= 1")
	}
	if c.MaxAge < 1*time.Hour {
		return fmt.Errorf("delivery config: MaxAge must be at least 1h")
	}
	if c.RetryBaseDelay <= 0 {
		return fmt.Errorf("delivery config: RetryBaseDelay must be positive")
	}
	if c.RetryDelayCap < c.RetryBaseDelay {
		return fmt.Errorf("delivery config: RetryDelayCap must be >= RetryBaseDelay")
	}
	if c.RetryDelayCap >= c.MaxAge {
		return fmt.Errorf("delivery config: RetryDelayCap must be < MaxAge")
	}
	if c.RetryAfterCap <= 0 || c.RetryAfterCap > c.MaxAge {
		return fmt.Errorf("delivery config: RetryAfterCap must be in (0, MaxAge]")
	}
	if c.HTTPHardTimeout < 1*time.Second || c.HTTPHardTimeout > 30*time.Second {
		return fmt.Errorf("delivery config: HTTPHardTimeout must be in [1s, 30s]")
	}
	if c.ResultCommitMargin <= 0 {
		return fmt.Errorf("delivery config: ResultCommitMargin must be positive")
	}
	if c.DeadlineClaimBudget <= 0 {
		return fmt.Errorf("delivery config: DeadlineClaimBudget must be positive")
	}
	if c.DeadlineClaimBudget >= c.HTTPHardTimeout+c.ResultCommitMargin {
		return fmt.Errorf("delivery config: DeadlineClaimBudget must be < HTTPHardTimeout+ResultCommitMargin")
	}
	if c.LeaseTTL <= 0 {
		return fmt.Errorf("delivery config: LeaseTTL must be positive")
	}
	if c.LeaseTTL < c.HTTPHardTimeout+c.ResultCommitMargin+c.DeadlineClaimBudget {
		return fmt.Errorf("delivery config: LeaseTTL must cover preflight+HTTP+commit margin")
	}
	if len(c.DefaultAllowedPorts) == 0 {
		return fmt.Errorf("delivery config: DefaultAllowedPorts must not be empty")
	}
	for p := range c.DefaultAllowedPorts {
		if p < 1 || p > 65535 {
			return fmt.Errorf("delivery config: DefaultAllowedPorts contains invalid port %d", p)
		}
	}
	return nil
}
