package delivery

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"sync"
	"testing"
	"time"

	"rc_wsman/internal/notificationstore"
	"rc_wsman/internal/vendorregistry"
)

type runnerStore struct {
	mu            sync.Mutex
	claim         notificationstore.LeaseClaim
	claimed       bool
	transition    notificationstore.TransitionRequest
	transitionErr error
}

func (s *runnerStore) Intake(context.Context, notificationstore.ValidatedIntake) (notificationstore.IntakeResult, error) {
	return notificationstore.IntakeResult{}, nil
}
func (s *runnerStore) ClaimNext(context.Context, notificationstore.ActorContext, *notificationstore.ClaimFilter, time.Duration) (notificationstore.LeaseClaim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimed {
		return notificationstore.LeaseClaim{}, notificationstore.ErrNoEligibleNotification
	}
	s.claimed = true
	return s.claim, nil
}
func (s *runnerStore) Transition(_ context.Context, _ notificationstore.ActorContext, req notificationstore.TransitionRequest) (notificationstore.TransitionResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.transition = req
	if s.transitionErr != nil {
		return notificationstore.TransitionResult{}, s.transitionErr
	}
	return notificationstore.TransitionResult{}, nil
}
func (*runnerStore) RecoverExpiredLeases(context.Context, notificationstore.ActorContext, int) ([]notificationstore.RecoveredLease, error) {
	return nil, nil
}
func (*runnerStore) Get(context.Context, notificationstore.ActorContext, notificationstore.NotificationID) (notificationstore.Notification, error) {
	return notificationstore.Notification{}, nil
}
func (*runnerStore) QueryOutbox(context.Context, notificationstore.ActorContext, []string) (notificationstore.OutboxProjection, error) {
	return notificationstore.OutboxProjection{}, nil
}
func (*runnerStore) ListDead(context.Context, notificationstore.ActorContext, []string, int, string) (notificationstore.DeadPage, error) {
	return notificationstore.DeadPage{}, nil
}
func (*runnerStore) ListAttemptHistory(context.Context, notificationstore.ActorContext, notificationstore.NotificationID, int, string) (notificationstore.AttemptPage, error) {
	return notificationstore.AttemptPage{}, nil
}

type snapshotReader struct {
	snapshot any
	err      error
}

func (s snapshotReader) Snapshot(context.Context, vendorregistry.ActorContext, string, *int64) (any, error) {
	return s.snapshot, s.err
}

type fixedCredentialResolver struct{ err error }

func (r fixedCredentialResolver) Resolve(context.Context, vendorregistry.CredentialRef) (Credential, error) {
	if r.err != nil {
		return Credential{}, r.err
	}
	return Credential{BearerToken: "secret"}, nil
}

type sequenceResolver struct {
	mu      sync.Mutex
	answers [][]netip.Addr
	errors  []error
	calls   int
	after   func(int)
}

func (r *sequenceResolver) ResolveAll(context.Context, string) ([]netip.Addr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	i := r.calls
	if i < len(r.errors) && r.errors[i] != nil {
		r.calls++
		return nil, r.errors[i]
	}
	if i >= len(r.answers) {
		i = len(r.answers) - 1
	}
	r.calls++
	if r.after != nil {
		r.after(r.calls)
	}
	return append([]netip.Addr(nil), r.answers[i]...), nil
}

type mutableClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *mutableClock) Now() time.Time  { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *mutableClock) Set(v time.Time) { c.mu.Lock(); c.now = v; c.mu.Unlock() }

type fixedRNG struct{}

func (fixedRNG) Int63n(int64) int64 { return 0 }

type fakeHTTPTransport struct {
	calls  int
	status int
	err    error
	after  func()
	header http.Header
}

func (t *fakeHTTPTransport) Do(context.Context, *http.Request, netip.Addr, time.Duration) (*http.Response, error) {
	t.calls++
	if t.after != nil {
		t.after()
	}
	if t.err != nil {
		return nil, t.err
	}
	header := t.header
	if header == nil {
		header = make(http.Header)
	}
	return &http.Response{StatusCode: t.status, Header: header, Body: io.NopCloser(&emptyReader{})}, nil
}

type emptyReader struct{}

func (*emptyReader) Read([]byte) (int, error) { return 0, io.EOF }

func runnerActor() notificationstore.ActorContext {
	return notificationstore.ActorContext{Kind: notificationstore.ActorWorker, ActorID: "worker-1", VendorScope: []string{"vendor-a"}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityClaimDelivery, notificationstore.CapabilityRecordDeliveryResult}}
}

func validSnapshot() vendorregistry.DeliveryConfigSnapshot {
	return vendorregistry.DeliveryConfigSnapshot{
		VendorID: "vendor-a", ConfigVersion: 1, CanonicalURL: "https://vendor.example/hook", Method: "POST", Hostname: "vendor.example", Port: 443,
		TransportKind:              "https_public",
		OutboundIdempotencyMapping: vendorregistry.OutboundIdempotencyMapping{Mode: "none"}, EndpointPolicy: vendorregistry.EndpointPolicy{MaxRequestBodyBytes: 4096},
		AuthStrategy: "bearer", CredentialRef: vendorregistry.CredentialRef{Scheme: "env", OpaqueHandle: "TOKEN"},
	}
}

func newRunnerFixture(t *testing.T, now time.Time, dns *sequenceResolver, transport HTTPTransport) (*Runner, *runnerStore, *mutableClock, time.Time) {
	t.Helper()
	cfg := DefaultConfig()
	cycleStart := now.Add(-cfg.MaxAge).Add(cfg.HTTPHardTimeout).Add(cfg.ResultCommitMargin).Add(time.Second)
	cutoff := cycleStart.Add(cfg.MaxAge).Add(-cfg.HTTPHardTimeout).Add(-cfg.ResultCommitMargin)
	clock := &mutableClock{now: now}
	store := &runnerStore{claim: notificationstore.LeaseClaim{NotificationID: "n-1", LeaseID: "l-1", LeaseExpiresAt: cutoff.Add(time.Minute), Version: 2, Payload: []byte(`{"x":1}`), VendorID: "vendor-a", DeliveryCycleStartedAt: cycleStart, CreatedAt: cycleStart}}
	policy, err := NewAddressPolicy(cfg.DefaultAllowedPorts, cfg.DefaultForbiddenCIDRs)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(cfg, store, snapshotReader{snapshot: validSnapshot()}, fixedCredentialResolver{}, dns, transport, policy, clock, fixedRNG{})
	if err != nil {
		t.Fatal(err)
	}
	return runner, store, clock, cutoff
}

func TestRunnerB01ActualHTTPResultDiesAtomically(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}, {netip.MustParseAddr("8.8.8.8")}}}
	transport := &fakeHTTPTransport{status: 503}
	runner, store, clock, cutoff := newRunnerFixture(t, start, dns, transport)
	transport.after = func() { clock.Set(cutoff) }
	claimed, err := runner.RunOnce(context.Background(), runnerActor())
	if err != nil || !claimed {
		t.Fatalf("run: claimed=%v err=%v", claimed, err)
	}
	req := store.transition
	if req.RequestedTransition != notificationstore.TransitionDie || req.NextAttemptAt != nil || req.DeliveryResult == nil {
		t.Fatalf("transition: %+v", req)
	}
	if req.DeliveryResult.ResultKind != notificationstore.ResultKindHTTPResponse || req.DeliveryResult.HTTPStatus != 503 || req.DeliveryResult.OutcomeClass != notificationstore.OutcomeClassPermanentFailure || req.DeliveryResult.Reason != notificationstore.ReasonDeadlineExceeded {
		t.Fatalf("B-01 result: %+v", req.DeliveryResult)
	}
}

func TestRunnerRetryable503HonorsRetryAfterAndCutoff(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}, {netip.MustParseAddr("8.8.8.8")}}}
	transport := &fakeHTTPTransport{status: http.StatusServiceUnavailable, header: http.Header{"Retry-After": []string{"7200"}}}
	runner, store, _, cutoff := newRunnerFixture(t, start, dns, transport)
	claimed, err := runner.RunOnce(context.Background(), runnerActor())
	if err != nil || !claimed {
		t.Fatalf("run: claimed=%v err=%v", claimed, err)
	}
	req := store.transition
	if req.RequestedTransition != notificationstore.TransitionRetry || req.NextAttemptAt == nil || !req.NextAttemptAt.Equal(cutoff) {
		t.Fatalf("503 Retry-After scheduling: transition=%+v cutoff=%v", req, cutoff)
	}
	if req.DeliveryResult == nil || req.DeliveryResult.HTTPStatus != http.StatusServiceUnavailable || req.DeliveryResult.OutcomeClass != notificationstore.OutcomeClassRetryableFailure {
		t.Fatalf("503 result=%+v", req.DeliveryResult)
	}
}

func TestRunnerOverflowRetryAfterFallsBackToJitter(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}, {netip.MustParseAddr("8.8.8.8")}}}
	transport := &fakeHTTPTransport{status: http.StatusServiceUnavailable, header: http.Header{"Retry-After": []string{"18446744074"}}}
	runner, store, _, _ := newRunnerFixture(t, start, dns, transport)
	claimed, err := runner.RunOnce(context.Background(), runnerActor())
	if err != nil || !claimed {
		t.Fatalf("run: claimed=%v err=%v", claimed, err)
	}
	req := store.transition
	if req.RequestedTransition != notificationstore.TransitionRetry || req.NextAttemptAt == nil || !req.NextAttemptAt.Equal(start) {
		t.Fatalf("overflow Retry-After did not fall back to fixed zero jitter: %+v", req)
	}
}

func TestRunnerDNSRebindingFailsBeforeSend(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}, {netip.MustParseAddr("1.1.1.1")}}}
	transport := &fakeHTTPTransport{status: 200}
	runner, store, _, _ := newRunnerFixture(t, start, dns, transport)
	if _, err := runner.RunOnce(context.Background(), runnerActor()); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 0 {
		t.Fatal("request sent after DNS drift")
	}
	if store.transition.DeliveryResult == nil || store.transition.DeliveryResult.ResultKind != notificationstore.ResultKindPolicyTermination || store.transition.DeliveryResult.Reason != notificationstore.ReasonDestinationRejected {
		t.Fatalf("transition: %+v", store.transition)
	}
}

func TestRunnerSecondDNSCannotCrossCutoffAndSend(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}, {netip.MustParseAddr("8.8.8.8")}}}
	transport := &fakeHTTPTransport{status: 200}
	runner, store, clock, cutoff := newRunnerFixture(t, start, dns, transport)
	dns.after = func(call int) {
		if call == 2 {
			clock.Set(cutoff)
		}
	}
	if _, err := runner.RunOnce(context.Background(), runnerActor()); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 0 {
		t.Fatal("request sent after second DNS consumed cutoff budget")
	}
	if result := store.transition.DeliveryResult; result == nil || result.ResultKind != notificationstore.ResultKindPolicyTermination || result.Reason != notificationstore.ReasonDeadlineExceeded {
		t.Fatalf("transition=%+v", store.transition)
	}
}

func TestRunnerSecondDNSCannotCrossLeaseCommitBudgetAndSend(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}, {netip.MustParseAddr("8.8.8.8")}}}
	transport := &fakeHTTPTransport{status: 200}
	runner, store, clock, cycleCutoff := newRunnerFixture(t, start, dns, transport)
	preflightCutoff := start.Add(500 * time.Millisecond)
	store.claim.LeaseExpiresAt = preflightCutoff.Add(runner.cfg.HTTPHardTimeout).Add(runner.cfg.ResultCommitMargin)
	dns.after = func(call int) {
		if call == 2 {
			clock.Set(preflightCutoff)
		}
	}
	if !preflightCutoff.Before(cycleCutoff) {
		t.Fatal("test setup must leave cycle budget after lease commit budget")
	}
	if _, err := runner.RunOnce(context.Background(), runnerActor()); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 0 {
		t.Fatal("request sent after second DNS consumed lease commit budget")
	}
	result := store.transition.DeliveryResult
	if store.transition.RequestedTransition != notificationstore.TransitionRetry || result == nil || result.ResultKind != notificationstore.ResultKindTransportFailure || result.ErrorCode != ErrorCodePreflightTimeout {
		t.Fatalf("transition=%+v", store.transition)
	}
}

func TestRunnerDeadlineBeforeSendIsUncountedPolicyTermination(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}}}
	transport := &fakeHTTPTransport{status: 200}
	runner, store, clock, cutoff := newRunnerFixture(t, start, dns, transport)
	clock.Set(cutoff)
	if _, err := runner.RunOnce(context.Background(), runnerActor()); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 0 || store.transition.DeliveryResult.ResultKind != notificationstore.ResultKindPolicyTermination || store.transition.DeliveryResult.Reason != notificationstore.ReasonDeadlineExceeded {
		t.Fatalf("transition: %+v calls=%d", store.transition, transport.calls)
	}
}

func TestRunnerDeadlineTakesPriorityOverAttemptLimit(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}}}
	transport := &fakeHTTPTransport{status: 200}
	runner, store, clock, cutoff := newRunnerFixture(t, start, dns, transport)
	store.claim.AttemptCount = DefaultMaxAttempts
	clock.Set(cutoff)
	if _, err := runner.RunOnce(context.Background(), runnerActor()); err != nil {
		t.Fatal(err)
	}
	if got := store.transition.DeliveryResult.Reason; got != notificationstore.ReasonDeadlineExceeded {
		t.Fatalf("reason = %q, want deadline priority", got)
	}
}

func TestRunnerSecondDNSFailureRetriesWithoutSending(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{
		answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}},
		errors:  []error{nil, NewTransportError(ErrorCodeDNSFailure)},
	}
	transport := &fakeHTTPTransport{status: 200}
	runner, store, _, _ := newRunnerFixture(t, start, dns, transport)
	if _, err := runner.RunOnce(context.Background(), runnerActor()); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 0 {
		t.Fatal("request sent after DNS recheck failure")
	}
	result := store.transition.DeliveryResult
	if store.transition.RequestedTransition != notificationstore.TransitionRetry || result == nil || result.ResultKind != notificationstore.ResultKindTransportFailure || result.ErrorCode != ErrorCodeDNSFailure {
		t.Fatalf("transition: %+v", store.transition)
	}
}

func TestRunnerRegistryInvalidCommandCommitsThenSignalsHealth(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}}}
	transport := &fakeHTTPTransport{status: 200}
	runner, store, _, _ := newRunnerFixture(t, start, dns, transport)
	runner.vr = snapshotReader{err: vendorregistry.ReadError{Code: vendorregistry.ReadErrInvalidCommand}}
	claimed, err := runner.RunOnce(context.Background(), runnerActor())
	if !claimed {
		t.Fatal("notification was not claimed")
	}
	var signal *HealthSignalError
	if !errors.As(err, &signal) || signal.Code != "registry_invalid_command" {
		t.Fatalf("health signal = %v", err)
	}
	if store.transition.RequestedTransition != notificationstore.TransitionDie || store.transition.DeliveryResult == nil || store.transition.DeliveryResult.Reason != notificationstore.ReasonRequestUnbuildable {
		t.Fatalf("transition: %+v", store.transition)
	}
	if transport.calls != 0 {
		t.Fatal("invalid command reached network")
	}
}

func TestRunnerStoreCommitFailureSignalsHealth(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}, {netip.MustParseAddr("8.8.8.8")}}}
	transport := &fakeHTTPTransport{status: 204}
	runner, store, _, _ := newRunnerFixture(t, start, dns, transport)
	store.transitionErr = errors.New("database unavailable")
	_, err := runner.RunOnce(context.Background(), runnerActor())
	var signal *HealthSignalError
	if !errors.As(err, &signal) || signal.Code != "store_result_commit_failure" {
		t.Fatalf("health signal = %v", err)
	}
}

func TestRunnerAttemptLimitStopsBeforeDependenciesAndNetwork(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}}}
	transport := &fakeHTTPTransport{status: 200}
	runner, store, _, _ := newRunnerFixture(t, start, dns, transport)
	store.claim.AttemptCount = DefaultMaxAttempts
	if _, err := runner.RunOnce(context.Background(), runnerActor()); err != nil {
		t.Fatal(err)
	}
	if dns.calls != 0 || transport.calls != 0 || store.transition.RequestedTransition != notificationstore.TransitionDie || store.transition.DeliveryResult.Reason != notificationstore.ReasonAttemptLimit {
		t.Fatalf("dns=%d http=%d transition=%+v", dns.calls, transport.calls, store.transition)
	}
}

func TestRunnerPreSendPolicyFailuresAreUncountedAndDoNotSend(t *testing.T) {
	start := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	for name, setup := range map[string]struct {
		reason string
		apply  func(*Runner)
	}{
		"vendor unavailable": {notificationstore.ReasonVendorUnavailable, func(r *Runner) {
			r.vr = snapshotReader{err: vendorregistry.ReadError{Code: vendorregistry.ReadErrVendorInactiveOrUnknown}}
		}},
		"credential unavailable": {notificationstore.ReasonCredentialUnavailable, func(r *Runner) {
			r.credentials = fixedCredentialResolver{err: NewPolicyError(ReasonCredentialUnavailable)}
		}},
		"request unbuildable": {notificationstore.ReasonRequestUnbuildable, func(r *Runner) {
			snapshot := validSnapshot()
			snapshot.Method = "GET"
			r.vr = snapshotReader{snapshot: snapshot}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}, {netip.MustParseAddr("8.8.8.8")}}}
			transport := &fakeHTTPTransport{status: 200}
			runner, store, _, _ := newRunnerFixture(t, start, dns, transport)
			setup.apply(runner)
			if _, err := runner.RunOnce(context.Background(), runnerActor()); err != nil {
				t.Fatal(err)
			}
			result := store.transition.DeliveryResult
			if transport.calls != 0 || store.transition.RequestedTransition != notificationstore.TransitionDie || result == nil || result.ResultKind != notificationstore.ResultKindPolicyTermination || result.Reason != setup.reason {
				t.Fatalf("http=%d transition=%+v", transport.calls, store.transition)
			}
		})
	}
}
